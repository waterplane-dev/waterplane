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
 * A missing `Origin` is allowed: non-browser clients (curl, the e2e scripts,
 * the launchd health check) never send one, and a browser always does when it
 * matters. A request that a page could forge without `Origin` — a form POST, an
 * `<img>` GET — is still stopped by the `Host` check, and the response of one it
 * cannot read anyway.
 */
import { hostname } from "node:os";
import { env } from "./env.js";

// `npm run dev` serves the PWA here and proxies /api + /ws, so in dev the
// browser's origin is the Vite server, not us. Only trusted when the host was
// actually started by `npm run dev` (which sets WATERPLANE_DEV=1) — a production
// daemon has no reason to trust another server on the machine.
const VITE_DEV_PORT = 5173;

export interface OriginConfig {
  port: number;
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
}

interface Compiled {
  hosts: Set<string>;
  ports: Set<number>;
  /** Verbatim extra origins from WATERPLANE_ALLOWED_ORIGINS, already normalised. */
  origins: Set<string>;
  /** Accept any `*.ts.net`, because we couldn't learn our own MagicDNS name. */
  anyMagicDns: boolean;
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
  // reach it on the LAN. Named exactly, rather than trusting all of `*.local`.
  // Both the full name and its first label: with a DHCP search domain,
  // os.hostname() is `mac.fritz.box` while Bonjour still answers to `mac.local`.
  const self = hostname().toLowerCase().replace(/\.local$/, "");
  for (const n of [self, self.split(".")[0]]) {
    if (n) { hosts.add(n); hosts.add(`${n}.local`); }
  }
  for (const h of splitEnv(env("ALLOWED_HOSTS"))) hosts.add(h.toLowerCase());

  // 80/443 cover a reverse proxy (`tailscale serve --https=443`).
  const ports = new Set<number>([cfg.port, 80, 443]);
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

  return { hosts, ports, origins, anyMagicDns: !cfg.tailscaleDns };
}

function splitEnv(v: string | undefined): string[] {
  return (v || "").split(",").map((s) => s.trim()).filter(Boolean);
}

/** Call once at boot, after the Tailscale IP / DNS name / LAN binds are known. */
export function configureOrigins(cfg: OriginConfig): void {
  compiled = compile(cfg);
}

/**
 * Is this hostname one we serve on? Exact matches from the compiled set (which
 * already holds our Tailscale IP, MagicDNS name, LAN IPs and mDNS name), plus
 * any loopback IPv4. `*.ts.net` is accepted by suffix ONLY as a fallback for
 * when we could not read our own MagicDNS name — otherwise the exact name is
 * required, so a name under someone else's tailnet is not automatically trusted.
 */
function hostAllowed(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!h) return false;
  if (compiled.hosts.has(h)) return true;
  if (/^127\.\d+\.\d+\.\d+$/.test(h)) return true;
  if (compiled.anyMagicDns && h.endsWith(".ts.net")) return true;
  return false;
}

/** The `Host` header names something we serve (DNS-rebinding check). */
export function hostHeaderAllowed(hostHeader: string | undefined): boolean {
  if (!hostHeader) return true; // HTTP/1.0 or a raw client — no name to rebind
  const { host } = splitAuthority(hostHeader);
  return hostAllowed(host);
}

/**
 * The `Origin` header, if present, is one of ours. Absent = allowed (non-browser
 * client). `null` (sandboxed iframe, file://) is a real value and is refused.
 */
export function originHeaderAllowed(origin: string | undefined): boolean {
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
  if (!hostAllowed(u.hostname)) return false;
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
}

function opaqueReadOk(req?: RequestInfo): boolean {
  if (!req?.path) return false;
  const m = (req.method || "").toUpperCase();
  if (m !== "GET" && m !== "HEAD") return false;
  return OPAQUE_READ_ROUTES.some((re) => re.test(req.path!));
}

export interface OriginVerdict {
  ok: boolean;
  /** Populated when `ok` is false — safe to log and to return to the caller. */
  reason?: string;
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
  // Only consulted when there is no Origin to judge — that is the whole gap it
  // covers. Applying it unconditionally would also veto an origin the operator
  // deliberately put in WATERPLANE_ALLOWED_ORIGINS, which is the one case where a
  // genuine cross-origin call is supposed to work.
  if (origin === undefined && site && site !== "same-origin" && site !== "none" && !opaqueReadOk(req)) {
    return { ok: false, reason: `sec-fetch-site ${site} with no origin` };
  }
  if (!originHeaderAllowed(origin)) return { ok: false, reason: `origin ${origin} not allowed` };
  if (!hostHeaderAllowed(host)) return { ok: false, reason: `host ${host} not allowed` };
  return { ok: true };
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

