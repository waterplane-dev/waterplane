/**
 * Every writer of the tour's store, and where a row's tap goes. `DemoLine` is
 * mounted beside `App` and asks for the sheet by window event
 * (`DEMO_TOUR_EVENT`); `bootDemoTour` (the manifest's `boot`) is the listener.
 * The sheet never opens by itself: the first minute is the HOOK — the demo
 * opens straight into a session that is working (`openHookSession`), and "More
 * to try" is offered by the demo line and the hook's closing card.
 *
 * Nothing here touches the network: every row opens a screen the demo's
 * transport already answers (R-demo-004).
 */
import { core } from "../../sdk";
import { DEMO_TOUR_EVENT, demoActiveId, isDemo, openRepoHealthFor } from "../../demoEntry";
import { LS, lsJson, lsSetJson } from "../../storage";
import { markHook, markSeen, needsSession, parseTourState, shouldOpenHook, tourSession, type TourRow, type TourState } from "./logic";
import { tourStore } from "./store";

/** The one writer: store and storage move together. */
function saveTour(next: TourState): void {
  if (next === tourStore.get()) return;
  tourStore.set(next);
  lsSetJson(LS.demoTour, next);
}

export function openDemoTourSheet(): void {
  if (!isDemo()) return;
  const c = core();
  c.say.track("overlay:demotour");
  c.nav.open("demotour");
}

export function closeDemoTour(): void {
  core().nav.close("demotour");
}

/** Run `fn` once the Back just started has landed (its popstate), or after a
 *  short wait when none comes. */
function afterBack(fn: () => void): void {
  let done = false;
  const run = () => {
    if (done) return;
    done = true;
    window.removeEventListener("popstate", run);
    setTimeout(fn, 0);
  };
  window.addEventListener("popstate", run);
  setTimeout(run, 400);
}

/** A row's tap: go there, and mark it tried. Says so in words when the demo
 *  session it needs is not on the list yet, rather than doing nothing. */
export function runTourRow(row: TourRow): void {
  const c = core();
  const t = row.target;
  const s = needsSession(t) ? tourSession(c.world.sessions) : null;
  if (needsSession(t) && !s) {
    c.say.toast("The demo session is still loading — try again in a moment.");
    return;
  }
  c.say.track(`action:demotour.${row.id}`);
  const first = !tourStore.get().seen.includes(row.id);
  saveTour(markSeen(tourStore.get(), row.id));
  if (t.kind === "session" || t.kind === "reader") {
    const go = () => {
      const k = core();
      if (t.kind === "session") { k.nav.attach(s!); return; }
      k.nav.openReader(s!, false);
      // Appended (never over typed words) and only on the first tap, so a
      // second visit does not put the words in the box twice.
      if (t.seed && first) k.compose.seedDraft(s!.id, t.seed);
    };
    // The tour opened over a screen OF this session (its gallery, say): there
    // "this session, no sheet" is what closing a sheet looks like, and the
    // route takes it as ONE Back (`routeStep`) — onto the gallery again. So
    // the tour closes first, and the attach then closes what was under it.
    if (c.world.active?.id === s!.id) { closeDemoTour(); afterBack(go); } else go();
    return;
  }
  if (t.kind === "health") {
    // The session's own repo: attached first (a render apart, as below), so
    // the repo-health screen opens over it and Back lands on the session.
    if (c.world.active?.id !== s!.id) c.nav.attach(s!);
    setTimeout(() => openRepoHealthFor(null), 0);
    return;
  }
  if (!s) { c.nav.open(t.overlay); return; }
  c.nav.attach(s);
  // A render apart, so the session gets its OWN entry in the route stack under
  // the sheet. Batched into one, the stack held only "session + sheet", and a
  // later "Your session" row from a tour opened over that sheet read as
  // closing a sheet — one Back, onto the sheet again (`routeStep`).
  const overlay = t.overlay;
  setTimeout(() => core().nav.open(overlay), 0);
}

/** Read this device's tour and listen for the line's button. */
export function bootDemoTour(): () => void {
  tourStore.set(parseTourState(lsJson<unknown>(LS.demoTour, null)));
  window.addEventListener(DEMO_TOUR_EVENT, openDemoTourSheet);
  return () => window.removeEventListener(DEMO_TOUR_EVENT, openDemoTourSheet);
}

// ── The hook ──────────────────────────────────────────────────────────────

/**
 * `welcome`: the first time the hook scenario connects on this visit, open
 * its working session — the demo's first screen is the real CLI mid-turn, not
 * a menu. The session list FOLLOWS the welcome and is App's frame, so this
 * looks for the session over the next few renders instead of racing it; a
 * screen already up (a route a reload restored) is never taken over.
 */
export function openHookSession(): void {
  if (!isDemo() || tourStore.get().opened) return;
  let tries = 0;
  const look = () => {
    const c = core();
    const s = tourSession(c.world.sessions);
    if (!s) { if (++tries < 50) setTimeout(look, 100); return; }
    const ctx = { demo: isDemo(), scenario: demoActiveId(), active: !!c.world.active };
    if (shouldOpenHook(tourStore.get(), ctx)) {
      c.say.track("action:demohook.open");
      c.nav.attach(s);
    }
    // Opened, or a screen was already up: either way the hook's first move is spent.
    saveTour(markHook(tourStore.get(), "opened"));
  };
  setTimeout(look, 0);
}

/** The reader toggle was used: its hint has done its job. */
export function hookReadUsed(): void {
  const s = tourStore.get();
  if (s.read) return;
  core().say.track("action:demohook.read");
  saveTour(markHook(s, "read"));
}

/** Put the closing card away (its X). */
export function closeHookCard(): void {
  saveTour(markHook(tourStore.get(), "closed"));
}

/** A closing-card door. The card stays: Back lands on it again, so the other
 *  doors are still one tap away; only its X puts it away. */
export function hookDoor(id: "schedule" | "tokens" | "health" | "more", open: () => void): void {
  core().say.track(`action:demohook.${id}`);
  open();
}
