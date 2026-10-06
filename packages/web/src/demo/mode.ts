/**
 * Is this page the demo? — the switch, and nothing else (demo-mode-plan.md §2/§4).
 *
 * Two ways in, deliberately different in how long they last:
 *
 *  - `?demo=<scenario>` in the URL: the static web demo, Playwright, the docs.
 *    It lasts as long as the URL does and **writes nothing** — a journey run
 *    against a real host's origin must not leave that origin stuck in the demo.
 *  - `enterDemo(id)`: the "Try the demo" button (WP5a). Stored per device
 *    (`LS.demo`), so a cold start of the APK comes back into the demo.
 *
 * `demoScenarioId()` is what was ASKED for; `isDemo()` is what is RUNNING. They
 * differ when the asked-for scenario is not in this build — then the page runs
 * as no demo at all and `demoProblem()` says so in a sentence for the UI to
 * draw. Every guard in the app (push, OTA, LAN, native workers, the transport
 * itself) reads `isDemo()`, which only `demo/transport.ts` turns on, so a guard
 * can never be on while the transport is off — or the other way round.
 *
 * Node-importable (`.ts` specifiers, storage.ts only): `hostUrl.ts` reads it,
 * and that file has node tests.
 */
import { LS, demoSnapKey, lsDel, lsGet, lsSet } from "../storage.ts";

/** The URL parameter. */
export const DEMO_PARAM = "demo";

/** What `wsUrl()` answers in the demo. Never dialled: `ws.ts` hands it to the
 *  demo's own socket (`demo/transport.ts` `DemoSocket`). */
export const DEMO_WS_URL = "ws://demo.invalid/ws";

/** A scenario id as it may appear in a URL or a storage key: short, plain. */
const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** The scenario this page was asked to run, or null. The URL wins over the
 *  stored choice; anything not shaped like an id is no ask at all. */
export function demoScenarioId(): string | null {
  let id: string | null = null;
  try { id = new URLSearchParams(globalThis.location?.search ?? "").get(DEMO_PARAM); } catch { /* no location */ }
  if (!id) {
    id = lsGet(LS.demo);
  }
  return id && ID_RE.test(id) ? id : null;
}

let active: string | null = null;
let problem: string | null = null;

/** The demo transport is installed and every request goes to the fake desktop. */
export function isDemo(): boolean {
  return active !== null;
}

/** The running scenario's id, or null outside the demo. */
export function demoActiveId(): string | null {
  return active;
}

/** Why a demo that was asked for is not running, as a sentence — or null. */
export function demoProblem(): string | null {
  return problem;
}

/** `demo/transport.ts` only: the one writer of `isDemo()`. */
export function setDemoActive(id: string | null, why: string | null = null): void {
  active = id;
  problem = id ? null : why;
}

/**
 * Start the demo on this device: remember the choice and reload into it. Fresh
 * every time it is entered — a snapshot left in this tab from an earlier visit
 * is dropped, because "Try the demo" means the beginning.
 */
export function enterDemo(id: string): void {
  if (!ID_RE.test(id)) throw new Error(`not a demo scenario id: ${id}`);
  try { globalThis.sessionStorage?.removeItem(demoSnapKey(id)); } catch { /* storage off */ }
  lsDel(LS.demoTour); // the tour starts over, and opens by itself again
  lsSet(LS.demo, id);
  reloadAt(urlWithDemo(location.href, id));
}

/**
 * Leave the demo: forget the choice, drop the fake desktop's saved state, take
 * `?demo=` off the URL and reload as the real app. The route (hash) is kept.
 */
export function exitDemo(): void {
  const id = active ?? demoScenarioId();
  try { if (id) globalThis.sessionStorage?.removeItem(demoSnapKey(id)); } catch { /* storage off */ }
  lsDel(LS.demoTour); // what was tried on this visit goes with it
  lsDel(LS.demo);
  reloadAt(urlWithDemo(location.href, null));
}

/** The slice of `location` a reload needs. */
export interface Reloader {
  readonly href: string;
  replace(url: string): void;
  reload(): void;
}

/**
 * Load `next` as a NEW document. `location.replace` to the URL the page is
 * already on — the case with no `?demo=` to take off and a route in the hash
 * (`#a=demo-g1&o=gallery`) — is a same-document navigation: nothing reloads,
 * the transport stays installed and "Leave the demo" did nothing. Then the
 * page reloads itself instead, keeping the route.
 */
export function reloadAt(next: string, loc: Reloader = location): void {
  if (next === loc.href) loc.reload();
  else loc.replace(next);
}

/** `href` with `?demo=` set to `id`, or removed when `id` is null. Pure. */
export function urlWithDemo(href: string, id: string | null): string {
  const u = new URL(href);
  if (id) u.searchParams.set(DEMO_PARAM, id);
  else u.searchParams.delete(DEMO_PARAM);
  return u.toString();
}
