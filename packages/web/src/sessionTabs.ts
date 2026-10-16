/**
 * **The session-tab strip: what is on it, in what order, and how often you open
 * each one.**
 *
 * The third always-on bar, under the connection strip and the local-runner one
 * (`NetPulseBar` / `LocalRtBar`), and it is their shape for their reason: `App`
 * returns early once per overlay, so a layer that has to exist on every screen
 * cannot live inside it. The strip is mounted beside `App` in `main.tsx`, which
 * means it can neither read `App`'s session list nor call its setters — hence
 * this module. One writer (`noteSessionTabs`, called from `App`'s own render
 * data), one subscription, and taps that leave as events `App` listens for.
 * `link.ts` and `localRt.ts` are the same arrangement; this one is deliberately
 * smaller, because it holds no history and measures nothing.
 *
 * **Why a tab strip at all.** Switching sessions meant Back to the launcher,
 * finding the row in a list grouped by repo, and tapping it — three gestures
 * and a scroll to answer "what was the other thing I had open". The strip makes
 * that one tap from wherever you are, and it is the only surface in the app
 * where sessions sit side by side rather than in a column.
 *
 * **Everything here is per device** (`storage.ts`'s `sessionTabs*`), which is
 * `waterplane.netPulse`'s argument and one step plainer: HOW MANY tabs fit is a
 * measurement of the screen in your hand, and a phone's four carried onto a
 * desktop tab is four labels stretched over 1200 px. The open counts are per
 * device for a second reason — they are a record of taps on one screen, and a
 * synced counter is one two devices race to increment.
 *
 * The pure half is here and node-tested (`sessionTabs.test.mjs`); the drawing
 * is `SessionTabsBar.tsx`.
 */
import { useEffect, useRef, useState } from "react";
import { glueCompanions, trimDefaultBranch } from "@waterplane/shared";
// Type-only, so `node --test` running straight over this file never has to load
// a `.tsx`: what a tab's state IS belongs to `sessionFacts.tsx` and may not be
// a second opinion held here.
import type { SessionStatus } from "./sessionFacts";
import { LS, lsBool, lsGet, lsJson, lsNum, lsSet, lsSetBool, lsSetJson } from "./storage.ts";

// ── What a tab is ────────────────────────────────────────────────────────────

/** One tab, as `App` publishes it. Everything the strip draws and nothing else. */
export interface SessionTab {
  id: string;
  /** A companion shell's parent (`SessionInfo.companionOf`): drawn right after it. */
  companionOf?: string;
  /** The ≤3-word name the host derived, or the session's own `title`. */
  label: string;
  /** Repo name — the strip's colour comes from this (`format.ts`'s `repoHue`). */
  repo: string;
  /**
   * What the session is DOING — `sessionFacts.tsx`'s `sessionStatus()`, which
   * is the ONE definition the row badge, the per-repo roll-up and the status
   * filter already share.
   *
   * It was two booleans of the strip's own (`running` plus a bare `turnActive`)
   * and that is precisely how a tab came to disagree with the row it stands
   * for: a session blocked on a question and a session at the usage limit both
   * drew as plain idle, and so did one whose main loop had stopped while two
   * background agents kept working — the case `sessionStatus` exists to get
   * right. A fourth copy of that ladder was never going to stay in step with
   * the three that are one.
   */
  status: SessionStatus;
  /** When the session was created — the "open sequence" order, and the tie-break. */
  createdAt: number;
}

/**
 * A FILE pinned to the strip from the file viewer's header (`FilesSheet.tsx`).
 *
 * Not a session and drawn as not one: a file icon in the slot where a
 * session's state mark goes, in its repo's colour. Ordered WITH the sessions,
 * by the same order (`mergeStrip`) — the owner's ask: a pin kept apart at the
 * strip's far end, past the "+N", was a tab nobody scrolled to. A tap opens
 * the file viewer straight on it; its × unpins, which loses nothing — the file
 * is where it was, and the viewer's pin button puts it back.
 */
export interface FileTab {
  repoId: string;
  /** Repo name — the colour, exactly as a session tab's. */
  repo: string;
  /** Worktree-relative path. */
  path: string;
  /** Epoch ms it was pinned — its place in the `open` order, as `createdAt`
   *  is a session's. Absent on a pin stored before this existed, which reads
   *  as longest-ago (the same rule as a migrated open count). */
  at?: number;
}

/** One key per pinned file: the same path in two repos is two tabs. */
export const fileTabKey = (f: { repoId: string; path: string }): string => `${f.repoId}:${f.path}`;

/** A pinned file's row in the opens store, beside the session ids — prefixed
 *  so it can never collide with one. */
export const fileOpenKey = (f: { repoId: string; path: string }): string => `file:${fileTabKey(f)}`;

/** What a file tab wears: the file's own name — the path is in its title. */
export const fileTabLabel = (path: string): string => path.split("/").pop() || path;

/** The stored list, with junk dropped and duplicates folded to the first pin. */
export function cleanFileTabs(raw: unknown): FileTab[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: FileTab[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const { repoId, repo, path, at } = r as Partial<FileTab>;
    if (typeof repoId !== "string" || !repoId || typeof path !== "string" || !path) continue;
    const k = fileTabKey({ repoId, path });
    if (seen.has(k)) continue;
    seen.add(k);
    const f: FileTab = { repoId, repo: typeof repo === "string" ? repo : "", path };
    if (typeof at === "number" && Number.isFinite(at) && at > 0) f.at = at;
    out.push(f);
  }
  return out;
}

/** Pin (appended, so a new pin lands at the end) or unpin. Never in place. */
export function setPinned(list: readonly FileTab[], f: FileTab, on: boolean): FileTab[] {
  const k = fileTabKey(f);
  const rest = list.filter((x) => fileTabKey(x) !== k);
  return on ? [...rest, f] : rest;
}

/** How the tabs are laid out left to right. */
export type TabOrder = "open" | "frequent" | "recent";

export const TAB_ORDERS: readonly TabOrder[] = ["open", "frequent", "recent"];

/** What each order is called where a person chooses it, and what it promises. */
export const TAB_ORDER_LABEL: Record<TabOrder, string> = {
  open: "in the order opened",
  frequent: "most opened first",
  recent: "last opened first",
};

/**
 * How many tabs may be asked to fit at once — each tab's FLOOR, `1/N` of the
 * strip (`.stab`'s `min-width`). Fewer open than that, a tab grows to its whole
 * name; N or more, they are N equal tabs and the rest scroll.
 *
 * Two is the floor because one tab is not a strip — it is a title bar that
 * costs a row of screen. Eight is the ceiling because the label is what a tab
 * is FOR: at eight across a 360 px phone a tab is 45 px, which is three
 * characters and a close button, and a strip of unreadable tabs is furniture.
 * The number does not hide anything — everything past it is still there, one
 * horizontal scroll away.
 */
export const TAB_COUNT_MIN = 2;
export const TAB_COUNT_MAX = 8;
/**
 * Three, not four. Four was a guess at "how many fit"; three is what a name
 * worth reading needs — the labels are up to four words now, and at a quarter
 * of a 360 px phone a tab is ~85 px, which is one word and an ellipsis. The
 * number hides nothing either way (the rest scroll), so the default is set by
 * legibility rather than by capacity, and anyone who wants the capacity has the
 * setting.
 */
export const TAB_COUNT_DEFAULT = 3;

/** The strip's own height, published to every screen as `--ui-tabs-h`. Four
 *  more than the flat blocks it replaced: the tabs sit on a rail and the open
 *  one is three pixels taller than the rest, which is what makes it read as the
 *  front tab rather than merely the brightest — and "brightest" is also what a
 *  repo with a vivid hue looks like. Restated in `.sess-tabs`; the two are one
 *  number and `sessionTabs.test.mjs` is where they are held together. */
export const TAB_STRIP_H = 34;

/** What the strip publishes as `--ui-tabs-h`, in CSS px. Zero when it is not
 *  drawn: no sessions, or switched off. The wide workspace draws it too — it
 *  was hidden there once (decision O3: the sidebar already switches sessions),
 *  and the owner asked for it back: the strip is one click between the
 *  sessions in use, where the sidebar is a scroll through every repo. One
 *  function so the drawing and the padding every screen takes from it cannot
 *  disagree. */
export function tabStripHeight(enabled: boolean, anyTabs: boolean): number {
  // `anyTabs` counts pinned files too: a pin with no session open is still a
  // tab, and the strip that holds it must be drawn.
  return enabled && anyTabs ? TAB_STRIP_H : 0;
}

/**
 * How many tabs the strip DRAWS — unlike `count`, this one is a limit.
 *
 * Asked for by the owner: with twenty sessions open a sideways scroll is a
 * strip nobody reaches the end of, and in `recent` order the far end is by
 * construction the sessions you have not been in for longest. Ten by default;
 * the open session is always drawn even when it falls past the cut, and what
 * is cut is SAID at the end of the strip ("+N"), never silently dropped — every
 * session is still in the launcher.
 */
export const TAB_LIMIT_MIN = 2;
export const TAB_LIMIT_MAX = 50;
export const TAB_LIMIT_DEFAULT = 10;

// ── The pure half ────────────────────────────────────────────────────────────

/**
 * What this device remembers about each session being opened: how OFTEN, and
 * WHEN last. Two facts because they order the strip two different ways, and one
 * record because they are written by the same tap — a second store would be a
 * second thing to prune and a second thing to get out of step.
 *
 * The old shape was a bare number. `readOpens` migrates one rather than
 * dropping it: a count is the more expensive of the two to re-earn (it takes
 * weeks of use), and a migrated row simply has no last-opened instant until the
 * next time it is opened — `orderTabs` reads that as "longest ago", which is
 * true of a session nobody has touched since the upgrade.
 */
export interface TabOpen {
  /** Times opened from this device. */
  n: number;
  /** Epoch ms of the last open, or 0 when only a migrated count is known. */
  at: number;
}

export type TabOpens = Record<string, TabOpen>;

/** The stored shape, which may still be the pre-migration bare count. */
export type StoredOpens = Record<string, TabOpen | number>;

/** One stored entry, whatever shape it was written in. Junk reads as nothing. */
export function readOpen(raw: TabOpen | number | undefined): TabOpen | null {
  // A zero count is not a row — it orders nothing and is what a hand-edited or
  // half-written store looks like.
  if (typeof raw === "number") return Number.isFinite(raw) && raw > 0 ? { n: raw, at: 0 } : null;
  if (!raw || typeof raw !== "object") return null;
  const n = typeof raw.n === "number" && Number.isFinite(raw.n) ? raw.n : 0;
  const at = typeof raw.at === "number" && Number.isFinite(raw.at) ? raw.at : 0;
  return n || at ? { n, at } : null;
}

/** The whole store, migrated. */
export function migrateOpens(raw: StoredOpens): TabOpens {
  const out: TabOpens = {};
  for (const [id, v] of Object.entries(raw ?? {})) {
    const o = readOpen(v);
    if (o) out[id] = o;
  }
  return out;
}

export function clampTabLimit(n: unknown): number {
  const v = typeof n === "number" && Number.isFinite(n) ? Math.round(n) : TAB_LIMIT_DEFAULT;
  return Math.min(TAB_LIMIT_MAX, Math.max(TAB_LIMIT_MIN, v));
}

/**
 * The first `limit` of an ordered strip, plus how many were left off.
 *
 * The open session is never one of them: when it falls past the cut it takes
 * the last drawn slot, so the strip always says something about the screen you
 * are on. Order is otherwise untouched.
 */
export function limitTabs(ordered: readonly SessionTab[], limit: number, activeId: string | null): { shown: SessionTab[]; hidden: number } {
  if (ordered.length <= limit) return { shown: [...ordered], hidden: 0 };
  const shown = ordered.slice(0, limit);
  if (activeId && !shown.some((t) => t.id === activeId)) {
    const active = ordered.find((t) => t.id === activeId);
    if (active) shown[limit - 1] = active;
  }
  return { shown, hidden: ordered.length - shown.length };
}

export function clampTabCount(n: unknown): number {
  const v = typeof n === "number" && Number.isFinite(n) ? Math.round(n) : TAB_COUNT_DEFAULT;
  return Math.min(TAB_COUNT_MAX, Math.max(TAB_COUNT_MIN, v));
}

/** A stored order, or the default — `recent`, because "where was I" is what
 *  the owner reaches for the strip to answer, and with a limit on how many are
 *  drawn it is the order that keeps the sessions you are actually in on it. */
export const TAB_ORDER_DEFAULT: TabOrder = "recent";

export function cleanTabOrder(raw: unknown): TabOrder {
  return (TAB_ORDERS as readonly unknown[]).includes(raw) ? raw as TabOrder : TAB_ORDER_DEFAULT;
}

/**
 * The label a tab wears.
 *
 * `tabTitle` when the host has derived one, and the session's own `title`
 * otherwise — never a blank tab and never an invented name. The repo prefix is
 * dropped from the fallback because the tab is already COLOURED by its repo and
 * sits beside a header naming it: `myapp · main` in 90 px spends half the label
 * restating the stripe down its left edge. What is left is the branch, which is
 * the part that differs between two tabs of the same colour.
 *
 * The prefix comes off only when it is exactly this repo's — a title that is
 * one word, or that names something else, is passed through whole rather than
 * cut at the first separator it happens to contain.
 */
export function tabLabel(s: { tabTitle?: string; title: string }, repo: string): string {
  const derived = (s.tabTitle ?? "").trim();
  if (derived) return derived;
  // `myapp · main` is `myapp` before the prefix is looked for, or the strip spends
  // its 90 px on the word every primary checkout shares (`trimDefaultBranch`).
  const title = trimDefaultBranch(s.title);
  const prefix = `${repo} · `;
  if (repo && title.startsWith(prefix) && title.length > prefix.length) return title.slice(prefix.length);
  return title || repo || "session";
}

/**
 * The strip, left to right.
 *
 * Three orders, three different questions:
 *
 *  - `open` — the sequence they were started in. It never moves, so a tab's
 *    position is something you can learn and reach without reading it.
 *  - `frequent` — the ones you open most, on the left where the thumb is. Worth
 *    more than a stable position once the strip is longer than it is wide.
 *  - `recent` — the one you were last in, first. The other two are about a
 *    HABIT; this one is about the last ten minutes, which is what "where was I"
 *    actually asks. It is also the only order that moves under you — the tab
 *    you just left walks to the front. It is the default all the same, at the
 *    owner's ask: with a cap on how many are drawn, it is what keeps the
 *    sessions you are in on the strip.
 *
 * **The tie-break is always the open sequence**, under all three: two sessions
 * with the same count (or the same unknown instant) would otherwise swap places
 * on every publish depending on nothing but object order, and a tab that moves
 * when nothing has changed is the failure this whole strip is trying to avoid.
 * A sort on a copy, never in place — the caller's array is `App`'s render data.
 */
export function orderTabs(tabs: readonly SessionTab[], order: TabOrder, opens: TabOpens): SessionTab[] {
  const cmp = rankCmp(order, opens);
  return [...tabs].sort((a, b) => cmp({ key: a.id, createdAt: a.createdAt }, { key: b.id, createdAt: b.createdAt }));
}

/** One comparator per order, over anything with an opens key and a start
 *  instant — so a session and a pinned file are ranked by ONE rule. */
type Ranked = { key: string; createdAt: number };
function rankCmp(order: TabOrder, opens: TabOpens): (a: Ranked, b: Ranked) => number {
  const seq = (a: Ranked, b: Ranked) => a.createdAt - b.createdAt;
  if (order === "open") return seq;
  if (order === "recent") return (a, b) => (opens[b.key]?.at ?? 0) - (opens[a.key]?.at ?? 0) || seq(a, b);
  return (a, b) => (opens[b.key]?.n ?? 0) - (opens[a.key]?.n ?? 0) || seq(a, b);
}

/** One drawn tab: a session or a pinned file. */
export type StripTab = { kind: "session"; tab: SessionTab } | { kind: "file"; file: FileTab };

/**
 * The pinned files sorted IN among the sessions, by the strip's own order.
 *
 * `sessions` is already ordered, glued and cut to the limit; the files are
 * ranked by the same comparator (a file's opens row is `fileOpenKey`, its start
 * is when it was pinned) and merged in, ties going to the session. Two things
 * the merge will not do: put a file between a session and the companion shell
 * glued after it, or let the limit cut a file — each pin is there because a
 * person put it there, so the limit stays a count of SESSIONS.
 */
export function mergeStrip(sessions: readonly SessionTab[], files: readonly FileTab[], order: TabOrder, opens: TabOpens): StripTab[] {
  const cmp = rankCmp(order, opens);
  const fs = files
    .map((f) => ({ f, r: { key: fileOpenKey(f), createdAt: f.at ?? 0 } }))
    .sort((a, b) => cmp(a.r, b.r));
  const ids = new Set(sessions.map((t) => t.id));
  const out: StripTab[] = [];
  let j = 0;
  for (const t of sessions) {
    const glued = !!t.companionOf && t.companionOf !== t.id && ids.has(t.companionOf);
    if (!glued) {
      const r = { key: t.id, createdAt: t.createdAt };
      while (j < fs.length && cmp(fs[j].r, r) < 0) out.push({ kind: "file", file: fs[j++].f });
    }
    out.push({ kind: "session", tab: t });
  }
  while (j < fs.length) out.push({ kind: "file", file: fs[j++].f });
  return out;
}

/** One more open of this session, on this device — the count and the instant. */
export function bumpOpen(opens: TabOpens, id: string, now: number): TabOpens {
  return { ...opens, [id]: { n: (opens[id]?.n ?? 0) + 1, at: now } };
}

/**
 * The counts, minus the sessions that no longer exist.
 *
 * A count kept for an archived conversation orders nothing and never will, and
 * this store is written on every publish — so it is pruned there rather than
 * swept on a timer. Only prunes against a NON-EMPTY list: an empty session list
 * is what this app looks like for the first second after a cold start and
 * through every dead tunnel, and deleting a device's whole ordering history
 * because the socket has not answered yet is a loss with no way back.
 */
export function pruneOpens(opens: TabOpens, liveIds: readonly string[], keep: readonly string[] = []): TabOpens {
  // `keep` (the pinned files' rows) never counts as the list being non-empty:
  // a pin is not evidence the socket has answered.
  if (!liveIds.length) return opens;
  const live = new Set([...liveIds, ...keep]);
  const out: TabOpens = {};
  for (const [id, n] of Object.entries(opens)) if (live.has(id)) out[id] = n;
  return out;
}

/** What the confirm asks before a tab's × closes a session. */
export function tabCloseAsk(label: string, running: boolean): { title: string; lines: string[]; confirmLabel: string } {
  return {
    title: running ? `Close “${label}”?` : `Remove “${label}”?`,
    lines: [
      running
        ? "The CLI process ends and the tab goes. The conversation itself is kept — reopen it under “Recently closed”, or in Archive."
        : "The row goes off the list. The conversation itself is kept — it is in Archive.",
    ],
    confirmLabel: running ? "Close" : "Remove",
  };
}

// ── The settings, per device ─────────────────────────────────────────────────

export const tabsEnabled = (): boolean => lsBool(LS.sessionTabs, true);
export const tabsCount = (): number => clampTabCount(lsNum(LS.sessionTabsCount, TAB_COUNT_DEFAULT));
export const tabsOrder = (): TabOrder => cleanTabOrder(lsGet(LS.sessionTabsOrder));
export const tabsLimit = (): number => clampTabLimit(lsNum(LS.sessionTabsLimit, TAB_LIMIT_DEFAULT));

export function setTabsEnabled(on: boolean): void { lsSetBool(LS.sessionTabs, on); emit(); }
export function setTabsCount(n: number): void { lsSet(LS.sessionTabsCount, String(clampTabCount(n))); emit(); }
export function setTabsOrder(o: TabOrder): void { lsSet(LS.sessionTabsOrder, o); emit(); }
export function setTabsLimit(n: number): void { lsSet(LS.sessionTabsLimit, String(clampTabLimit(n))); emit(); }

const readFiles = (): FileTab[] => cleanFileTabs(lsJson<unknown>(LS.tabFiles, []));

export const isFilePinned = (repoId: string, path: string): boolean =>
  readFiles().some((f) => fileTabKey(f) === fileTabKey({ repoId, path }));

/** Pin or unpin a file, written straight through — the viewer's pin button. */
export function setFilePinned(f: FileTab, on: boolean, now = Date.now()): void {
  lsSetJson(LS.tabFiles, setPinned(readFiles(), on ? { ...f, at: f.at ?? now } : f, on));
  emit();
}

/** Which pinned file is on screen (`fileTabKey`), or null — the file viewer
 *  says so while it shows one, so that tab, not the session under it, is the
 *  front one. */
export function noteFileOnScreen(key: string | null, now = Date.now()): void {
  if (fileActive === key) return;
  fileActive = key;
  // Being looked at is an open, exactly as a session's attach is — so a file
  // moves in `recent`/`frequent` by the same rule. Unpinned files' rows are
  // pruned on the next publish.
  if (key) lsSetJson(LS.tabOpens, bumpOpen(readOpens(), `file:${key}`, now));
  emit();
}

const readOpens = (): TabOpens => migrateOpens(lsJson<StoredOpens>(LS.tabOpens, {}));

/**
 * Which session just CAME ON SCREEN and is owed an open, or null.
 *
 * Counted off the published active id rather than in `attach`, because not
 * every route onto a session goes through `attach`: Back and forward, a typed
 * hash, the host's `session.focus`, a session this phone created, a queued
 * create adopting its real id and the cold start's restored route all set the
 * active id directly — and a session reached only those ways never moved in
 * `recent`, sitting at the far end of "last opened first" while on screen.
 * Only a LIVE session is counted (a pending lane's id is not one; its real id
 * is counted when it arrives), once per arrival: `counted` is the id last
 * counted, cleared when nothing is on screen, so leaving and coming back is a
 * second open and a re-publish of the same screen is not.
 */
export function openOwed(counted: string | null, active: string | null, liveIds: readonly string[]): string | null {
  if (!active || active === counted) return null;
  return liveIds.includes(active) ? active : null;
}

// ── The store ────────────────────────────────────────────────────────────────

export interface TabsSnapshot {
  enabled: boolean;
  count: number;
  order: TabOrder;
  /** Already ordered and cut to the limit — the strip draws what it is given
   *  and decides nothing. */
  tabs: SessionTab[];
  /** How many sessions the limit left off the strip. */
  hidden: number;
  activeId: string | null;
  /** Pinned files, in the order pinned — never cut by the limit: each one is
   *  there because a person put it there. */
  files: FileTab[];
  /** What is drawn, left to right: `tabs` with `files` merged in by the same
   *  order (`mergeStrip`). */
  strip: StripTab[];
  /** `fileTabKey` of the file on screen, whether or not it is pinned. */
  fileActive: string | null;
}

let tabs: SessionTab[] = [];
let activeId: string | null = null;
let fileActive: string | null = null;
/** The session `openOwed` last counted — see there. */
let counted: string | null = null;
let snap: TabsSnapshot = { enabled: false, count: TAB_COUNT_DEFAULT, order: TAB_ORDER_DEFAULT, tabs: [], hidden: 0, activeId: null, files: [], strip: [], fileActive: null };
const listeners = new Set<(s: TabsSnapshot) => void>();

function rebuild(): void {
  const order = tabsOrder();
  const opens = readOpens();
  const { shown, hidden } = limitTabs(glueCompanions(orderTabs(tabs, order, opens)), tabsLimit(), activeId);
  const files = readFiles();
  snap = {
    enabled: tabsEnabled(),
    count: tabsCount(),
    order,
    tabs: shown,
    hidden,
    activeId,
    files,
    strip: mergeStrip(shown, files, order, opens),
    fileActive,
  };
}

function emit(): void {
  rebuild();
  for (const fn of listeners) fn(snap);
}

/**
 * **The one writer.** `App` publishes the sessions it is already rendering and
 * which one is open; everything else here derives from that.
 *
 * The counts are pruned on the way through (`pruneOpens`), which is why this is
 * the only place that needs to know a session went away — there is no second
 * listener watching the session list for removals.
 */
export function noteSessionTabs(next: readonly SessionTab[], active: string | null): void {
  tabs = [...next];
  activeId = active;
  const ids = tabs.map((t) => t.id);
  const opens = readOpens();
  const pruned = pruneOpens(opens, ids, readFiles().map(fileOpenKey));
  const owed = openOwed(counted, active, ids);
  if (!active) counted = null;
  if (owed) { counted = owed; lsSetJson(LS.tabOpens, bumpOpen(pruned, owed, Date.now())); }
  else if (Object.keys(pruned).length !== Object.keys(opens).length) lsSetJson(LS.tabOpens, pruned);
  emit();
}

export function subscribeTabs(fn: (s: TabsSnapshot) => void): () => void {
  listeners.add(fn);
  fn(snap);
  return () => { listeners.delete(fn); };
}

/** `useLink`'s shape: select, compare by identity, re-render only on a change. */
export function useSessionTabs<T>(select: (s: TabsSnapshot) => T): T {
  const sel = useRef(select);
  sel.current = select;
  const [v, setV] = useState<T>(() => select(snap));
  useEffect(() => subscribeTabs((s) => {
    const next = sel.current(s);
    setV((prev) => (Object.is(prev, next) ? prev : next));
  }), []);
  return v;
}

// ── What a tap says, since the strip cannot call `App` ───────────────────────

export const TAB_ATTACH_EVENT = "app:tab-attach";
export const TAB_CLOSE_EVENT = "app:tab-close";
/** A pinned file's tap: `features/images` opens the viewer on it. */
export const TAB_FILE_EVENT = "app:tab-file";

function say(name: string, id: string): void {
  try { window.dispatchEvent(new CustomEvent(name, { detail: { id } })); } catch { /* no DOM */ }
}

export const askTabAttach = (id: string): void => say(TAB_ATTACH_EVENT, id);
export const askTabClose = (id: string): void => say(TAB_CLOSE_EVENT, id);
export function askTabFile(f: FileTab): void {
  try { window.dispatchEvent(new CustomEvent(TAB_FILE_EVENT, { detail: f })); } catch { /* no DOM */ }
}

rebuild();
