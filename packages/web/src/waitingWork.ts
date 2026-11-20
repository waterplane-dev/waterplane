/**
 * Waiting work: ONE screen for what is posted and not yet done (whole-app journey spec D4), with four
 * tabs — Activity, Queued, Backlog, Scheduled. Each tab's body is a feature's sheet as it was (the
 * activity, queue, backlog and schedule features); only the frame is shared. This module is that
 * frame's state, with no React in it:
 *
 * - **which tab each screen id shows.** `waiting` and its four aliases (`activity`, `queue`, `backlog`,
 *   `schedule`, `routing.ts` `OVERLAY_ALIAS`) all draw the same screen. An alias opens on its own tab;
 *   `waiting` on Activity (spec Q12). A tab switch is a view, not a Back step: Back from any tab goes
 *   where the tap came from. The switch is stored PER id, so a screen pushed over another one of the
 *   family never moves the tab under it.
 * - **the bodies**, registered by their features (`registerWaitingBody`): how to draw one, and the
 *   cut it drops on leave and puts back on a Back (the sheet's own `onLeave`/`keep`, as before).
 *
 * A feature never imports another, so the bodies come in through here (a top-level module both sides
 * may read), and the four features' sheet entries are built by `waitingSheet` (`WaitingFrame.tsx`).
 */
import type { ReactNode } from "react";
import { core, createStore, type LeaveReason } from "./sdk";
import { OVERLAY_ALIAS, parseHash, setWaitingTabCarrier, type Overlay, type WaitingTab } from "./routing";

/** The screen ids that draw Waiting work: the merged id and its four aliases. */
export type WaitingId = "waiting" | "activity" | "queue" | "backlog" | "schedule";
export const WAITING_IDS: readonly WaitingId[] = ["waiting", "activity", "queue", "backlog", "schedule"];
/** The tabs, in the order drawn. */
export const WAITING_TABS: readonly WaitingTab[] = ["activity", "queued", "backlog", "scheduled"];

export const isWaitingId = (o: Overlay | string | null | undefined): o is WaitingId =>
  !!o && (WAITING_IDS as readonly string[]).includes(o);

/** The tab an id lands on when nobody switched: its alias tab, or Activity for `waiting` itself. */
export function homeTab(id: WaitingId): WaitingTab {
  return id === "waiting" ? "activity" : OVERLAY_ALIAS[id].tab;
}

/** A switched tab, per screen id. Absent = the id's home tab. */
export const waitingTabs = createStore<Partial<Record<WaitingId, WaitingTab>>>({});

// The hash carries the tab on the merged id, so a reload or a bundle resume lands on it, not on Activity.
setWaitingTabCarrier(() => { const t = waitingTabs.get().waiting; return t && t !== "activity" ? t : null; });
try { const t = parseHash().waitingTab; if (t) waitingTabs.set((w) => ({ ...w, waiting: t })); } catch { /* no location */ }

/** Rewrite the open entry's hash to carry the tab now showing (no new history entry). */
function carryTabInHash(id: WaitingId): void {
  if (id !== "waiting" || typeof history === "undefined") return;
  try {
    const p = new URLSearchParams(location.hash.replace(/^#/, ""));
    if (p.get("o") !== "waiting") return;
    const t = waitingTabs.get().waiting;
    if (t && t !== "activity") p.set("wt", t); else p.delete("wt");
    history.replaceState(history.state, "", `${location.pathname}${location.search}#${p.toString()}`);
  } catch { /* no history */ }
}

export function tabOf(id: WaitingId, tabs: Partial<Record<WaitingId, WaitingTab>> = waitingTabs.get()): WaitingTab {
  return tabs[id] ?? homeTab(id);
}

export interface WaitingBody {
  render: () => ReactNode;
  /** Drop the tab's cut (a filter is the tap, not a setting). */
  leave?: () => void;
  /** What puts the cut back on a Back to this screen (`SheetDef.keep`). */
  keep?: () => () => void;
}
const bodies = new Map<WaitingTab, WaitingBody>();

/** A feature hands in its tab's body at load (its `index.ts`). */
export function registerWaitingBody(tab: WaitingTab, body: WaitingBody): void { bodies.set(tab, body); }
export function waitingBody(tab: WaitingTab): WaitingBody | undefined { return bodies.get(tab); }

/** Show another tab on this screen. The tab left drops its cut, as leaving its sheet did. */
export function switchWaitingTab(id: WaitingId, tab: WaitingTab): void {
  const from = tabOf(id);
  if (from === tab) return;
  core().say.track(`action:waiting.tab.${tab}`);
  bodies.get(from)?.leave?.();
  waitingTabs.set((t) => ({ ...t, [id]: tab }));
  carryTabInHash(id);
}

/**
 * The screen closed: its tab's cut goes, and it opens on its home tab next time. A COVER drops
 * nothing: the five ids share four bodies' stores, so the screen pushed over this one may be the
 * same body under another id (a backlog cut opened from the Backlog tab of `waiting` lands on the
 * `backlog` id), and dropping the cut here would wipe the one that tap just set. That is what one id
 * covering itself always did (`backStep.ts` `sheetLeaves` never tells the sheet on top it left);
 * `keepWaiting` still puts back what the Back returns to.
 */
export function leaveWaiting(id: WaitingId, reason: LeaveReason = "close"): void {
  if (reason === "cover") return;
  bodies.get(tabOf(id))?.leave?.();
  waitingTabs.set((t) => {
    if (!(id in t)) return t;
    const { [id]: _gone, ...rest } = t;
    return rest;
  });
}

/** Covered by another screen: what puts the tab and its cut back on the Back that returns here. */
export function keepWaiting(id: WaitingId): () => void {
  const tab = waitingTabs.get()[id];
  const restoreCut = bodies.get(tabOf(id))?.keep?.();
  return () => {
    waitingTabs.set((t) => ({ ...t, [id]: tab }));
    restoreCut?.();
  };
}

/** Open Waiting work on a tab (the ☰ line, the Home chip). Each count opens its own tab and cut. */
export function openWaiting(tab: WaitingTab = "activity"): void {
  const c = core();
  c.say.track("overlay:waiting");
  waitingTabs.set((t) => ({ ...t, waiting: tab }));
  c.nav.open("waiting");
}

/**
 * The door every opener of a Waiting work id uses (`nav.open("backlog")` and its kin). The five ids
 * draw ONE screen, so when any of them is already on top the tap retargets it in place: it moves that
 * screen to the tab asked for (a same-tab open just keeps the cut the opener wrote) and pushes nothing.
 * A push would leave a look-alike screen on the stack whose Back restores a cut the opener had
 * already replaced, then drops it. Any other screen on top is the plain open.
 */
export function openWaitingId(id: WaitingId): void {
  const c = core();
  const top = c.nav.overlay;
  if (isWaitingId(top)) {
    if (tabOf(top) !== homeTab(id)) switchWaitingTab(top, homeTab(id));
    return;
  }
  c.nav.open(id);
}

/**
 * A body's own close. The body may be drawn under any of the five ids, and a sheet may only close
 * ITSELF (`nav.close`): this closes the screen on top only when it IS Waiting work, so a close that
 * lands after the body's own action opened the next screen stays a no-op.
 */
export function closeWaiting(): void {
  const c = core();
  const o = c.nav.overlay;
  if (isWaitingId(o)) c.nav.close(o);
}
