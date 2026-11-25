/**
 * Back INSIDE a screen: the step a sheet takes without changing the route.
 *
 * The route (`useRoute`) is which session, which sheet, which repo focus — and
 * the history stack pushes one entry per route. But a sheet has screens of its
 * own that are not routes: the file browser opens a file, a list opens a row's
 * detail, a picker drills into a folder. Those lived in the sheet's `useState`
 * and pushed nothing, so the Android swipe — which pops ONE history entry —
 * popped the whole sheet: open a file from the browser, swipe back, and you
 * are on the main view instead of the listing you just left. The in-app arrow
 * did the right thing and the gesture did not, which is the worst kind of
 * inconsistency because it trains the hand to distrust the gesture.
 *
 * So a sub-view says it is open, and that is the whole contract:
 *
 *     const [open, setOpen] = useState<File | null>(null);
 *     useBackStep(open !== null, () => setOpen(null));
 *
 * While the condition holds, one history entry sits above the screen. Back
 * (gesture, hardware, `shellBack`) pops it and calls the close — the sheet stays.
 * Closing it by any other means (its own arrow, a pick, the sheet unmounting)
 * retires the entry, so the next Back is not a dead press.
 *
 * The stack state lives HERE, not in a ref inside `useRoute`, because the step
 * hook and the route hook must agree on one depth — and the Android shell is
 * told that depth (`pushBackDepth`) so it knows the gesture is ours.
 */
import { useEffect, useRef, useState } from "react";
import { shellInterface } from "./shellBridge.ts";
import { overlayFromKey, routeKey, routeStep, screenOfKey, SPENT_ON_LEAVE, stepKey, VACANT, type Overlay } from "./routing.ts";

/** The keys this document pushed, by depth, and where we are in them. */
export const routeStack: { depth: number; keys: string[] } = { depth: 0, keys: [] };

/**
 * Tell the Android shell how deep the app is, BEFORE it needs to know.
 *
 * Android 13+ asks at the START of a predictive-back swipe — before the
 * gesture commits — whether the app will handle Back, so it can choose the
 * in-app animation or the exit one. There is no `evaluateJavascript` round
 * trip available at that moment, which is exactly why the gesture behaved
 * differently from the button: the shell could only ask `window.shellBack()`
 * after the fact. So the depth is PUSHED instead, and `shellBack` stays as the
 * fallback. It must be pushed from every place the depth moves — a depth left
 * stale at 0 makes every Back exit the app.
 */
export function pushBackDepth(): void {
  shellInterface<{ setBackDepth?: (n: number) => void }>()?.setBackDepth?.(backHeld ? 0 : routeStack.depth);
}

/**
 * While the app lock is up, Back is not the page's: a pop would move the
 * screens behind the card. The shell is told depth 0, so it does what it does
 * at the root and leaves the app; the real depth comes back with the release.
 */
let backHeld = false;
export function holdBack(on: boolean): void {
  backHeld = on;
  pushBackDepth();
}
export const isBackHeld = (): boolean => backHeld;

/** Open steps, by the depth of their entry. */
const steps = new Map<number, { id: number; close: () => void }>();
let nextId = 1;

/**
 * A pop landed at `depth`: every step above it is closed — by the Back that
 * popped it, so its own close must not pop again. Returns whether the entry
 * landed on is DEAD (a step slot with nothing open behind it), in which case
 * the caller keeps going back. After a reload memory holds no key for an entry
 * below the one booted on: `entryKey`, the one the entry itself carries, answers.
 */
export function popStepsTo(depth: number, entryKey?: string): boolean {
  for (const [d, s] of [...steps]) {
    if (d <= depth) continue;
    steps.delete(d);
    s.close();
  }
  const k = routeStack.keys[depth] ?? entryKey;
  return k === VACANT || (k !== undefined && k.includes("#step") && !steps.has(depth));
}

/**
 * A Back on its way past dead entries (`landPop`): the depth of the last one passed, or null. `owed`: the press
 * started ON a dead entry, so it closed nothing yet, and the first live screen it reaches is the one it leaves.
 */
export const pass: { depth: number | null; owed: boolean } = { depth: null, owed: false };
let passGen = 0;

/** Go back past the dead entry at `depth`. One that never lands ends by itself, as a retire does. */
export function passOn(depth: number): void {
  pass.depth = depth;
  const gen = ++passGen;
  setTimeout(() => { if (gen === passGen) endPass(); }, RETIRE_LANDS_MS);
  history.back();
}

/** The Back landed on a screen. Steps that waited for it take their entries once the route it set has landed too. */
export function endPass(): void {
  passGen++;
  if (pass.depth === null) return;
  pass.depth = null;
  pass.owed = false;
  queueRetire();
  setTimeout(() => { if (!retiring) runParked(); }, 0);
}

let retireQueued = false;
/**
 * After the commit that closed a step: pop the vacant slots left at the TOP.
 * Deferred, because the same commit may also change the route — then the
 * routing effect has already unwound past them or pushed over them, and there
 * is nothing left for us to do.
 *
 * ONE traversal at a time. A second one started while the first is in flight (two dialogs answered, the
 * first pop slow) would be taken for landed at the first's popstate, and the landings parked behind it would
 * push while it still ran: the race `whenRetired` is for. So it waits its turn. A Back that is
 * already passing the dead entries takes them itself.
 */
function queueRetire(): void {
  if (retireQueued) return;
  if (retiring) { whenRetired(queueRetire); return; }
  retireQueued = true;
  queueMicrotask(() => {
    retireQueued = false;
    if (pass.depth !== null) return;
    let n = 0;
    while (routeStack.depth - n > 0 && routeStack.keys[routeStack.depth - n] === VACANT) n++;
    if (!n) return;
    routeStack.depth -= n;
    routeStack.keys.length = routeStack.depth + 1;
    pushBackDepth();
    retiring = true;
    // Safety net: a traversal that never reports (nothing to go back to) must not park a route change for good.
    const gen = ++retireGen;
    setTimeout(() => { if (gen === retireGen) retireLanded(); }, RETIRE_LANDS_MS);
    history.go(-n);
  });
}

const RETIRE_LANDS_MS = 1500;
let retiring = false;
let retireGen = 0;
const afterRetire: Array<() => void> = [];

/**
 * True while a retire's `history.go(-n)` is in flight. The traversal is async: a push or replace made
 * before it lands is done from the DEAD entry, and the traversal then runs from the new entry and lands
 * back on the dead one — the screen just opened disappears. `landRoute` parks its landing with
 * `whenRetired` until the pop has arrived.
 */
export const isRetiring = (): boolean => retiring;

/** Run `fn` once the retire's pop has landed. */
export function whenRetired(fn: () => void): void { afterRetire.push(fn); }

/**
 * The pop of our own retire has landed (`landPop`, or the safety timer): parked landings run now, in
 * order. Returns whether there was a retire in flight — that pop is housekeeping, not a navigation:
 * the stack was already moved by `queueRetire` and the route in memory is the one the app chose, so
 * it must not be re-derived from the entry landed on.
 */
export function retireLanded(): boolean {
  if (!retiring) return false;
  retiring = false;
  runParked();
  return true;
}

function runParked(): void {
  for (const fn of afterRetire.splice(0)) fn();
}

/**
 * Push one step entry over the screen on top. **It carries its screen's params** (`navParams`, a
 * COPY of what the screen's own entry holds): a reload with a step on top boots on the STEP's
 * `history.state`, and the seed reads them from there (`adoptCarried`) — with the params on the
 * route entry alone, a reload with the explain pane or an open file on top came back on the
 * session's repo (review R2-2b M1).
 */
export function pushStep(): { id: number; depth: number; key: string } {
  const id = nextId++;
  let below = routeStack.depth;
  while (below > 0 && routeStack.keys[below] === VACANT) below--;
  const depth = routeStack.depth + 1;
  const key = stepKey(screenOfKey(routeStack.keys[below] ?? ""), id);
  const own = ownerOf(depth);
  const h = own ? held.get(own.d) : undefined;
  const carried = own && h && h.key === own.k && h.params ? { navParams: h.params } : {};
  history.pushState({ navRoute: key, navDepth: depth, ...carried }, "");
  routeStack.depth = depth;
  routeStack.keys[depth] = key;
  routeStack.keys.length = depth + 1;
  pushBackDepth();
  return { id, depth, key };
}

/** The screen entry under `depth` — read through steps and vacant slots — or null at the root. */
function ownerOf(depth: number): { d: number; k: string } | null {
  let d = depth - 1;
  while (d > 0 && (routeStack.keys[d] === VACANT || routeStack.keys[d] !== screenOfKey(routeStack.keys[d] ?? ""))) d--;
  const k = routeStack.keys[d];
  return k && k !== VACANT ? { d, k } : null;
}

/**
 * While `open`, one history entry above this screen whose Back calls `close`.
 * See the file header. `close` may change on every render; the latest is used.
 *
 * **A close that leaves it open RE-ARMS.** Back from a sub-folder goes to its
 * parent, which is still not the root: `useBackStep(dir !== "", up)` then
 * pushes a fresh entry, so the next Back walks up again rather than out of the
 * sheet. That is how one call covers a drill-down of any depth.
 */
export function useBackStep(open: boolean, close: () => void): void {
  useStep(open, close, 0);
}

/** How long a dialog's entry outlives its answer — long enough for the answer to move the route, too short for a second Back. */
const ANSWER_MS = 50;

/**
 * Is `useRoute` listening for pops? On the screens before `App` (first pairing) nobody is, so an entry pushed
 * there would be popped without closing anything: the dialog then takes no step.
 */
let routed = false;
export function setRouted(on: boolean): void { routed = on; }

/**
 * Back for a dialog drawn OVER the app, beside the route: a confirm, "type a line", a hint card. Back
 * answers it as its backdrop does (`dismiss`) and the screen underneath stays.
 *
 * Its entry is dead at once but POPPED a moment later than a sub-view's. A sub-view closes and is done; a
 * dialog's answer runs on in promise continuations that may move the route ("Leave" closes the sheet, a
 * picked repo opens a session). The pop is an async `history.go(-1)`: started first, the push that follows
 * lands under it and the traversal then steps off the NEW screen. Left in place for a moment, the route
 * lands over the dead entry or unwinds past it, which `landRoute` already does right, and there is
 * nothing left to pop. A Back in that moment passes it (`landPop`), so no press is spent on it.
 */
export function useDialogStep(open: boolean, dismiss: () => void): void {
  useStep(open && routed, dismiss, ANSWER_MS);
}

function useStep(open: boolean, close: () => void, retireMs: number): void {
  const closeRef = useRef(close);
  closeRef.current = close;
  const [armed, rearm] = useState(0);
  useEffect(() => {
    if (!open) return;
    const retire = armStep(() => { closeRef.current(); rearm((n) => n + 1); });
    return () => retire(retireMs);
  }, [open, armed, retireMs]);
}

/**
 * One step entry above the screen on top, owned by the CALLER rather than by a mounted view: `close`
 * runs when a Back pops it; the returned `retire` takes it away by any other means. `useBackStep` is
 * this tied to a component's lifetime. A drill-down whose state lives in a store (the Setup check's
 * all-repos → rule → repo) arms its steps itself, at the tap: a door opened over the drilled screen
 * unmounts the sheet, and a step that died with the unmount left the Back from that door landing one
 * level too far down (the entry under it was a dead step, so the pop kept going).
 */
export function armStep(close: () => void): (afterMs?: number) => void {
  let at: { id: number; depth: number } | null = null;
  let gone = false;
  const arm = (): void => {
    if (gone) return;
    // A traversal of ours in flight runs from the entry it was started on: one pushed now is what it would pop.
    if (retiring || pass.depth !== null) { whenRetired(arm); return; }
    at = pushStep();
    steps.set(at.depth, { id: at.id, close });
  };
  arm();
  return (afterMs = 0) => {
    gone = true;
    // Closed by a Back: `popStepsTo` already took it out, and the entry is gone.
    if (!at || steps.get(at.depth)?.id !== at.id) return;
    const { id, depth } = at;
    steps.delete(depth);
    // By id, not by the key it was pushed under: the screen under it may have been renamed since (`renameUnder`).
    if (routeStack.keys[depth]?.endsWith(stepKey("", id))) routeStack.keys[depth] = VACANT;
    if (afterMs) setTimeout(queueRetire, afterMs); else queueRetire();
  };
}

/** Entries renamed while something was drawn over them: what each still says, and what it is now. By depth. */
const renamed = new Map<number, { from: string; key: string; url: string }>();

/**
 * The screen at `under` became `key` while steps stand over it (a pending session started under an open
 * picker). The steps stay open: Back closes the picker first, then leaves the session. Only the entry on top
 * can be rewritten in the browser now; the ones below are renamed here and rewritten when a pop reaches
 * them (`mendRenamed`).
 */
export function renameUnder(under: number, key: string, url: string): void {
  const old = routeStack.keys[under] ?? "";
  const to = (k: string): string => key + k.slice(old.length);
  for (let d = under; d <= routeStack.depth; d++) {
    const k = routeStack.keys[d];
    if (k === undefined || k === VACANT || screenOfKey(k) !== old) continue;
    routeStack.keys[d] = to(k);
    if (d < routeStack.depth) renamed.set(d, { from: k, key: to(k), url });
  }
  const h = held.get(under);
  if (h && h.key === old) held.set(under, { ...h, key });
  const st = history.state as { navRoute?: string } | null;
  if (st?.navRoute && screenOfKey(st.navRoute) === old) history.replaceState({ ...st, navRoute: to(st.navRoute) }, "", url);
}

/** A pop reached an entry renamed from above (`renameUnder`): the entry says so too from now on. */
export function mendRenamed(): void {
  const st = history.state as { navRoute?: string; navDepth?: number } | null;
  const r = renamed.get(st?.navDepth || 0);
  if (!st || !r || st.navRoute !== r.from) return;
  renamed.delete(st.navDepth || 0);
  history.replaceState({ ...st, navRoute: r.key }, "", r.url);
}

/**
 * **Back returns to a sheet as it was left** — its cut included.
 *
 * A sheet's focus (the backlog's "the 10 waiting in this repo", a schedule's
 * selection) is a tap, not a setting, so `onLeave` drops it. That is right for
 * a close and wrong for a sheet another screen was pushed OVER: fire a backlog
 * row, go Back, and the backlog came back with all 37 rows instead of the ten
 * on screen a moment ago. So the routing effect asks the covered sheet what
 * puts it back (`keepCovered`) before `onLeave` runs, and a pop landing on that
 * entry again restores it (`restoreKept`) before the sheet renders. A tap that
 * opens the same screen afresh forgets it (`forgetKept`) — the tap set its own.
 *
 * The keeper is registered by the sheet table (`core/sheets.ts`), so this
 * module stays free of the feature registry.
 */
type Keeper = (screenKey: string) => (() => void) | null;
let keeper: Keeper = () => null;
const kept = new Map<number, { key: string; restore: () => void }>();

export function setSheetKeeper(fn: Keeper): void { keeper = fn; }

/** A screen is about to be pushed over the entry at `depth`: keep what it showed. */
export function keepCovered(depth: number): void {
  for (const d of [...kept.keys()]) if (d >= depth) kept.delete(d);
  const key = routeStack.keys[depth];
  if (!key || key === VACANT) return;
  const restore = keeper(screenOfKey(key));
  if (restore) kept.set(depth, { key, restore });
}

/**
 * **Which sheets left the stack, and why** — for their `onLeave` (`SheetDef`, `sdk/types.ts`):
 * `"cover"` when another screen was pushed over it and Back will return to it, `"close"` when its
 * entry is gone. ONE derivation from the stack before and after the route layer moved it
 * (`landRoute`/`landPop` call `announceLeaves`), so every sheet entry a move removed is told — an
 * unwind past a covered sheet, a Back that skips a dead step — not only the one that was on top,
 * and an entry is matched by its exact KEY, so the same sheet over another session lower down
 * never makes a real close read as a cover (review r4-7 M1, L2). The route layer dispatches it
 * itself after the move, so no React effect order is involved (review r4-7 L3). A sheet that is
 * still the one on top (re-targeted to a new entry) is not leaving. Design round 4.
 */
export type LeaveReason = "close" | "cover";
export type StackView = { depth: number; keys: readonly string[] };
type Leave = (sheet: string, reason: LeaveReason) => void;
let leaveSheet: Leave = () => {};

/** The sheet table registers its dispatch (`core/sheets.ts`), keeping this module free of the registry. */
export function setSheetLeave(fn: Leave): void { leaveSheet = fn; }

/** The live part of the stack, copied: what `announceLeaves` compares the moved stack against. */
export function stackView(): StackView {
  return { depth: routeStack.depth, keys: routeStack.keys.slice(0, routeStack.depth + 1) };
}

const isScreen = (k: string | undefined): k is string => !!k && k !== VACANT && screenOfKey(k) === k;

/** The screen entry on top of a view — read through steps and vacant slots. */
function topScreenOf(v: StackView): { d: number; k: string } | null {
  for (let d = v.depth; d >= 0; d--) { const k = v.keys[d]; if (isScreen(k)) return { d, k }; }
  return null;
}

/** Pure: each sheet that left between `before` and `after`, once, top first; a close beats a cover. */
export function sheetLeaves(before: StackView, after: StackView): Array<{ sheet: string; reason: LeaveReason }> {
  const top = topScreenOf(after);
  const onTop = top ? overlayFromKey(top.k) : null;
  const wasTop = topScreenOf(before);
  const out = new Map<string, LeaveReason>();
  for (let d = before.depth; d >= 0; d--) {
    const k = before.keys[d];
    if (!isScreen(k)) continue;
    const sheet = overlayFromKey(k);
    if (!sheet || sheet === onTop) continue;
    const stays = d <= after.depth && after.keys[d] === k;
    if (!stays) out.set(sheet, "close");
    else if (wasTop?.d === d && top?.d !== d && !out.has(sheet)) out.set(sheet, "cover");
  }
  return [...out].map(([sheet, reason]) => ({ sheet, reason }));
}

/** The route layer moved the stack from `before`: tell every sheet that left it. */
export function announceLeaves(before: StackView): void {
  for (const { sheet, reason } of sheetLeaves(before, stackView())) leaveSheet(sheet, reason);
}

/** A tap re-opened the entry at `depth` itself: what it carries now wins. */
export function forgetKept(depth: number): void { kept.delete(depth); }

/** A pop landed on `key` at `depth`: put back what that sheet showed when it was covered. */
export function restoreKept(depth: number, key: string | null): void {
  const k = kept.get(depth);
  for (const d of [...kept.keys()]) if (d >= depth) kept.delete(d);
  if (k && k.key === key) k.restore();
}

/**
 * **What a screen was opened ON is part of its route entry** — the git view's
 * repo and tapped failure. It lived in App state and a module slot BESIDE the
 * route, so a Back (popstate) neither restored nor cleared it: Back off the git
 * view kept the repo, and the toolbar's "diff" (a bare open) re-opened the
 * PREVIOUSLY viewed repo on its old failure (bughunt 2026-10-29, review A3d).
 *
 * A tap says what it opens on (`openOn`), the routing effect files that with
 * the entry it lands on (`routeLanded`), and a pop reads it back from the entry
 * it lands on. `screenParams` is the one read: a VIEW of the entry on screen.
 * Nothing else holds it — memory (`held`) and the entry's own `history.state`, kept equal
 * (`syncEntryState`), so it survives a reload.
 */
export type ScreenParams = Readonly<Record<string, string | null>>;
type Opened = { overlay: string; params: ScreenParams };
/** By depth: what the entry was opened on — `null` is a FRESH entry that holds nothing, which
 *  is not the same as absent (memory knows nothing: a reload, so `history.state` is read). */
const held = new Map<number, { key: string; params: Opened | null }>();
let shown: Opened | null = null;
let asked: Opened | null = null;
let asks = 0;
const paramSubs = new Set<() => void>();
const emitParams = (): void => { for (const fn of paramSubs) fn(); };

/** A tap opens (or re-targets) `overlay` ON `params`. Shown at once; filed with the entry
 *  the routing effect lands on next. */
export function openOn(overlay: string, params: ScreenParams): void {
  asked = shown = { overlay, params };
  asks++;
  emitParams();
}

/** What the screen on top was opened on, when it is `overlay` — else null. A stable object. */
export function screenParams(overlay: string): ScreenParams | null {
  return shown?.overlay === overlay ? shown.params : null;
}

export function subscribeScreenParams(fn: () => void): () => void {
  paramSubs.add(fn);
  return () => { paramSubs.delete(fn); };
}

/** Bumped by every `openOn`: the routing effect re-runs on it, so a re-target of a screen
 *  already on top (no route change) is filed with that screen's entry too. */
export function screenAsks(): number { return asks; }

/**
 * The route landed on `key` at `depth`:
 * - `push` — a NEW entry: it holds what the tap asked for, or nothing (a bare open).
 * - `open` — a tap named an entry below and the route unwound to it: a FRESH open, so it
 *   holds what the tap asked for, or nothing. Never a return — a return is a close
 *   (`returnVerb`), whose pop reads the entry back.
 * - `stay` — the entry on top is the one landed on, nothing moved (a re-target, the
 *   effect's echo of a pop): it takes what the tap asked for, else keeps its own.
 * - `return` — a pop or a close: the entry is read back, nothing is filed.
 * A step over a screen (`useBackStep`) is read through to the screen under it.
 */
export type Landed = "push" | "open" | "stay" | "return";
export function routeLanded(depth: number, key: string, how: Landed): void {
  let d = depth;
  let k = key;
  while (d > 0 && (k === VACANT || k !== screenOfKey(k))) { d--; k = routeStack.keys[d] ?? ""; }
  const want = asked && asked.overlay === overlayFromKey(k) ? asked : null;
  if (how === "push") {
    for (const x of [...held.keys()]) if (x >= d) held.delete(x);
    held.set(d, { key: k, params: want });
  } else if (how === "open") held.set(d, { key: k, params: want });
  else if (how === "stay" && want) held.set(d, { key: k, params: want });
  asked = null;
  syncEntryState(d, k);
  const h = held.get(d);
  const next = h && h.key === k ? h.params : null;
  if (next === shown) return;
  shown = next;
  emitParams();
}

/**
 * **The entry's params live in its own `history.state`** (`navParams`), so a reload — which
 * keeps `history.state` and drops this module — comes back on the repo and failure the screen
 * was opened on, not the session's (review R2-2 a). `held` is the cache: what memory decided
 * is written into the entry; an entry memory knows nothing about is read from it. Only when
 * the browser's current entry IS the one landed on — an unwind's entry is reached on its
 * popstate, and its `return` lands here again.
 */
function syncEntryState(d: number, k: string): void {
  if (typeof history === "undefined") return;
  const st = history.state as { navRoute?: string; navDepth?: number; navParams?: Opened } | null;
  if (!st || st.navRoute !== k || (st.navDepth || 0) !== d) return;
  const h = held.get(d);
  if (h && h.key === k) {
    if (sameOpened(st.navParams ?? null, h.params)) return;
    const { navParams: _old, ...rest } = st;
    history.replaceState(h.params ? { ...rest, navParams: h.params } : rest, "");
    return;
  }
  const p = carriedFor(st, k);
  if (p) held.set(d, { key: k, params: p });
}

/** The params `st` carries for screen `k` — its own entry's, or a step's copy — when well-formed. */
function carriedFor(st: { navRoute?: string; navParams?: Opened } | null, k: string): Opened | null {
  if (!st || typeof st.navRoute !== "string" || screenOfKey(st.navRoute) !== k) return null;
  const p = st.navParams;
  return p && typeof p.overlay === "string" && p.overlay === overlayFromKey(k) && p.params && typeof p.params === "object"
    ? { overlay: p.overlay, params: p.params } : null;
}

/**
 * A document booting on `key` with nothing of ours under it is SEEDED (`seedRouteStack`), which
 * replaces the entry it booted on. What that entry carried for the screen — its own params, or a
 * step's copy of them — is taken as the ask the seeded entry files (`routeLanded` push), so a
 * reload with a step on top keeps the git view's repo (review R2-2b M1). Call before seeding.
 */
export function adoptCarried(key: string): void {
  if (typeof history === "undefined") return;
  const p = carriedFor(history.state as { navRoute?: string; navParams?: Opened } | null, key);
  if (p) asked = p;
}

function sameOpened(a: Opened | null, b: Opened | null): boolean {
  if (!a || !b) return a === b;
  if (a.overlay !== b.overlay) return false;
  const ka = Object.keys(a.params), kb = Object.keys(b.params);
  return ka.length === kb.length && ka.every((x) => a.params[x] === b.params[x]);
}

/**
 * Whether ONE close of the screen on top lands on sheet `o` — the screen it covered.
 *
 * A screen that REPLACED a sheet (the annotator over the backlog) returns to it. Through
 * `nav.open(o)` that return unwound onto the sheet's own key, which the routing effect takes
 * for a FRESH open and forgets the sheet's kept stores: the backlog came back with all its
 * rows and no search (bughunt 2026-10-29, review E2). When this is true the caller closes
 * itself instead — the same `routeStep` decision and the same pop as Back, so `restoreKept`
 * puts the sheet back as it was left.
 */
export function closeLandsOn(o: Overlay): boolean {
  if (!o) return false;
  let top = routeStack.depth;
  while (top > 0 && (routeStack.keys[top] === VACANT || routeStack.keys[top] !== screenOfKey(routeStack.keys[top] ?? ""))) top--;
  const cur = routeStack.keys[top];
  if (!cur || !overlayFromKey(cur)) return false;
  const [a, , r] = cur.split("|");
  const step = routeStep(routeStack.keys, routeStack.depth, routeKey(a || null, null, r || null));
  if (step.kind !== "go") return false;
  const landed = routeStack.keys[routeStack.depth + step.delta];
  return !!landed && overlayFromKey(landed) === o;
}

/**
 * **A RETURN is its own verb, never an open** (review R2-2 d). Going back to sheet `o` — the
 * one the screen on top (`top`) covered — is a CLOSE when one close lands on it: the pop
 * restores its kept stores (`restoreKept`) and what it was opened on (`routeLanded` return).
 * An open of a sheet below is a FRESH open and keeps neither. Only when nothing of `o` is
 * under the top (a reload rebuilt the stack) is it opened. `null` closes the top.
 */
export function returnVerb(o: Overlay, top: Overlay): "close" | "open" | null {
  if (o) return top && closeLandsOn(o) ? "close" : "open";
  return top ? "close" : null;
}

/** A pending screen taken over by the session its create made (`adoptPendingSession`). */
export type Adoption = { from: string; to: string };
let adoption: Adoption | null = null;
/** Said by `adoptPendingSession` just before it moves the screen: the next landing renames, never pushes. */
export function noteAdoption(from: string, to: string): void { adoption = { from, to }; }
/** The adoption the next landing may consume — read once, so a later tap is never taken for one. */
export function takeAdoption(): Adoption | null { const a = adoption; adoption = null; return a; }
/** Whether moving from entry `top` to `key` is exactly that adoption: same sheet, same focus, pending id → session id. */
export function isAdoption(top: string | undefined, key: string, a: Adoption): boolean {
  if (!top) return false;
  const [ta, to, tr] = top.split("|");
  const [ka, ko, kr] = key.split("|");
  return ta === a.from && ka === a.to && to === ko && tr === kr;
}

/**
 * What the routing effect does when the route becomes `key`, and what it FILES with the entry it
 * lands on (`routeLanded`'s `how`) — one pure decision, node-tested, so no branch's filing can
 * be dropped with every test green (review R2-2 e). `known` is `history.state`'s depth when it
 * names `key`, else -1. The effect applies the moves; the entry landed on is always the one at
 * `routeStack.depth` afterwards.
 * - `seed` — a document booting on a screen with nothing of ours under it: ancestors invented.
 * - `known` — our own entry (a reload, the effect's echo of a pop): keeps what it holds.
 * - `stay` — the entry on top again (a re-target): files the ask with it (ML1).
 * - `go` — unwind to an entry below: the very screen the tap named is a FRESH open and forgets
 *   its kept stores; one below it (a close, a leave) is a return.
 * - `push` — a new entry over the top. `vacate`: the depth of a screen that is finished but has a step still over
 *   it (a spent sheet under the hint card whose "do it" was Start). It cannot be replaced from above, so it
 *   and its steps go vacant and Back passes them.
 * - `replace` — a new entry IN PLACE of a spent sheet's (`SPENT_ON_LEAVE`).
 * - `rename` — the pending screen became its session (`noteAdoption`): same entry, the session's key. `under`: its
 *   depth, when something is still drawn over it (an open picker, which stays open: `renameUnder`).
 */
export type Landing =
  | { kind: "seed"; how: "push" }
  | { kind: "known"; depth: number; how: "stay" }
  | { kind: "stay"; how: "stay" }
  | { kind: "go"; delta: number; forget: boolean; how: "open" | "return" }
  | { kind: "push"; how: "push"; vacate?: number }
  | { kind: "rename"; how: "stay"; under?: number }
  | { kind: "replace"; how: "push" };
export function routeLanding(keys: readonly (string | undefined)[], depth: number, key: string, first: boolean, known: number, adopt: Adoption | null = null): Landing {
  if (first && known <= 0) return { kind: "seed", how: "push" };
  if (known >= 0) return { kind: "known", depth: known, how: "stay" };
  // The pending screen BECOMING its session is one screen, not two: its entry is renamed in place.
  // Pushed, Back from the new session landed on the dead pending entry, and the next Back on
  // whatever was under it — two presses to get back to the Setup check a prompt was started from.
  if (adopt && isAdoption(keys[depth], key, adopt)) return { kind: "rename", how: "stay" };
  const step = routeStep(keys, depth, key);
  if (step.kind === "stay") return { kind: "stay", how: "stay" };
  if (step.kind === "go") {
    const fresh = (keys[depth + step.delta] ?? "") === key;
    return { kind: "go", delta: step.delta, forget: fresh, how: fresh ? "open" : "return" };
  }
  // A bare screen leaving a SPENT sheet (the session a Send sheet's Start opened) takes its entry (`SPENT_ON_LEAVE`).
  const top = keys[depth];
  if (depth > 0 && top && top === screenOfKey(top) && SPENT_ON_LEAVE.has(top.split("|")[1] ?? "") && !key.split("|")[1]) return { kind: "replace", how: "push" };
  let under = depth;
  while (under > 0 && (keys[under] === VACANT || (keys[under] !== undefined && keys[under] !== screenOfKey(keys[under]!)))) under--;
  const over = under > 0 && under < depth ? keys[under] ?? "" : "";
  const spent = !key.split("|")[1] && SPENT_ON_LEAVE.has(over.split("|")[1] ?? "");
  if (adopt && isAdoption(over, key, adopt)) return { kind: "rename", how: "stay", under };
  return { kind: "push", how: "push", ...(spent ? { vacate: under } : {}) };
}
