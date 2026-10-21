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
import { HOOK_PROMPT, claimHook, claimsHook, markHook, markSeen, needsSession, parseTourState, shouldTypeHook, tourRowPath, tourSession, type TourRow, type TourState } from "./logic";
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
    if (tourRowPath(t, c.world.active?.id, s!.id) === "after-close") { closeDemoTour(); afterBack(go); } else go();
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
  const overlay = t.overlay;
  // Over this session already: the attach would be a Back that lands after the
  // sheet opened and closes it (`tourRowPath`) — close the tour, then open.
  if (tourRowPath(t, c.world.active?.id, s.id) === "after-close") {
    closeDemoTour();
    afterBack(() => core().nav.open(overlay));
    return;
  }
  c.nav.attach(s);
  // A render apart, so the session gets its OWN entry in the route stack under
  // the sheet. Batched into one, the stack held only "session + sheet", and a
  // later "Your session" row from a tour opened over that sheet read as
  // closing a sheet — one Back, onto the sheet again (`routeStep`).
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
 * A session is on screen (`DemoHookHint`'s effect): the demo opens on the repo list with a cue at
 * todo-garden's `+ now` (`DemoStartCue`), and nothing is attached by itself — starting a session on
 * your desktop is the first thing the demo shows (R-demo-014). The first FRESH session in that repo
 * this visit is the hook's: claimed (the cue is spent with it), and its first prompt typed into the
 * box. The person's own tap put it on screen; the typing checks it still is, word by word.
 */
export function claimHookSession(session: { id: string; cwd: string; firstPrompt?: string }): void {
  if (!isDemo()) return;
  if (!claimsHook(tourStore.get(), { demo: isDemo(), scenario: demoActiveId(), session })) return;
  core().say.track("action:demohook.open");
  saveTour(claimHook(tourStore.get(), session.id));
  typeHookPrompt(session.id);
}

/** Put the start cue away (its X): the repo list is the person's again. */
export function closeStartCue(): void {
  saveTour(markHook(tourStore.get(), "opened"));
}

/** Before the first key: claude's own welcome header is on screen and gets a look first (R-demo-016).
 *  Short: the header stays up above the box while the prompt is typed, so the look does not need a
 *  still screen of its own (the README's loop held 1.6 s of nothing here). */
const TYPE_LEAD_MS = 300;
/** Between words: the prompt goes in a word at a time, its nine words in about two thirds of a second —
 *  seen being typed, read once it stands whole (`SEND_PAUSE_MS`) and again on the session's screen.
 *  Letter by letter it took 1.5 s and filmed as a run of near-still pictures (scripts/ui/pace.mjs). */
const WORD_MS = 70;
/** HOOK_PROMPT's prefixes a word apart (each with its leading space), the last one the whole prompt. */
const WORD_ENDS = [...HOOK_PROMPT.matchAll(/\S+/g)].map((m) => (m.index ?? 0) + m[0].length);
/** The whole prompt stands in the box for a moment before Send. */
const SEND_PAUSE_MS = 700;

/**
 * The hook's first prompt, typed into the compose box a word at a time and sent, as
 * a person would: the first thing the demo shows the app doing is the box they
 * will use. Every word is `typeOn` from what the last one left, so a person's
 * own typing (or leaving the session) stops it where it stands — their words
 * are never added to, replaced or sent. Once per visit, either way.
 */
function typeHookPrompt(sid: string): void {
  const stop = () => saveTour(markHook(tourStore.get(), "typed"));
  const here = () => core().world.active?.id === sid;
  window.setTimeout(() => {
    const c = core();
    if (!shouldTypeHook(tourStore.get(), { demo: isDemo(), scenario: demoActiveId(), activeId: c.world.active?.id ?? null, draft: c.compose.draft })) { stop(); return; }
    let w = 0;
    const key = () => {
      const from = w ? WORD_ENDS[w - 1] : 0;
      if (!here() || !core().compose.typeOn(HOOK_PROMPT.slice(0, from), HOOK_PROMPT.slice(0, WORD_ENDS[w]))) { stop(); return; }
      if (++w < WORD_ENDS.length) { window.setTimeout(key, WORD_MS); return; }
      window.setTimeout(() => {
        const k = core();
        if (here() && k.compose.draft === HOOK_PROMPT) {
          k.say.track("action:demohook.send");
          k.compose.send();
        }
        stop();
      }, SEND_PAUSE_MS);
    };
    key();
  }, TYPE_LEAD_MS);
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
