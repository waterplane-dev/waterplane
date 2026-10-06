/**
 * The ways in and out of the demo, for the screens (demo-mode-plan.md §4).
 *
 * `mode.ts` is the switch and is node-importable; this is the decision of WHICH
 * mechanism a tap uses, because the shell and the browser keep a demo
 * differently: the Android shell makes it a `SavedHost` (the real host's words
 * are parked while it runs — `hosts.ts`), a browser tab keeps it in its own
 * storage corner (`world.ts`) and a URL flag (`mode.ts`).
 */
import { enterDemoHost, leaveDemoHost, realHosts, listHosts } from "./hosts.ts";
import { isNativeShell } from "./hostUrl.ts";
import { enterDemo, exitDemo } from "./demo/mode.ts";
import { LS, lsDel } from "./storage.ts";

/** Re-exported so a feature folder (which may import only top-level modules) can ask. */
export { demoActiveId, isDemo } from "./demo/mode.ts";

/** What "Try the demo" opens. */
export const DEFAULT_DEMO = "first-look";

/** Start the demo on this device, fresh. */
export function tryDemo(id: string = DEFAULT_DEMO): void {
  lsDel(LS.demoTour); // the shell's way in skips `enterDemo`, which clears it too
  if (isNativeShell() && enterDemoHost(id)) return;
  enterDemo(id);
}

/** Leave it: back to the host it was entered from (shell), or to the app (browser). */
export function leaveDemo(): void {
  lsDel(LS.demoTour); // the shell's way out skips `exitDemo`, which clears it too
  if (isNativeShell() && leaveDemoHost()) return;
  exitDemo();
}

/**
 * Where the demo is running, which decides what its line says it can do.
 *  - `shell`: the Android app — it can pair a real desktop.
 *  - `host`: a browser served BY a desktop's host — it can simply leave.
 *  - `static`: a browser on an origin that is no host (a hosted demo page, a
 *    docs site) — `origin.ts` refuses it to every real desktop, so the only
 *    honest advice is to open waterplane from your own host.
 */
export type DemoPlace = "shell" | "host" | "static";

/** Pure: the place from the shell flag and the page's host name. */
export function demoPlaceOf(shell: boolean, hostname: string): DemoPlace {
  if (shell) return "shell";
  const h = hostname.toLowerCase();
  const hostLike = h === "localhost" || h === "[::1]" || h.endsWith(".ts.net") || h.endsWith(".local")
    || /^\d{1,3}(\.\d{1,3}){3}$/.test(h);
  return hostLike ? "host" : "static";
}

export function demoPlace(): DemoPlace {
  return demoPlaceOf(isNativeShell(), globalThis.location?.hostname ?? "");
}

/**
 * The demo's "More to try" tour is a sheet inside `App` (`features/demoTour`),
 * and `DemoLine` is mounted beside `App`, so the line asks for it by window
 * EVENT — the strips' way (`app:open-nethealth`), never a second router.
 */
export const DEMO_TOUR_EVENT = "app:open-demotour";

export function openDemoTour(): void {
  try { window.dispatchEvent(new CustomEvent(DEMO_TOUR_EVENT)); } catch { /* no DOM */ }
}

/**
 * Repo health for one repo (`features/setup`'s `repohealth` overlay), asked for
 * by EVENT for the same reason: the demo's tour row and closing card live in a
 * feature that may not import another (`features/setup` boots the listener).
 * `detail.repoId` names the repo; absent = the session's own.
 */
export const REPO_HEALTH_EVENT = "app:open-repohealth";

export function openRepoHealthFor(repoId?: string | null): void {
  try { window.dispatchEvent(new CustomEvent(REPO_HEALTH_EVENT, { detail: { repoId: repoId ?? null } })); } catch { /* no DOM */ }
}

/** Does the shell have a real desktop to go back to? (Decides "Connect" vs "Leave".) */
export function haveRealHost(): boolean {
  return realHosts(listHosts()).length > 0;
}
