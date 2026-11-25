/**
 * Same-origin guard for the HTTP API and the WebSocket.
 *
 * Why this exists: the daemon's trust boundary is the network (loopback +
 * Tailscale peers are trusted without a password). A *browser* punches straight
 * through that boundary — a page on any website, loaded in a browser running on
 * this machine or on any tailnet device, can:
 *
 *   - open `ws://127.0.0.1:8770/ws` (WebSocket is exempt from the same-origin
 *     policy, so no preflight and no CORS to stop it), or
 *   - `fetch()` the JSON API cross-origin and read the reply (the API used to
 *     answer `access-control-allow-origin: *`).
 *
 * Either one lets a drive-by page spawn a `claude` session — i.e. run code on
 * this machine — without ever being on the tailnet. So every `/api/*` request
 * and every socket upgrade is checked here against the origins we actually
 * serve the app on, and the CORS header is reflected only for those.
 *
 * Two headers are checked, because they cover different attacks:
 *
 *   - `Origin` — set by the browser on every WS handshake and every cross-origin
 *     fetch, and unforgeable by page JS. This is the primary check.
 *   - `Host` — closes DNS rebinding, where an attacker-controlled name resolves
 *     to 127.0.0.1 so the page's requests are *same*-origin (and may carry no
 *     `Origin` at all). The name in `Host` is then not one of ours.
 *
 * Being one of ours is not enough for a name the LAN answers for (our own `.local`, an
 * `ALLOWED_HOSTS` alias): whoever controls that answer can serve a page under it. Such a request is
 * let in without the trust of its address (`unverifiedName`).
 *
 * A missing `Origin` is allowed: non-browser clients (curl, the e2e scripts,
 * the launchd health check) never send one, and a browser always does when it
 * matters. A request that a page could forge without `Origin` — a form POST, an
 * `<img>` GET — is still stopped by the `Host` check, and the response of one it
 * cannot read anyway.
 */
import { isIP } from "node:net";
import { hostname } from "node:os";
import { envName } from "@waterplane/shared";
import { env } from "./env.js";

// `npm run dev` serves the PWA here and proxies /api + /ws, so in dev the
// browser's origin is the Vite server, not us. Only trusted when the host was
// actually started by `npm run dev` (which sets WATERPLANE_DEV=1) — a production
// daemon has no reason to trust another server on the machine.
const VITE_DEV_PORT = 5173;

export interface OriginConfig {
  port: number;
  /** The LAN TLS port (`lantls.ts`), when one is planned. A port, not a host: names stay as they are. */
  tlsPort?: number;
  /**
   * The name a browser certificate is served for (`lanca.ts`), on `tlsPort`. NOT one of the hosts:
   * as a host it would count on the plain port too, where whoever answers DNS for it on the LAN can
   * serve a page under it and rebind. It counts only where the handshake itself asked for it
   * (`atBrowserName`), because only there has a browser checked the certificate.
   */
  tlsName?: string | null;
  /** Tailscale IPv4 of this host, if on a tailnet. */
  tailscaleIp?: string | null;
  /** MagicDNS name (`mac.tailnet.ts.net`) — the origin under `tailscale serve`. */
  tailscaleDns?: string | null;
  /** LAN IPs we actually bound (only under WATERPLANE_ALLOW_PUBLIC=1). */
  lanIps?: string[];
  /**
   * The URL `tailscale serve` actually fronts us with, port and all — the same
   * value the client gets as `welcome.httpsUrl` (`net.ts` `serveHttpsUrl`).
   *
   * Trusting it is not a convenience. `tailscale serve --https=443` claims one
   * slot on the whole machine, so a host that already serves something else
   * there ends up fronted on some other port — and this guard only ever trusted
   * the bound port, 80 and 443. The result was an app that ADVERTISES an HTTPS
   * front door (the banner, Settings → Connection) and then 403s every `/api`
   * call made through it, with the WS upgrade closing 1008. Anyone who didn't
   * find `WATERPLANE_ALLOWED_HOSTS` stayed on plain `http://100.x`, which is not a
   * secure context — no service worker, so a dropped tunnel during any
   * navigation replaces the whole app with the browser's error page.
   *
   * This is not a widening: the URL comes from OUR OWN serve config, read off
   * the local tailscaled, and only the listener whose proxy target is our port.
   */
  serveUrl?: string | null;
  /** The ports `tailscale serve` hands to us on, when its config could be read (`net.ts` `serveDoorPorts`). */
  doorPorts?: readonly number[] | null;
}

interface Compiled {
  hosts: Set<string>;
  ports: Set<number>;
  /** Verbatim extra origins from WATERPLANE_ALLOWED_ORIGINS, already normalised. */
  origins: Set<string>;
  /** The plain listener's port: a `Host` naming it was dialed straight, not through a front door. */
  port: number;
  /** Our own full MagicDNS name, whatever its base domain (a self-hosted control server's is not `ts.net`). */
  tailnetName: string | null;
  /** Accept `*.ts.net` by suffix (proxied requests only), because we are on a tailnet but couldn't read our own MagicDNS name. */
  anyMagicDns: boolean;
  /** Ports a `*.ts.net` name may be spelled with on loopback, besides the usual ones; null: never read. */
  doors: ReadonlySet<number> | null;
  /** The browser certificate's name and the one `Host` and one `Origin` a browser sends there. */
  browser: { name: string; host: string; origin: string } | null;
}

let compiled: Compiled = compile({ port: 8770 });

/**
 * The one origin that is not `http(s)` and is still ours: the iOS shell
 * (`packages/app`, Capacitor). WKWebView will not serve an app's own page from
 * `http`/`https`, so its page lives at `capacitor://localhost` — the iOS twin
 * of the Android shell's `http://localhost`. Named exactly: scheme AND host.
 *
 * Every other non-web scheme is refused (`webScheme` below). Before this
 * constant existed the guard judged only host + port, so `capacitor://localhost`
 * passed by accident — and so would `anything://localhost`. A browser never
 * sends a made-up scheme today; naming the one we serve keeps it that way.
 */
const NATIVE_SHELL_ORIGINS = new Set<string>(["capacitor://localhost"]);

/** Origins are judged on host + port only for the web's own two schemes. */
function webScheme(protocol: string): boolean {
  return protocol === "http:" || protocol === "https:";
}

/** Split a `host:port` / origin authority into its parts. Handles `[::1]:80`. */
function splitAuthority(authority: string): { host: string; port: number | null } {
  const a = authority.trim().toLowerCase();
  const v6 = /^\[([^\]]+)\](?::(\d+))?$/.exec(a);
  if (v6) return { host: v6[1], port: v6[2] ? Number(v6[2]) : null };
  const i = a.lastIndexOf(":");
  // A bare IPv6 literal has several colons and no port.
  if (i === -1 || a.indexOf(":") !== i) return { host: a, port: null };
  return { host: a.slice(0, i), port: Number(a.slice(i + 1)) };
}

function normaliseOrigin(raw: string): string | null {
  try {
    const u = new URL(raw.trim());
    const port = u.port ? `:${u.port}` : "";
    return `${u.protocol}//${u.hostname.toLowerCase()}${port}`;
  } catch {
    return null;
  }
}

function compile(cfg: OriginConfig): Compiled {
  const hosts = new Set<string>(["localhost", "127.0.0.1", "::1", "0.0.0.0"]);
  if (cfg.tailscaleIp) hosts.add(cfg.tailscaleIp.toLowerCase());
  if (cfg.tailscaleDns) hosts.add(cfg.tailscaleDns.toLowerCase());
  for (const ip of cfg.lanIps ?? []) hosts.add(ip.toLowerCase());
  // This machine's own mDNS name — `http://mac.local:8770` is a normal way to
  // reach it on the LAN. Named exactly, rather than trusting all of `*.local`. Being in this
  // set lets a request IN; it does not prove the name (`unverifiedName`).
  // Both the full name and its first label: with a DHCP search domain,
  // os.hostname() is `mac.fritz.box` while Bonjour still answers to `mac.local`.
  const self = hostname().toLowerCase().replace(/\.local$/, "");
  for (const n of [self, self.split(".")[0]]) {
    if (n) { hosts.add(n); hosts.add(`${n}.local`); }
  }
  for (const h of splitEnv(env("ALLOWED_HOSTS"))) hosts.add(h.toLowerCase());

  // 80/443 cover a reverse proxy (`tailscale serve --https=443`).
  const ports = new Set<number>([cfg.port, 80, 443]);
  if (cfg.tlsPort) ports.add(cfg.tlsPort);
  if (env("DEV") === "1") ports.add(VITE_DEV_PORT);

  const origins = new Set<string>();
  for (const o of splitEnv(env("ALLOWED_ORIGINS"))) {
    const n = normaliseOrigin(o);
    if (n) origins.add(n);
  }
  // Our own `tailscale serve` front door, whatever port it landed on. See
  // OriginConfig.serveUrl — without this the app points at an HTTPS address it
  // then refuses, and the user stays on the insecure origin where a dropped
  // tunnel can take the whole app away.
  if (cfg.serveUrl) {
    const n = normaliseOrigin(cfg.serveUrl);
    if (n) {
      origins.add(n);
      const u = new URL(n);
      hosts.add(u.hostname.toLowerCase());
      ports.add(u.port ? Number(u.port) : 443);
    }
  }

  let browser: Compiled["browser"] = null;
  if (cfg.tlsName && cfg.tlsPort) {
    const host = cfg.tlsPort === 443 ? cfg.tlsName : `${cfg.tlsName}:${cfg.tlsPort}`;
    browser = { name: cfg.tlsName, host, origin: `https://${host}` };
  }

  return { hosts, ports, origins, browser, doors: cfg.doorPorts ? new Set(cfg.doorPorts) : null, port: cfg.port, tailnetName: cfg.tailscaleDns?.toLowerCase() ?? null, anyMagicDns: !cfg.tailscaleDns && !!cfg.tailscaleIp };
}

function splitEnv(v: string | undefined): string[] {
  return (v || "").split(",").map((s) => s.trim()).filter(Boolean);
}

/** Call once at boot, after the Tailscale IP / DNS name / LAN binds are known. */
export function configureOrigins(cfg: OriginConfig): void {
  compiled = compile(cfg);
}

/** The doors as last read, or null: what a reading that fails leaves standing. */
export function knownFrontDoors(): number[] | null {
  return compiled.doors && [...compiled.doors];
}

/** `tailscale serve`'s ports as just read (`net.ts` `learnFrontDoors`). */
export function noteFrontDoors(ports: readonly number[]): void {
  compiled.doors = new Set(ports);
}

/**
 * Is this hostname one we serve on? Exact matches from the compiled set (which
 * already holds our Tailscale IP, MagicDNS name, LAN IPs and mDNS name), plus
 * any loopback IPv4. `*.ts.net` is accepted by suffix ONLY as a fallback for
 * when we could not read our own MagicDNS name — otherwise the exact name is
 * required, so a name under someone else's tailnet is not automatically trusted.
 */
function hostAllowed(host: string, proxied = false): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!h) return false;
  if (compiled.hosts.has(h)) return true;
  if (/^127\.\d+\.\d+\.\d+$/.test(h)) return true;
  if (proxied && compiled.anyMagicDns && h.endsWith(".ts.net")) return true;
  return false;
}

/** The `Host` header names something we serve (DNS-rebinding check). */
export function hostHeaderAllowed(hostHeader: string | undefined, proxied = false): boolean {
  if (!hostHeader) return true; // HTTP/1.0 or a raw client — no name to rebind
  const { host } = splitAuthority(hostHeader);
  return hostAllowed(host, proxied);
}

/**
 * The `Origin` header, if present, is one of ours. Absent = allowed (non-browser
 * client). `null` (sandboxed iframe, file://) is a real value and is refused.
 */
export function originHeaderAllowed(origin: string | undefined, proxied = false, requestHost?: string): boolean {
  if (origin === undefined) return true;
  const raw = origin.trim();
  if (!raw) return true;
  if (raw === "null") return false;
  const n = normaliseOrigin(raw);
  if (!n) return false;
  if (compiled.origins.has(n)) return true;
  if (NATIVE_SHELL_ORIGINS.has(n)) return true;
  const u = new URL(n);
  if (!webScheme(u.protocol)) return false;
  if (!hostAllowed(u.hostname, false)) {
    // Admitted only by the `*.ts.net` suffix fallback: the Origin must also name
    // the very host this request was sent to, never another tailnet's page.
    if (!hostAllowed(u.hostname, proxied)) return false;
    if (!requestHost || splitAuthority(requestHost).host.replace(/^\[|\]$/g, "").replace(/\.$/, "") !== u.hostname.toLowerCase().replace(/\.$/, "")) return false;
  }
  const port = u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80;
  return compiled.ports.has(port);
}

/**
 * The read-only routes a browser loads OUTSIDE `fetch`/XHR — `<img src>`,
 * `<video src>`, `<a download>`, Background Fetch. Such a request carries **no
 * `Origin`** (a no-cors GET never sends one), and from the Android shell — whose
 * page is `http://localhost` while the daemon is `http://100.x:8770` — it also
 * carries `Sec-Fetch-Site: cross-site`. The backstop below therefore refused
 * every gallery thumbnail and every artifact download in the APK, with the only
 * evidence a 403 in the host log; on screen the download queue simply sat on
 * "waiting to start" for ever.
 *
 * Exempting them is not a hole in the backstop, which exists for *side-effecting*
 * GETs: both are pure reads, and a page that requests one cross-origin still
 * cannot read the answer (no `Origin` ⇒ no CORS header ⇒ the response is opaque).
 * Named exactly — not "any GET" — and only for safe methods, so DELETE on an
 * inbox file stays gated. These are the same two URLs `api.ts` has to build with
 * `abs()` by hand, for the same reason: they never pass through a transport.
 */
const OPAQUE_READ_ROUTES = [
  /^\/api\/repos\/[^/]+\/artifact$/,
  /^\/api\/repos\/[^/]+\/inbox\/[^/]+$/,
];

/** Request info the gate needs beyond headers. Absent ⇒ judged strictly, which
 *  is what the WebSocket upgrade wants. */
export interface RequestInfo {
  path?: string;
  method?: string;
  /** The request carries a proxy header (came through `tailscale serve`). Only
   *  then may the `*.ts.net` suffix fallback apply; a direct loopback caller
   *  naming evil.ts.net is a browser page, not the serve front door. */
  proxied?: boolean;
  /** The SNI of this request's own TLS handshake (`net.ts` `tlsServerName`); null or absent on a plain socket. */
  tlsName?: string | null;
}

/**
 * Whether this request is AT the browser certificate's name: our own TLS socket, whose handshake
 * asked for exactly that name, carrying exactly the `Host` a browser sends for it, with no proxy in
 * between. Compared verbatim, per request: another case, a trailing dot, another port or a second
 * request on the connection under another `Host` is not it, and falls to the rules every other
 * request is judged by, where the name is a stranger's.
 */
function atBrowserName(host: string | undefined, req: RequestInfo | undefined): boolean {
  const b = compiled.browser;
  return b !== null && !req?.proxied && req?.tlsName === b.name && host === b.host;
}

/** Whether the handshake asked for the browser certificate's name: what the login cookie's `Secure` asks. */
export function isBrowserName(tlsName: string | null): boolean {
  return tlsName !== null && tlsName === compiled.browser?.name;
}

/**
 * Whether a present `Origin` is one of ours for THIS request: at the browser certificate's name its
 * own https origin and no other, anywhere else `originHeaderAllowed`, which never knows that name.
 */
export function requestOriginAllowed(headers: { origin?: string | string[]; host?: string | string[] }, req: RequestInfo): boolean {
  const origin = first(headers.origin);
  return atBrowserName(first(headers.host), req) ? origin === compiled.browser!.origin : originHeaderAllowed(origin);
}

function opaqueReadOk(req?: RequestInfo): boolean {
  if (!req?.path) return false;
  const m = (req.method || "").toUpperCase();
  if (m !== "GET" && m !== "HEAD") return false;
  return OPAQUE_READ_ROUTES.some((re) => re.test(req.path!));
}

/** Whether this method + path is one of the opaque read routes (`wt` read tickets are honoured only here). */
export function isOpaqueReadRoute(path: string, method: string): boolean {
  return opaqueReadOk({ path, method });
}

/** A name that always means the caller's own machine, spelled as a browser spells it. */
export function isLoopbackName(h: string): boolean {
  return h === "localhost" || h === "::1" || h === "0.0.0.0" || /^127\.\d+\.\d+\.\d+$/.test(h);
}
/** An address inside Tailscale's 100.64.0.0/10. */
function tailnetLiteral(h: string): boolean {
  const second = isIP(h) === 4 && h.startsWith("100.") ? Number(h.split(".")[1]) : -1;
  return second >= 64 && second <= 127;
}
/** A name the tailnet's resolver answers for. */
function inMagicDns(name: string): boolean {
  return name === compiled.tailnetName || name.endsWith(".ts.net");
}
/**
 * Whether a front door answers on this port of a tailnet name. 443 and 80 (a bare `Host`) always may:
 * they are the usual ones, and what a proxy that drops the port sends. Any other is a port `tailscale
 * serve` hands to us on, or one the operator listed for the name. A hand-made forward
 * (`ssh -L 9000:127.0.0.1:8770`) is neither. With the serve config never read, any port may, as no
 * better is known.
 */
function doorPort(name: string, port: number | null): boolean {
  if (port === null || port === 80 || port === 443 || compiled.doors === null || compiled.doors.has(port)) return true;
  for (const o of compiled.origins) {
    const u = new URL(o);
    if (u.hostname.replace(/\.$/, "") === name && Number(u.port) === port) return true;
  }
  return false;
}

/**
 * A loopback request whose `Host` is a tailnet name on a port no known front door has: the door may be
 * newer than the last reading, so the caller re-reads before judging (`net.ts` `learnFrontDoors`).
 */
export function unknownDoor(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  const { host, port } = splitAuthority(hostHeader);
  const name = host.replace(/\.$/, "");
  if (!inMagicDns(name) || port === null || port === 80 || port === 443 || port === compiled.port) return false;
  return compiled.doors === null || !doorPort(name, port);
}
/** `host:port` as one comparable string: lower case, no brackets, port 80 spelled. */
function authorityKey(authority: string): string {
  const { host, port } = splitAuthority(authority);
  return `${host} ${port ?? 80}`;
}

/**
 * Whether anybody but the local network vouches for the name in this `Host`. The caller is a loopback
 * or tailnet socket, and the question is whether a web page could be sitting under the name: whoever
 * answers DNS or mDNS on the network serves a page there, then points the name at us, and the browser
 * calls that same-origin. An address cannot be pointed elsewhere; `localhost` is never asked of DNS; a
 * tailnet name is answered by the tailnet's own resolver; anything else needs a certificate.
 */
function hostNameProven(hostHeader: string, from: "loopback" | "tailscale"): boolean {
  return hostProof(hostHeader, from) !== null;
}

/**
 * What vouches for the name in this `Host`: the address itself, the tailnet's resolver, or only a
 * certificate the operator listed. The last proves the name for https alone: a plain-http page of the
 * same name never met that certificate (`originProven`).
 */
function hostProof(hostHeader: string, from: "loopback" | "tailscale"): "address" | "tailnet" | "certificate" | null {
  const { host, port } = splitAuthority(hostHeader);
  if (isLoopbackName(host) || isIP(host) !== 0) return "address";
  const name = host.replace(/\.$/, "");
  // The port a browser puts in `Host` is the port it dialed. Ours means it came straight to the plain
  // listener; a front door (`tailscale serve`, a proxy) has its own. The proxy headers cannot say
  // this: a rebound page is same-origin and sends any of them.
  const direct = (port ?? 80) === compiled.port;
  // From the tailnet, the exact names only (the `*.ts.net` fallback is for what `serve` hands over,
  // which is loopback). From loopback, only through a front door: with Tailscale off the LAN answers
  // for the name, and with it on no browser here reaches loopback under it.
  if (inMagicDns(name)) return (from === "tailscale" ? compiled.hosts.has(name) : !direct && doorPort(name, port)) ? "tailnet" : null;
  // The operator says a certificate stands behind a name by listing its https origin.
  if (direct) return null;
  // A proxy on a port of its own that forwards `Host` without it (nginx `$host`) leaves the port
  // unsaid: any https port listed for the name is then the one.
  if (port === null) {
    for (const o of compiled.origins) {
      const u = new URL(o);
      if (u.protocol === "https:" && u.hostname === name) return "certificate";
    }
    return null;
  }
  const listed = normaliseOrigin(`https://${name}:${port}`);
  return listed !== null && compiled.origins.has(listed) ? "certificate" : null;
}

/** The same question about a present `Origin`: could this page be somebody else's. */
function originProven(raw: string, hostHeader: string | undefined, from: "loopback" | "tailscale", proxied: boolean): boolean {
  const n = normaliseOrigin(raw);
  if (!n) return false;
  if (NATIVE_SHELL_ORIGINS.has(n)) return true;
  const u = new URL(n);
  if (!webScheme(u.protocol)) return false;
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (isLoopbackName(host)) return true;
  const name = host.replace(/\.$/, "");
  const tailnetName = inMagicDns(name) && compiled.hosts.has(name);
  if (u.protocol === "https:") return compiled.origins.has(n) || tailnetName || (compiled.anyMagicDns && name.endsWith(".ts.net"));
  // Plain http: a page of the very name or address this request was sent to is as good as that is.
  // Not when only a listed https origin proved that name: the proxy answers https on its port, and the
  // page that sent this Origin is plain http, served by whoever answers for the name.
  if (hostHeader && authorityKey(u.host) === authorityKey(hostHeader)) {
    const proof = hostProof(hostHeader, from);
    return proof !== null && proof !== "certificate";
  }
  // From another tailnet address to this one, the tailnet carried the page. To loopback it may not
  // have (Tailscale off, and the LAN answers for the address); there only vite's own proxy is let by,
  // which rewrites `Host` and so cannot look same-origin, and which says it is a proxy: no page can
  // add that header cross-origin, or any header to a WebSocket.
  if (!tailnetLiteral(host) && !tailnetName) return false;
  return from === "tailscale" || (env("DEV") === "1" && proxied && Number(u.port) === VITE_DEV_PORT);
}

/**
 * The name this request came under that only the local network vouches for, or null when there is
 * none. Asked by `net.ts` `requestPeerKind`, for loopback and tailnet sockets: such a request keeps
 * every route it had, without the trust of its address, so it needs a token like a Wi-Fi client's.
 *
 * Judged per request (a kept-alive socket may carry the next one under another `Host`) and on BOTH
 * headers: rebinding shows in `Host`, while a page under our `.local` name that calls 127.0.0.1
 * outright, with no rebinding at all, shows only in `Origin`.
 */
export function unverifiedName(headers: Readonly<Record<string, string | string[] | undefined>>, from: "loopback" | "tailscale"): string | null {
  const host = first(headers.host)?.trim();
  if (host && !hostNameProven(host, from)) return host;
  const origin = first(headers.origin)?.trim();
  if (origin && !originProven(origin, host, from, headers["x-forwarded-for"] !== undefined)) return origin;
  return null;
}

/** The `ALLOWED_HOSTS` names that get no trust of their own: no https origin of theirs is listed. The doctor's row. */
export function aliasesWithoutCertificate(): string[] {
  const listed = splitEnv(env("ALLOWED_ORIGINS")).map(normaliseOrigin).filter((o): o is string => !!o && o.startsWith("https:")).map((o) => new URL(o).hostname);
  return splitEnv(env("ALLOWED_HOSTS")).map((h) => h.toLowerCase().replace(/\.$/, ""))
    .filter((h) => !isLoopbackName(h) && isIP(h) === 0 && !h.endsWith(".ts.net") && !listed.includes(h));
}

export interface OriginVerdict {
  ok: boolean;
  /** Populated when `ok` is false — safe to log and to return to the caller. */
  reason?: string;
  /** What to do about it, when that is not the general "set the knob" advice. */
  hint?: string;
}

/** The end of a refusal's log line. */
export function originHint(v: OriginVerdict): string {
  return v.hint ?? `If this is your own hostname, set ${envName("ALLOWED_HOSTS")} (without an https origin for it in ${envName("ALLOWED_ORIGINS")} it needs the password or a device token).`;
}

/**
 * Check every header at once. Used by the `/api/*` gate and the WS upgrade.
 *
 * `Sec-Fetch-Site` is the backstop for the one gap `Origin` leaves: a
 * cross-origin **GET** (an `<img src>` or `<script src>` on a malicious page)
 * carries no `Origin`, so a side-effecting GET would sail through. Browsers
 * send this metadata header on every request and page JS cannot set it;
 * non-browser clients don't send it at all, so requiring nothing when it's
 * absent keeps curl and the e2e scripts working.
 *
 * `req` (path + method) is optional and only ever *widens* the verdict, for the
 * `OPAQUE_READ_ROUTES` above. Callers that pass nothing — the WS upgrade — are
 * judged strictly.
 *
 * At the browser certificate's name (`atBrowserName`) the answer is whole and narrower: its own
 * origin, or none on a request the browser itself calls same-origin. The opaque read routes get no
 * exemption there; it exists for the APK, which dials an address.
 */
/** The request path every gate judges, or null when the raw path is not
 *  already canonical. The gates in `server/http.ts` read the RAW path while
 *  the router (`api.ts`) dispatches on WHATWG's normalised pathname, so a path
 *  the two read differently — `/api/peer/../repos/x`, `%2e%2e`, a backslash —
 *  would be judged as one route (the token-exempt `/api/peer/*`) and served as
 *  another. Nothing legitimate sends such a path; it is refused, never
 *  rewritten, so there is one string from the first gate to the handler. */
export function canonicalRequestPath(rawUrl: string | undefined): string | null {
  const raw = (rawUrl || "/").split("?")[0].split("#")[0];
  let norm: string;
  try { norm = new URL(rawUrl || "/", "http://localhost").pathname; } catch { return null; }
  return norm === raw ? raw : null;
}

export function checkRequestOrigin(headers: {
  origin?: string | string[];
  host?: string | string[];
  "sec-fetch-site"?: string | string[];
}, req?: RequestInfo): OriginVerdict {
  const origin = first(headers.origin);
  const host = first(headers.host);
  const site = first(headers["sec-fetch-site"]);
  if (atBrowserName(host, req)) {
    const ok = origin === undefined ? !site || site === "same-origin" || site === "none" : origin === compiled.browser!.origin;
    return ok ? { ok: true } : { ok: false, reason: origin === undefined ? `sec-fetch-site ${site} with no origin` : `origin ${origin} not allowed`, hint: "" };
  }
  // Only consulted when there is no Origin to judge — that is the whole gap it
  // covers. Applying it unconditionally would also veto an origin the operator
  // deliberately put in WATERPLANE_ALLOWED_ORIGINS, which is the one case where a
  // genuine cross-origin call is supposed to work.
  if (origin === undefined && site && site !== "same-origin" && site !== "none" && !opaqueReadOk(req)) {
    return { ok: false, reason: `sec-fetch-site ${site} with no origin` };
  }
  if (!originHeaderAllowed(origin, req?.proxied, host)) return { ok: false, reason: `origin ${origin} not allowed`, hint: browserNameHint(host) };
  if (!hostHeaderAllowed(host, req?.proxied)) return { ok: false, reason: `host ${host} not allowed`, hint: browserNameHint(host) };
  return { ok: true };
}

/** The general advice, followed for this name, would trust it on the plain port: the one thing not to do. */
function browserNameHint(host: string | undefined): string | undefined {
  const b = compiled.browser;
  return b && host !== undefined && splitAuthority(host).host.replace(/\.$/, "") === b.name ? `Open it as ${b.origin}; leave ${envName("ALLOWED_HOSTS")} alone.` : undefined;
}

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/**
 * CORS headers for a response. Reflects the caller's origin when it passed the
 * gate (so it is always one of ours) and emits nothing otherwise — replacing the
 * blanket `access-control-allow-origin: *` that let any page read the API.
 */
export function corsHeaders(headers: { origin?: string | string[] }): Record<string, string> {
  const origin = first(headers.origin);
  if (!origin || !originHeaderAllowed(origin)) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-credentials": "true",
    // Cross-origin JS can read only a handful of response headers unless they
    // are named here. All four are load-bearing for the Android shell, which is
    // the one client that is genuinely cross-origin: `pull.ts` resumes a
    // download from `content-range` + `accept-ranges` and revalidates it with
    // the `etag` it stored, and without them a dropped 90 MB APK restarts from
    // zero every time instead of continuing.
    "access-control-expose-headers": "ETag,Content-Range,Accept-Ranges,Content-Length",
    // Resource Timing reports a cross-origin response as zero bytes unless the
    // server opts in — and in the Android shell EVERY image is cross-origin, so
    // without this the phone's own data-usage readout (`web/nettraffic.ts`)
    // silently under-counts the gallery, which is most of what it downloads.
    // The reflected origin, never `*`: the same caller that already passed the
    // gate, and nobody else.
    "timing-allow-origin": origin,
    vary: "origin",
  };
}

