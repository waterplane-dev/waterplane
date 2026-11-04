/**
 * Runtime half of "where is the host" — see `shared/src/hosturl.ts` for the
 * rules and why they live in `shared`.
 *
 * In a browser this module is inert: `hostBase()` is null, `abs()` returns its
 * argument, nothing is patched, and every request stays same-origin exactly as
 * before. It only wakes up inside the **Android shell** (`packages/app`), where
 * the UI is loaded out of the APK at `http://localhost` and the daemon is a
 * different origin.
 *
 * Two deliberate choices:
 *
 * 1. **Capacitor is detected off the global it injects, not imported.** Adding
 *    `@capacitor/core` to `packages/web` would put a native-shell dependency in
 *    the bundle every browser downloads, for a single boolean. `packages/web`
 *    stays dependency-identical to what it was.
 *
 * 2. **`fetch` / `XMLHttpRequest` / `sendBeacon` are patched, not every call
 *    site.** The client has ~60 root-relative URLs across a dozen files and new
 *    ones get added constantly; a rule that only holds where someone remembered
 *    to call a helper is a rule that breaks silently in the APK weeks later.
 *    Patching the three transports means a new `fetch("/api/…")` is correct the
 *    day it is written. The only URLs that still need `abs()` by hand are the
 *    ones that never pass through a transport: strings handed to `<img src>`
 *    and to Background Fetch.
 */
import { isPlainRoute, normalizeHostBase, parseHostList, resolveHostUrl, tlsBaseOf, wsUrlFor, type NetState, type RouteContext, type SavedHost } from "@waterplane/shared";
import { LS, lsGet } from "./storage.ts";
import { currentNet, hasShellNet, onShellNet } from "./shellNet.ts";
import { hasShellTls } from "./sdk/shellTls.ts";
import { bearerFor, deviceToken, noteBearerRejected } from "./deviceToken.ts";
import { DEMO_WS_URL, isDemo } from "./demo/mode.ts";
import { demoMediaUrl } from "./demo/media.ts";

const KEY = LS.hostBase;

/**
 * Running inside the native shell? Capacitor injects this global before any app
 * code runs. Anything else — a desktop browser, the phone PWA — is false, and
 * this whole module no-ops.
 */
export function isNativeShell(): boolean {
  const cap = (globalThis as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
  try {
    return !!cap?.isNativePlatform?.();
  } catch {
    return false;
  }
}

let cached: string | null | undefined;
/** The route override (`setRouteBase`): the same host reached another way. */
let route: string | null = null;

/** The fields a dial decides on. */
type RouteRow = Pick<SavedHost, "base" | "lan" | "tls" | "tlsOff" | "vouched">;

/**
 * The address to dial for one of a row's plain addresses (`base`, or `lan.base`): the TLS address
 * where this shell can enforce the pin the row holds, else that address as saved. `tlsBaseOf` leaves
 * a tailnet, loopback or `https` address alone. So a pinned desktop is never dialled plain on a LAN
 * address, and a shipped APK (no `ShellTls`) that learned a pin simply ignores it.
 */
export function dialBaseOf(row: RouteRow, enforcing: boolean, base: string = row.base): string {
  return enforcing && !row.tlsOff ? tlsBaseOf(base, row.tls) : base;
}

/** What a row and the phone can say about `base` that the address cannot (`isPlainRoute`). */
export function routeContext(base: string, row: RouteRow | null, enforcing: boolean, net: Pick<NetState, "tailnet"> | null): RouteContext {
  const ctx: RouteContext = {};
  if (net?.tailnet !== undefined) ctx.tailnet = net.tailnet;
  if (!row) return ctx;
  const pinned = enforcing && !!row.tls && !row.tlsOff &&
    [row.base, row.lan?.base].some((b) => !!b && b !== base && tlsBaseOf(b, row.tls) === base);
  if (pinned || (row.vouched && row.base === base)) ctx.trusted = true;
  return ctx;
}

/**
 * Does the device token stay on the phone for a dial to `base`? Only on a shell that enforces pins,
 * and then in two cases. A tailnet address with Tailscale off, pinned or not, `tlsOff` or not: that
 * dial cannot reach the desktop, only whoever runs the Wi-Fi, so holding the token loses nothing. And
 * any address that reads plain now on a row holding a pin it may use: a pinned desktop has a protected
 * way in. A plain LAN address on an unpinned row keeps sending it: that is the opt-in, with its
 * warning. A `tailnet` nobody reported leaves the address's name to decide, so a tailnet phone is
 * unchanged.
 */
export function tokenWithheldOf(base: string | null, row: RouteRow | null, enforcing: boolean, net: Pick<NetState, "tailnet"> | null): boolean {
  if (!base || !enforcing) return false;
  const plain = isPlainRoute(base, routeContext(base, row, enforcing, net));
  if (plain && net?.tailnet === false && !isPlainRoute(base)) return true;
  return plain && !!row?.tls && !row.tlsOff;
}

/** Would reaching this row on its address (or `base`, one of its addresses) be unprotected, whatever
 *  network the phone is on now? For a saved row, a screen about a desktop that may not be active. */
export function savedRowPlain(row: RouteRow, enforcing: boolean, base: string = row.base): boolean {
  const dial = dialBaseOf(row, enforcing, base);
  return isPlainRoute(dial, routeContext(dial, row, enforcing, null));
}

/**
 * The address of the host the LIST names active (`hosts` + `hostActive`),
 * else the stored `hostBase` (no list yet: first run, an older build). Read off
 * the list first because the header and the switch key name the host from the
 * list: if `hostBase` lagged — a boot that threw before writing it — the page
 * ran on the old desktop under the new desktop's name (2026-11-01).
 */
export function pickSavedBase(hostsRaw: string | null, activeId: string | null, hostBaseRaw: string | null, enforcing = false): string | null {
  const row = activeId ? parseHostList(hostsRaw)?.find((h) => h.id === activeId) : undefined;
  return (row && dialBaseOf(row, enforcing)) || normalizeHostBase(hostBaseRaw || "");
}

/** The SAVED route of the active host: its address as stored, or the TLS address `dialBaseOf` gives. */
export function savedHostBase(): string | null {
  if (cached !== undefined) return cached;
  cached = null;
  if (isNativeShell()) {
    cached = pickSavedBase(lsGet(LS.hosts), lsGet(LS.hostActive), lsGet(KEY), hasShellTls());
  }
  return cached;
}

/** The active row's `tls` or `tlsOff` changed: the next `savedHostBase()` reads it again. A change of
 *  address reloads the page instead (`hosts.ts`). The socket is the caller's to redial. */
export function invalidateSavedHostBase(): void {
  cached = undefined;
}

/** Is the saved route the TLS address of a pin, rather than the row's own address? That is a phone
 *  with no tailnet route to this desktop: a tailnet base is never rewritten. */
export function savedBasePinned(): boolean {
  const saved = savedHostBase();
  const row = saved ? activeRow() : null;
  return !!row && row.base !== saved;
}

/**
 * The daemon's origin, or null when the page IS the daemon (browser) or no host
 * has been paired yet (first run in the APK).
 *
 * The route override wins when one is set: the same host on its LAN address.
 * **Read per call, never closed over** — every transport patch below asks
 * this on each request, so re-pointing the route re-points them with no reload.
 */
export function hostBase(): string | null {
  const saved = savedHostBase();
  return saved === null ? null : route ?? saved;
}

/**
 * Re-point every request at another address of the SAME host (`null` = back to
 * the saved one). No reload: the transports read `hostBase()` per call. The
 * socket is the caller's to redial. Inert in the browser and before a host is
 * saved — there is nothing to re-point. Returns the route now in force.
 */
export function setRouteBase(url: string | null): string | null {
  if (!isNativeShell() || savedHostBase() === null) { route = null; return null; }
  const next = url === null ? null : normalizeHostBase(url);
  route = next && next !== savedHostBase() ? next : null;
  return hostBase();
}

/** The route override in force, or null on the saved address. */
export function routeBase(): string | null {
  return route;
}

/** What the shell last said about the network; null until it has, and on a shell with no plugin. */
let routeNet: NetState | null = null;
let netHeard = false;
/** A shell that never answers must not hold the first paint. */
const NET_SEED_MS = 500;
/** How long a shell that can say `tailnet` is waited for, after which it is one that does not say. */
const NET_OWED_MS = 8000;
/** The first reading is on its way: a shell that can report has not, and its time is not up. */
let netOwed = false;
const netWaiters: (() => void)[] = [];
/** What "no reading yet" reads as, for the token alone (`tokenWithheld`). */
const NOT_READ = { tailnet: false };

function settleNet(): void {
  netOwed = false;
  for (const fn of netWaiters.splice(0)) { try { fn(); } catch { /* the next welcome asks again */ } }
}

function takeNet(s: NetState | null): void {
  if (s && !routeNet) routeNet = s;
  if (routeNet) settleNet();
}

/** Ask again, further apart: the shell's first push is fire-and-forget and can land before the page
 *  has a listener, and nothing pushes again until the network changes. */
function askUntilRead(wait: number, left: number): void {
  const t = setTimeout(() => {
    if (!netOwed) return;
    if (left <= wait) { settleNet(); return; }
    void currentNet().then(takeNet);
    askUntilRead(wait * 2, left - wait);
  }, Math.min(wait, left));
  (t as { unref?: () => void }).unref?.();
}

/**
 * Read the network once, and keep reading it: `plainHostRoute()` is synchronous, so `tailnet` has to
 * be in hand before anything asks. Awaited once at boot, before the first render, which waits
 * `NET_SEED_MS` at most; an answer later than that is kept all the same. Never rejects.
 *
 * Only a shell that holds `ShellTls` owes a reading: `tailnet` came after it, so a shipped APK with
 * `ShellNet` and no `ShellTls` is judged by the address's name, as it always was.
 */
export async function seedRouteNet(): Promise<void> {
  if (!netHeard) {
    netHeard = true;
    try { onShellNet((s) => { routeNet = s; settleNet(); }); } catch { /* no DOM */ }
    if (!routeNet && isNativeShell() && hasShellTls() && hasShellNet()) {
      netOwed = true;
      askUntilRead(NET_SEED_MS, NET_OWED_MS);
    }
  }
  let fuse: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<void>((done) => { fuse = setTimeout(done, NET_SEED_MS); });
  await Promise.race([currentNet().then(takeNet), late]);
  clearTimeout(fuse);
}

/** Is the first network reading still on its way? False on a shell that owes none, and once
 *  `NET_OWED_MS` is up: from then on it is a shell that does not say. */
export function netOwedNow(): boolean {
  return netOwed;
}

/**
 * Run `fn` once the route rule has its reading, now if nothing is owed. What a `welcome` teaches goes
 * through here: on a name alone, a relay on the Wi-Fi could replace a pin with no dialog. The caller
 * reads the socket's dial before it asks, because the socket may have moved on by then.
 */
export function whenNetRead(fn: () => void): void {
  if (netOwed) netWaiters.push(fn);
  else fn();
}

function activeRow(): SavedHost | null {
  const id = lsGet(LS.hostActive);
  return (id && parseHostList(lsGet(LS.hosts))?.find((h) => h.id === id)) || null;
}

/** The route rule for one address of the active row. `plainHostRoute()` asks it of where the route
 *  is now; a welcome is judged by the address its own socket dialled. */
export function plainInShell(base: string): boolean {
  const enforcing = hasShellTls();
  return isPlainRoute(base, routeContext(base, activeRow(), enforcing, routeNet));
}

/**
 * The one answer to "may the token ride here?" (`tokenWithheldOf`), read per call: the network moves
 * under a running app. `base` defaults to the base in force, `row` to the active row. Whoever answers
 * a withheld dial can say nothing about the token either: `lanLink.ts` and `ws.ts` keep it through a
 * 401 or an `authRequired`, or anyone at that address could make this phone forget it.
 *
 * **No reading yet** reads as Tailscale off, here and nowhere else. Holding it back costs one dial at
 * most: an ungated tailnet desktop opens the socket with no token, a gated one reads as a failed dial
 * and is retried, and `lanLink.ts` re-dials with the token once the reading says it may ride. Sending
 * it costs the token, to whoever answers. `NET_OWED_MS` is the bound: past it a silent shell is judged
 * by name again, so nobody stays out. A passive phone is left out of this: with no token it would
 * read `/api/auth/status` as not passive and forget the mark that draws its one screen.
 */
export function tokenWithheld(base: string | null = hostBase(), row?: RouteRow): boolean {
  if (!isNativeShell()) return false;
  const net = netOwed && lsGet(LS.passive) !== "1" ? NOT_READ : routeNet;
  return tokenWithheldOf(base, row ?? activeRow(), hasShellTls(), net);
}

/** Is `base` unprotected right now? For an address that is not the route in force: the one a socket
 *  dialled (`baseOfDial`), which is what a `welcome` is judged on, or the saved one. */
export function plainBaseNow(base: string): boolean {
  return plainInShell(base);
}

/** `wss://h:8771/ws` → `https://h:8771`: the base a socket's url was built from. Null for anything else. */
export function baseOfDial(url: string): string | null {
  const m = /^(wss?):\/\/([^/?#]+)/.exec(url);
  return m ? normalizeHostBase(`${m[1] === "wss" ? "https" : "http"}://${m[2]}`) : null;
}

/**
 * Is this device reaching the desktop unprotected right now (`isPlainRoute`)? Read per call: the
 * route moves under a running app. In the APK that is `hostBase()`, in a browser the page's own
 * origin, since the page IS the daemon there, and an `https` page is the address the person went to.
 */
export function plainHostRoute(): boolean {
  if (isDemo()) return false;
  const b = hostBase();
  if (b) return plainInShell(b);
  return !isNativeShell() && typeof location !== "undefined" && isPlainRoute(location.origin, { trusted: location.protocol === "https:" });
}

/** `plainHostRoute()` where it can change anything: a browser's page already came from that address. */
export function plainShellRoute(): boolean {
  return isNativeShell() && plainHostRoute();
}

/**
 * Would an APK reach this phone over an unprotected route? Asked of the SAVED address, because every
 * download goes there (`abs()`), never the LAN route: on a plain LAN route the bytes still ride the
 * tailnet. Only the shell installs anything, so a browser is told nothing.
 */
export function plainDownloadRoute(): boolean {
  if (isDemo() || !isNativeShell()) return false;
  const b = savedHostBase();
  return !!b && plainInShell(b);
}

/** Has a host been paired? Always true in the browser (it serves us), and in
 *  the demo, whose fake desktop is in the bundle (`demo/transport.ts`). */
export function hostConfigured(): boolean {
  if (isDemo()) return true;
  return !isNativeShell() || hostBase() !== null;
}

/**
 * Aim a root-relative `/api…` URL at the host. A no-op in the browser and for
 * every path that must stay local (shell assets, `/sw.js`, icons).
 *
 * Only needed where a URL is used as a raw attribute value — `<img src>`,
 * `<a href>`, Background Fetch, the native download service. Everything that
 * goes through fetch/XHR is already covered by `installHostRouting()`.
 *
 * **Always the SAVED (tailnet) address, never the LAN route.** Every one of
 * those loads is OPAQUE: no `Authorization` header can ride on an `<img>`, a
 * Background Fetch or a Java-side download, and the cookie is withheld
 * cross-site. The host gates every `/api/*` on the LAN, so the same URL on
 * the LAN route is a 401 — a blank thumbnail, a failed download — while the
 * tailnet address is trusted by network identity with no token at all. A
 * LAN-only desktop with a pin is `savedHostBase()`'s TLS address here too, where
 * nothing is trusted by network identity: that one load carries a read ticket.
 */
export function abs(url: string): string {
  // The demo has no host to point at: a host FILE is bundled media
  // (`public/demo/media/…`), anything else stays `/api` for the demo's fetch.
  if (isDemo()) return demoMediaUrl(url);
  return ticketedUrl(resolveHostUrl(savedHostBase(), url), ticket, Date.now());
}

// ── The read ticket ─────────────────────────────────────────────────────
//
// `abs()` URLs carry no bearer, so a phone with no tailnet would get a 401 for every `<img>`. The
// desktop signs a short-lived ticket (`POST /api/auth/read-ticket`) that it honours as `?wt=` on the
// two opaque read routes, over TLS only. Memory only: never in a store, a cache key or a copied link.

/** One ticket, tied to the address it was asked of. `exp` is the desktop's, epoch ms. */
export interface ReadTicket { base: string; wt: string; exp: number }

/** The host's `OPAQUE_READ_ROUTES` (`origin.ts`); `hostUrl.test.mjs` holds the two lists together. */
const OPAQUE_READ_PATHS = [/^\/api\/repos\/[^/]+\/artifact$/, /^\/api\/repos\/[^/]+\/inbox\/[^/]+$/];

/** `url` with the ticket on it, where the ticket is alive, of this address, and for this route. */
export function ticketedUrl(url: string, t: ReadTicket | null, now: number): string {
  if (!t || now >= t.exp || !url.startsWith(`${t.base}/`)) return url;
  const cut = url.indexOf("#");
  const head = cut < 0 ? url : url.slice(0, cut);
  let u: URL;
  try { u = new URL(head); } catch { return url; }
  if (u.searchParams.has("wt") || !OPAQUE_READ_PATHS.some((re) => re.test(u.pathname))) return url;
  return `${head}${u.search ? "&" : "?"}wt=${encodeURIComponent(t.wt)}${cut < 0 ? "" : url.slice(cut)}`;
}

/** `url` without any ticket: what a cache may key on. A URL only, never a person's words. */
export function ticketless(url: string): string {
  return url.replace(/([?&])wt=[^&#]*(&?)/g, (_m, lead: string, more: string) => (more ? lead : ""));
}

let ticket: ReadTicket | null = null;
/** The one before: an `<img>` drawn before a renewal still names it. */
let lastTicket: ReadTicket | null = null;

export function setReadTicket(t: ReadTicket | null): void {
  if (ticket && ticket.wt !== t?.wt) lastTicket = ticket;
  ticket = t;
}

/** How long the ticket held for this address has left; 0 when there is none. */
export function readTicketLeft(base: string | null, now: number): number {
  return ticket && ticket.base === base ? Math.max(0, ticket.exp - now) : 0;
}

/** Text on its way off this device (copy, share) with this page's tickets taken out. Only those
 *  exact values: a `wt=` a person typed is their own, so a general strip would change their words. */
export function scrubTickets(text: string): string {
  let out = text;
  for (const t of [ticket, lastTicket]) {
    if (!t) continue;
    const wt = encodeURIComponent(t.wt).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(`([?&])wt=${wt}(&?)`, "g"), (_m, lead: string, more: string) => (more ? lead : ""));
  }
  return out;
}

/**
 * The WebSocket URL. In the browser this is the page's own origin (unchanged
 * behaviour); in the shell it is the paired host, and null when none is paired
 * yet — `ws.ts` must not open a socket at `ws://localhost/ws`, which is the APK's
 * asset server and would fail-and-retry forever behind a "connecting" banner.
 */
export function wsUrl(): string | null {
  // A sentinel nothing dials: `ws.ts` hands it to the demo's own socket.
  if (isDemo()) return DEMO_WS_URL;
  const base = hostBase();
  if (base) return wsUrlFor(base, "/ws");
  if (isNativeShell()) return null;
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}/ws`;
}

let installed = false;

/**
 * Patch the three request transports so root-relative `/api` URLs reach the
 * paired host. Idempotent, and a no-op unless we are in the shell WITH a host.
 *
 * `credentials: "include"` is added to rewritten fetches so the LAN gate's auth
 * cookie has a chance to ride along. Note it currently will not: the cookie is
 * `SameSite=Lax` (`host/auth.ts`), and `http://localhost` → `http://100.x:8770`
 * is cross-site, so the browser withholds it. That only affects the optional
 * `WATERPLANE_ALLOW_PUBLIC` password gate, never the normal Tailscale path — see the
 * limitations in `docs/android-app.md`.
 */
export function installHostRouting(): void {
  if (installed) return;
  // The demo transport owns the transports instead (installed first, main.tsx).
  if (isDemo()) return;
  if (!hostBase()) return;
  installed = true;
  // NOT a constant: the route (`setRouteBase`) can move under a running page.
  // A host address is only ever replaced by a reload (`hosts.ts`), so this is
  // non-null for the life of the document once it was at install.
  const base = () => hostBase() ?? "";

  const origFetch = globalThis.fetch.bind(globalThis);
  // The device token rides ONLY to the host base in force (`bearerFor`): never
  // a third party, never the LAN address while it is still being verified. A
  // 401 on a request that carried it is the host refusing the token, so a
  // request that held it back (`tokenWithheld`) is never watched.
  const authFor = (url: string): string | null => {
    const auth = bearerFor(url, hostBase(), deviceToken());
    return auth && tokenWithheld() ? null : auth;
  };
  const watch = (p: Promise<Response>, auth: string | null): Promise<Response> =>
    auth ? p.then((r) => { if (r.status === 401) noteBearerRejected("http"); return r; }) : p;
  const withAuth = (init: RequestInit | undefined, auth: string | null): RequestInit | undefined => {
    if (!auth) return init;
    const h = new Headers(init?.headers);
    if (h.has("authorization")) return init;
    h.set("authorization", auth);
    return { ...init, headers: h };
  };
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    // A Request carries an already-absolute url (`http://localhost/api/…`), so
    // strip our own origin back off before asking whether it is a host path.
    if (typeof input !== "string" && !(input instanceof URL)) {
      const rel = localPath(input.url);
      const req = rel === null ? input : new Request(resolveHostUrl(base(), rel), input);
      const auth = authFor(req.url);
      if (auth && !req.headers.has("authorization")) {
        try { req.headers.set("authorization", auth); } catch { /* immutable headers — sent without */ }
      }
      return watch(origFetch(req, init), auth);
    }
    const url = String(input);
    const rel = url.startsWith("/") ? url : localPath(url);
    if (rel === null) {
      const auth = authFor(url);
      return watch(origFetch(input, withAuth(init, auth)), auth);
    }
    const next = resolveHostUrl(base(), rel);
    if (next === rel && rel === url) return origFetch(input, init);
    const auth = authFor(next);
    return watch(origFetch(next, withAuth({ credentials: "include", ...init }, auth)), auth);
  }) as typeof fetch;

  const origOpen = XMLHttpRequest.prototype.open;
  // Uploads go through XHR rather than fetch, for the progress events the
  // compose bar's "waiting for uploads" strip needs (see api.uploadInbox).
  XMLHttpRequest.prototype.open = function (
    this: XMLHttpRequest,
    method: string,
    url: string | URL,
    ...rest: unknown[]
  ) {
    const s = String(url);
    const rel = s.startsWith("/") ? s : localPath(s);
    const next = rel === null ? s : resolveHostUrl(base(), rel);
    // @ts-expect-error — variadic passthrough of the optional async/user/pass args
    const out = origOpen.call(this, method, next, ...rest);
    const auth = authFor(next);
    if (auth) {
      try {
        this.setRequestHeader("authorization", auth);
        this.addEventListener("load", () => { if (this.status === 401) noteBearerRejected("http"); }, { once: true });
      } catch { /* not OPENED — sent without */ }
    }
    return out;
  } as typeof XMLHttpRequest.prototype.open;

  installImageCors();

  // A beacon carries no header of ours (no bearer can ride on it), so like
  // `abs()` it goes to the SAVED address — on the LAN route it would be a 401.
  if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
    const origBeacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = ((url: string | URL, data?: BodyInit | null) => {
      const s = String(url);
      const rel = s.startsWith("/") ? s : localPath(s);
      return origBeacon(rel === null ? s : resolveHostUrl(savedHostBase() ?? "", rel), data);
    }) as typeof navigator.sendBeacon;
  }
}

/**
 * Make every `<img>`/`<video>` that points at the paired host a CORS request.
 *
 * The host's origin guard (`host/origin.ts`) refuses a request whose
 * `Sec-Fetch-Site` says `cross-site` when it carries no `Origin` at all — the
 * one gap `Origin` leaves, since a plain `<img src>` on a drive-by page sends no
 * `Origin` and would otherwise reach any GET route. In the browser the app is
 * same-origin and never trips it. In the shell EVERY artifact and inbox image is
 * cross-origin (`http://localhost` → `http://100.x:8770`) and a bare `<img>`
 * sends no `Origin`, so the whole gallery, every thumbnail, every new-image
 * strip and every inline file reference came back 403 with nothing on screen but
 * the broken-image placeholder.
 *
 * Setting `crossOrigin` makes the browser send `Origin: http://localhost`, which
 * IS one the host serves on — so the request is judged by the primary check
 * instead of the backstop, and the guard is not weakened by a single byte.
 * `anonymous` rather than `use-credentials`: the LAN gate's cookie is
 * `SameSite=Lax` and would be withheld cross-site either way, and asking for
 * credentials would additionally forbid a wildcard-free reply we do not need.
 *
 * Patched once at boot rather than at the ~10 places that render an image, for
 * the same reason the three transports are: a rule that has to be remembered at
 * each new call site is a rule that breaks silently in the APK weeks later. Both
 * `setAttribute` and the `src` property are covered because React sets `src`
 * through the former and hand-written code through the latter.
 */
function installImageCors(): void {
  // Either address of the host: the saved one, or the route in force now.
  const atHost = (v: string): boolean => {
    const saved = savedHostBase(), now = hostBase();
    return (!!saved && v.startsWith(saved)) || (!!now && v.startsWith(now));
  };
  const wants = (el: Element, name: string, value: unknown): boolean =>
    (name === "src" || name === "poster") &&
    (el instanceof HTMLImageElement || el instanceof HTMLVideoElement) &&
    typeof value === "string" && atHost(value);

  try {
    const origSet = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function (this: Element, name: string, value: string) {
      // Set crossOrigin FIRST: changing it after the src is assigned restarts the
      // fetch in some engines and leaves the first, refused one in the cache.
      if (wants(this, name, value) && !(this as HTMLImageElement).crossOrigin) {
        try { (this as HTMLImageElement).crossOrigin = "anonymous"; } catch { /* not settable */ }
      }
      return origSet.call(this, name, value);
    };

    for (const proto of [HTMLImageElement.prototype, HTMLVideoElement.prototype]) {
      const d = Object.getOwnPropertyDescriptor(proto, "src");
      if (!d?.set || !d.get) continue;
      Object.defineProperty(proto, "src", {
        configurable: true,
        enumerable: d.enumerable,
        get: d.get,
        set(this: HTMLImageElement, v: string) {
          if (wants(this, "src", v) && !this.crossOrigin) {
            try { this.crossOrigin = "anonymous"; } catch { /* not settable */ }
          }
          d.set!.call(this, v);
        },
      });
    }
  } catch {
    /* exotic engine — images fall back to the old (refused) behaviour rather than
       taking the app down at boot */
  }
}

/**
 * An absolute URL on OUR page origin, reduced to its path — or null if it points
 * anywhere else (already at the host, or a third party), in which case it must
 * be left exactly as it is.
 */
function localPath(url: string): string | null {
  try {
    const u = new URL(url, location.href);
    if (u.origin !== location.origin) return null;
    return `${u.pathname}${u.search}${u.hash}`;
  } catch {
    return null;
  }
}

/**
 * Ask the shell to show the pairing screen again (Settings → Paired host).
 *
 * A custom event rather than lifted state: the screen lives above `App` in
 * `main.tsx` (it has to — it decides whether `App` mounts at all), and threading
 * a setter down through the whole tree for one native-only button is not worth
 * the prop. No-op in the browser, where nothing listens.
 */
export function requestHostSetup(): void {
  try {
    window.dispatchEvent(new CustomEvent("app:host-setup"));
  } catch {
    /* no DOM */
  }
}
