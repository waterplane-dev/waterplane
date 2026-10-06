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
import { normalizeHostBase, resolveHostUrl, wsUrlFor } from "@waterplane/shared";
import { LS, lsGet } from "./storage.ts";
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

/** The SAVED address of the active host — the tailnet route, as stored. */
export function savedHostBase(): string | null {
  if (cached !== undefined) return cached;
  cached = null;
  if (isNativeShell()) {
    cached = normalizeHostBase(lsGet(KEY) || "");
  }
  return cached;
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
 * tailnet address is trusted by network identity with no token at all.
 */
export function abs(url: string): string {
  // The demo has no host to point at: a host FILE is bundled media
  // (`public/demo/media/…`), anything else stays `/api` for the demo's fetch.
  if (isDemo()) return demoMediaUrl(url);
  return resolveHostUrl(savedHostBase(), url);
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
  // 401 on a request that carried it is the host refusing the token.
  const authFor = (url: string): string | null => bearerFor(url, hostBase(), deviceToken());
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
