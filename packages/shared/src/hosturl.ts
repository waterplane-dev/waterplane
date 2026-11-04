/**
 * Where "the host" is, when the app is not being served BY the host.
 *
 * In the browser the PWA is served by the daemon itself, so every `/api/...`
 * and `/ws` is same-origin and there is nothing to resolve — that is why the
 * whole web client is written with root-relative URLs and why it must stay that
 * way (the service worker, the CORS guard in `host/origin.ts` and the auth
 * cookie all assume one origin).
 *
 * In the **Android app** (`packages/app`, a Capacitor shell) the app shell is
 * loaded out of the APK at `http://localhost`, precisely so that a dead tunnel
 * can no longer take the whole UI away — there is no navigation left that can
 * land on the browser's error page. The cost of that is that the page origin is
 * no longer the daemon: the same root-relative URLs now point at the APK's own
 * asset server. This module is the one place that knows how to aim them at the
 * real host instead.
 *
 * It lives in `shared` rather than in `web` for the same reason `queue.ts` does:
 * `shared/dist` is node-runnable, so the rules below are pinned by an e2e script
 * instead of by a comment. They are security-relevant — a base address typed in
 * by a human on a phone keyboard ends up as the target of every API call the app
 * makes, and a rewrite that is too eager can point a request somewhere the user
 * never named.
 */
import { trimEndChars } from "./lineartrim.js";

/**
 * The only path prefixes that are ever re-aimed at the host.
 *
 * Deliberately a short allowlist rather than "everything root-relative". The
 * whole point of the native shell is that `/`, `/assets/*`, `/sw.js`, icons and
 * every other shell asset are served from the APK and keep working with no
 * network at all; rewriting them onto the host would put the app straight back
 * into the failure it exists to fix. `/api` and `/ws` are the only two things
 * that genuinely cannot be answered locally.
 */
export const HOST_PATH_PREFIXES = ["/api", "/ws"] as const;

/** Default daemon port — matches `WATERPLANE_PORT`'s default in the host. */
export const DEFAULT_HOST_PORT = 8770;

/** Why the phone warns on a plain route, in the one wording every screen uses. True of plain HTTP
 *  and of an `https` address nothing vouches for: a relay's certificate is valid for its own name. */
export const PLAIN_ROUTE_WARNING =
  "Not protected: nothing proves this address is your desktop, so someone on this network could read what you send and could take over your desktop. Use it only on a network you trust, or reach the desktop over the tailnet.";
/** The receipt when the app moves onto such a route by itself. */
export const PLAIN_ROUTE_TOAST = "This Wi-Fi route is not protected: fingerprint approvals and app updates are off until you are back on the tailnet.";
/** Why a fingerprint step is refused there, and what to do about it. */
export const PLAIN_ROUTE_NO_FINGERPRINT =
  "Fingerprint approvals are off on this route: nothing proves it reaches your desktop, so someone on this network could fake what you approve. Reach the desktop over the tailnet (Network health › change LAN settings), then approve.";
/** Why an app update waits there. It resumes by itself on the next connect over a protected route. */
export const PLAIN_ROUTE_NO_UPDATE =
  "App updates wait for the tailnet: nothing proves this route reaches your desktop, so someone on this network could swap the update.";
/** Why an APK is neither fetched nor installed there, and what to do about it. */
export const PLAIN_ROUTE_NO_APK =
  "Apps do not download or install on this route: nothing proves it reaches your desktop, so someone on this network could swap the app. Reach the desktop over the tailnet, then try again.";
/** Why the text reader's files are not fetched there. */
export const PLAIN_ROUTE_NO_ASSETS =
  "The reader's files do not download on this route: nothing proves it reaches your desktop, so someone on this network could swap them. Reach the desktop over the tailnet, then try again.";

/** What the phone knows about a route that the address cannot say. */
export interface RouteContext {
  /** A pinned TLS base on a shell that enforces the pin, or an `https` base the person typed. Read
   *  only for `https`: nothing makes plain HTTP protected. */
  trusted?: boolean;
  /** `false`: the shell reports no tailnet under this network, so a tailnet name proves nothing and
   *  the address may be whoever runs the Wi-Fi. Absent is a shell that does not say: today's answer. */
  tailnet?: boolean;
}

/** A desktop's LAN TLS listener, as a pairing or a protected welcome stated it. */
export interface HostTls {
  port: number;
  /** Lowercase hex SHA-256 of the leaf's SPKI DER. */
  spki: string;
}

function isLoopbackName(h: string): boolean {
  return h === "localhost" || h.endsWith(".localhost") || h === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

function isTailnetAddress(h: string): boolean {
  if (h.startsWith("fd7a:115c:a1e0:")) return true;
  const m = /^100\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(h);
  return !!m && Number(m[1]) >= 64 && Number(m[1]) <= 127;
}

/**
 * Is this route UNPROTECTED? `https:` alone proves nothing: a relay with a public certificate for
 * its own name passes validation. **Protected** is exactly one of: loopback; a Tailscale address
 * (100.64.0.0/10, fd7a:115c:a1e0::/48) or MagicDNS name over `http`, or `https` to a `*.ts.net`
 * name, unless `ctx.tailnet === false`; an `https` base `ctx.trusted` speaks for. Everything else is
 * plain whatever its scheme, and so is a base that does not parse: the question is asked before
 * trusting a route, so the unknown answer is the cautious one. `null` is no route at all.
 *
 * The native half is `ShellRoute.java`; `shared/test/hosturl.test.mjs` runs its table here too.
 */
export function isPlainRoute(base: string | null | undefined, ctx: RouteContext = {}): boolean {
  if (!base) return false;
  let u: URL;
  try { u = new URL(base); } catch { return true; }
  const tls = u.protocol === "https:" || u.protocol === "wss:";
  if (!tls && u.protocol !== "http:" && u.protocol !== "ws:") return true;
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (isLoopbackName(h) || (tls && ctx.trusted)) return false;
  if (ctx.tailnet === false) return true;
  return !(h.endsWith(".ts.net") || (!tls && isTailnetAddress(h)));
}

/**
 * A row whose own address is `https` to a name of its own: a vouched proxy. A LAN TLS pin never
 * belongs on one, however it is learned: the pin would apply on that address too
 * (`ShellRoute.pinApplies`), and the background services would refuse a proxy answering correctly
 * with its CA-valid leaf.
 */
export function isProxyBase(base: string): boolean {
  return base.startsWith("https:") && isPlainRoute(base);
}

/** Is this address protected only by the tailnet, so that with Tailscale off nothing reaches it? */
export function needsTunnel(base: string): boolean {
  return !isPlainRoute(base) && isPlainRoute(base, { tailnet: false });
}

/**
 * The TLS address of a plain LAN base: `https://<same host>:<port>`. A base that is not `http:` and
 * plain by name comes back as it went in: the listener is only on LAN interfaces, so a tailnet or
 * loopback base rewritten here would be a dead address, and an `https` base already says where it
 * goes. Whether to ask at all (a shell that enforces the pin, a row not `tlsOff`) is `hostUrl.ts`'s.
 */
export function tlsBaseOf(plainBase: string, tls: Pick<HostTls, "port"> | null | undefined): string {
  if (!tls || !Number.isInteger(tls.port) || tls.port < 1 || tls.port > 65535) return plainBase;
  let u: URL;
  try { u = new URL(plainBase); } catch { return plainBase; }
  if (u.protocol !== "http:" || !isPlainRoute(plainBase)) return plainBase;
  return normalizeHostBase(`https://${u.hostname}:${tls.port}`) ?? plainBase;
}

/**
 * Turn whatever a human typed into a canonical `scheme://host[:port]` base, or
 * `null` if it cannot be one.
 *
 * Accepts the forms someone actually types on a phone: a bare Tailscale IP
 * (`100.64.0.5`), an IP with a port, a MagicDNS name, or a full URL. A bare
 * host gets `http://` and the daemon's default port, because that is the
 * address the daemon prints at boot; an explicitly `https` URL keeps its own
 * (implicit 443) port, since that form is the `tailscale serve` front door and
 * appending 8770 to it would aim at a port nothing listens on.
 *
 * Everything after the authority is dropped — a base is an origin, and letting a
 * path survive would silently prefix every API call with it.
 *
 * The scheme allowlist is the security-relevant part: this string is fed to
 * `fetch`, and without it `javascript:` / `data:` typed (or pasted) into the
 * setup field would become the base of every request the app makes.
 */
export function normalizeHostBase(raw: string): string | null {
  const s = (raw || "").trim();
  if (!s) return null;
  // No scheme? Assume the daemon's own plain-HTTP address. `//host` is treated
  // the same way rather than as protocol-relative: there is no page protocol to
  // inherit that would mean anything here.
  const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(s)
    ? s
    : `http://${s.replace(/^\/+/, "")}`;
  let u: URL;
  try {
    u = new URL(withScheme);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (!u.hostname) return null;
  // `URL.hostname` STRIPS the brackets off an IPv6 literal, so they have to go
  // back on: `http://fd7a::1:8770` re-parses with `:1:8770` as garbage, and a
  // Tailscale address can perfectly well be IPv6.
  const bare = u.hostname.toLowerCase();
  const host = bare.includes(":") ? `[${bare.replace(/^\[|\]$/g, "")}]` : bare;
  // One rule, so the field is predictable: over plain HTTP a missing port means
  // the daemon's own port (nothing of ours listens on 80 — a reverse proxy there
  // is the exception, and its operator can type `:80`). Over HTTPS a missing
  // port means 443 and is left implicit, because that form is the
  // `tailscale serve` front door.
  const port = u.port || (u.protocol === "http:" ? String(DEFAULT_HOST_PORT) : "");
  return `${u.protocol}//${host}${port ? `:${port}` : ""}`;
}

/** Does this URL name something only the daemon can answer? */
export function isHostPath(url: string): boolean {
  // Path-absolute only. A protocol-relative `//evil.example/api` is an ABSOLUTE
  // url that happens to start with a slash; treating it as a path would splice
  // the attacker's authority in behind ours.
  if (!url.startsWith("/") || url.startsWith("//")) return false;
  return HOST_PATH_PREFIXES.some((p) => url === p || url.startsWith(`${p}/`) || url.startsWith(`${p}?`));
}

/**
 * Aim a root-relative app URL at `base`. Anything else is returned untouched —
 * absolute URLs (the app already built them), relative ones (ambiguous, and no
 * call site produces them), and every shell path that must stay local.
 *
 * `base` may be empty, which is the browser case: nothing is rewritten and the
 * client behaves exactly as it did before this module existed.
 */
export function resolveHostUrl(base: string | null | undefined, url: string): string {
  if (!base) return url;
  if (!isHostPath(url)) return url;
  return `${trimEndChars(base, "/")}${url}`;
}

/**
 * The WebSocket URL for a base. `ws` is the one thing a fetch shim cannot cover
 * (a WebSocket handshake does not go through `fetch`), so `web/ws.ts` calls this
 * directly.
 */
export function wsUrlFor(base: string | null | undefined, path = "/ws"): string | null {
  if (!base) return null;
  const b = trimEndChars(base, "/");
  if (b.startsWith("https://")) return `wss://${b.slice("https://".length)}${path}`;
  if (b.startsWith("http://")) return `ws://${b.slice("http://".length)}${path}`;
  return null;
}
