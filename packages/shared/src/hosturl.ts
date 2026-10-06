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
  return `${base.replace(/\/+$/, "")}${url}`;
}

/**
 * The WebSocket URL for a base. `ws` is the one thing a fetch shim cannot cover
 * (a WebSocket handshake does not go through `fetch`), so `web/ws.ts` calls this
 * directly.
 */
export function wsUrlFor(base: string | null | undefined, path = "/ws"): string | null {
  if (!base) return null;
  const b = base.replace(/\/+$/, "");
  if (b.startsWith("https://")) return `wss://${b.slice("https://".length)}${path}`;
  if (b.startsWith("http://")) return `ws://${b.slice("http://".length)}${path}`;
  return null;
}
