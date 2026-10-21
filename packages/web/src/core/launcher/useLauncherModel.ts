/**
 * The launcher's state and everything it derives — the list, its cuts, the
 * roll-ups on every header and the counts on every chip.
 *
 * **The launcher-only state lives in module STORES, not in `useState`.** The
 * screen unmounts under every sheet (`overlayViews` returns early) and while a
 * session is open, and every one of these was App state that survived both: a
 * status filter set, a sheet opened from the filtered list, Back — and the
 * filter must still be there. In-memory, like the `useState` it replaces, so a
 * reload still clears the ephemeral ones (the status filter's whole rule).
 * The persisted ones load from and write to the same `localStorage` keys.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { ExternalSession, Intent, RepoTarget, SessionInfo } from "@waterplane/shared";
import { HORIZON_LABEL, horizonLead, horizonWords } from "@waterplane/shared";
import { createStore, useStore, type Store } from "../../sdk";
import { COLLAPSED_REPOS_KEY, SESSION_DRAG_MS, SESSION_ORDER_KEY, loadCollapsedRepos, loadSessionOrder } from "../../localState";
import { matchesFilterKind, resumeIdOf, sessionStatus, type SessionFilter } from "../../sessionFacts";
import { anyScheduledReply, scheduledRepliesBySession } from "../../scheduledReply";
import { clocksByRepo } from "../../clockCuts";
import { baseName } from "../../format";
import { isNativeShell } from "../../hostUrl";
import { api } from "../../api";
import { track } from "../../usage";
import { usePref } from "../prefs";
import { LS, lsBool, lsDel, lsSetJson } from "../../storage";
import { useClocks } from "../../features/schedule";
import { useActivityConfirmedDone, useActivityFiled } from "../../features/activity";
import { pullSummary, usePullRecords } from "../../features/pull";
import { autoPull } from "../../pull";
import { stripRows } from "../../downloadState";
import { appRows, buildsOf, NO_INSTALL, readyApps } from "../../installPolicy";
import type { LauncherProps } from "./types";
import {
  type StatusFilter, dragOrder, filterSessions, matchesText, nextSessionOrder, openCountByRepo, queuedKeysByRepo, repoGroupsOf,
  repoOfCwd, rollupByRepo, rollupTotal, sessionRepoLabelIn, sessionRepoNameIn, sessionRowBranchIn, sessionRowTitleIn,
  sessionNumbersOf, sortSessions, starredByRepoOf,
} from "./model";
import { flaggedByRepoOf, flaggedTotalOf } from "../sessions/followUpFacts";

// ── The stores ─────────────────────────────────────────────────────────────
// Every status badge in the launcher is a FILTER, because every one of them is
// already a count of rows and the rows are what you are after: with eleven
// sessions across four repos, "2 waiting" on a header was a fact you then had
// to go and find by hand, scrolling past nine rows that are not it.
const statusFilterStore = createStore<StatusFilter<SessionFilter> | null>(null);
/** The always-visible quick filter's words (`matchesText`). Per page, never stored. */
const textQueryStore = createStore<string>("");
const collapsedStore = createStore<Set<string>>(loadCollapsedRepos());
const orderStore = createStore<string[]>(loadSessionOrder());
/** Which list is showing: this app's sessions, or `claude` processes outside it. */
const tabStore = createStore<"home" | "external">("home");
const externalStore = createStore<ExternalSession[]>([]);
// Repo row overflow menu (the "⋯" line). Only one row is open at a time —
// a phone row is ~360px wide and six always-on 48px actions left the repo
// name ~90px, so all but the two most-used actions live behind this.
const repoMenuStore = createStore<string | null>(null);
// The launcher topbar's overflow menu. Nine chips (explain, new, pad,
// activity, search, files, archive, decision log, sent) took three wrapped rows
// before the first repo, so the launcher opened on its own header. They are
// NAVIGATION — one tap into a sheet — and the readings that must stay
// unprompted (usage, CLI health, notifications, the no-approvals warning)
// deliberately do NOT move in here: a chip that has to be discovered is not a
// mark. The counts that lived on the moved chips ride on the burger, or they
// would be invisible while it is closed.
const navMenuStore = createStore(false);
const showHiddenStore = createStore(false);
/** Launcher screenshot: choose which repo stores the capture. Opened from
 *  Settings (`openShotPick`), drawn on the launcher underneath it. */
const shotPickStore = createStore(false);
// Open the close sheet; value = "*" (all listed sessions) or a repo name, null = closed.
const closeAllPickStore = createStore<string | null>(null);
// The old dialog's custom-cutoff number and its quiet/open clock toggle are
// retired — `CloseSheet.tsx` offers fixed idle-for/open-for edges as two
// INDEPENDENT facets instead of one number behind one clock switch. Read once
// so a value from an older build does not linger forever with nothing left
// to read it.
lsDel(LS.closeCustomH);
lsDel(LS.closeBy);
/**
 * Whether a bulk close spares the starred sessions — see `LS.closeKeepStar`.
 *
 * It is a SCOPE, not a cut: every button in that dialog, "All" included,
 * counts and closes the same list, so the star cannot protect a session from
 * one tap and lose it to the next one along.
 */
const closeKeepStarStore = createStore<boolean>(lsBool(LS.closeKeepStar, true));
/** The list's last scrollTop — survives the unmount while a session or a sheet is open. */
export const launcherScroll = { top: 0 };

/** Settings → "screenshot": ask which repo the capture goes into, on the launcher. */
export function openShotPick(): void { shotPickStore.set(true); }

/** `[value, set]` over a store — `useState`'s shape, so call sites read the same. */
function useSlot<T>(s: Store<T>) {
  return [useStore(s), s.set] as const;
}

export function useLauncherModel(p: LauncherProps) {
  const { sessions, recent, closed, repos, intents, outbox, nowTick } = p;
  const { hiddenRepoPaths, cwdInFocus, visibleRepos, hiddenRepos } = p.view;
  const { focusRepo, setFocusRepo } = p.route;

  const [statusFilter, setStatusFilter] = useSlot(statusFilterStore);
  const [textQuery, setTextQuery] = useSlot(textQueryStore);
  const textOn = textQuery.trim() !== "";
  const [collapsedRepos, setCollapsedRepos] = useSlot(collapsedStore);
  const [sessionOrder, setSessionOrder] = useSlot(orderStore);
  const [tab, setTab] = useSlot(tabStore);
  const [external, setExternal] = useSlot(externalStore);
  const [repoMenu, setRepoMenu] = useSlot(repoMenuStore);
  const [navMenu, setNavMenu] = useSlot(navMenuStore);
  const [showHidden, setShowHidden] = useSlot(showHiddenStore);
  const [shotPick, setShotPick] = useSlot(shotPickStore);
  const [closeAllPick, setCloseAllPick] = useSlot(closeAllPickStore);
  const [closeKeepStar, setCloseKeepStar] = useSlot(closeKeepStarStore);
  const [dragSid, setDragSid] = useState<string | null>(null);

  // Resolve a session's repo (name + branch) from its cwd, so a row always shows
  // which repo/worktree it belongs to — the freeform title often doesn't say.
  const repoForCwd = (cwd: string) => repoOfCwd(repos, cwd);
  const sessionRepo = (s: SessionInfo) => repoForCwd(s.cwd);
  const sessionRepoName = (s: { cwd: string }) => sessionRepoNameIn(repos, s);
  const sessionRepoLabel = (s: SessionInfo) => sessionRepoLabelIn(repos, s);
  const sessionRowBranch = (s: SessionInfo) => sessionRowBranchIn(repos, s);
  const sessionRowTitle = (s: SessionInfo) => sessionRowTitleIn(repos, s);

  const visibleSessions = useMemo(() => sessions.filter((s) => !hiddenRepoPaths.has(s.cwd) && cwdInFocus(s.cwd)), [sessions, hiddenRepoPaths, focusRepo, repos]); // eslint-disable-line react-hooks/exhaustive-deps -- `cwdInFocus` is a per-render closure over `focusRepo` + `repos`, both listed
  const hiddenSessions = useMemo(() => sessions.filter((s) => hiddenRepoPaths.has(s.cwd) && cwdInFocus(s.cwd)), [sessions, hiddenRepoPaths, focusRepo, repos]); // eslint-disable-line react-hooks/exhaustive-deps -- `cwdInFocus` is a per-render closure over `focusRepo` + `repos`, both listed
  const sortedSessions = useMemo(() => sortSessions(visibleSessions, sessionOrder, sessionRepoName), [visibleSessions, sessionOrder, repos]); // eslint-disable-line react-hooks/exhaustive-deps -- `sessionRepoName` is a per-render closure over `repos`

  /** Tap a badge: filter to it, tap the same one again: clear. */
  function toggleStatusFilter(status: SessionFilter, repo?: string) {
    setStatusFilter((cur) => {
      const same = cur && cur.status === status && cur.repo === repo;
      if (same) return null;
      track(`action:session.filter.${status}`);
      return { status, repo };
    });
  }
  const statusFilterActive = (status: SessionFilter, repo?: string) =>
    !!statusFilter && statusFilter.status === status && statusFilter.repo === repo;
  // What the list actually renders. The ROLL-UPS above stay on the unfiltered
  // list on purpose: a chip that recounted itself against the filter it just
  // applied would read "1" for the group you are looking at and hide the fact
  // that the other repos still have work waiting.
  // The quick filter cuts AFTER the status chip, so the two compose ("waiting"
  // and "garmin"), and "n of N" under it counts against the same unfiltered list.
  const shownSessions = useMemo(
    () => filterSessions(sortedSessions, statusFilter, (s, k) => k === "worktrees" ? repoForCwd(s.cwd)?.isPrimary === false : matchesFilterKind(s, k, p.backends), sessionRepoName)
      .filter((s) => !textOn || matchesText(textQuery, [s.tabTitle, s.title, s.firstPrompt, s.lastPrompt, s.pinnedPrompt, sessionRepoName(s), sessionRowBranch(s)])),
    [sortedSessions, statusFilter, repos, textQuery, p.backends], // eslint-disable-line react-hooks/exhaustive-deps -- `repoForCwd`/`sessionRepoName`/`sessionRowBranch` are per-render closures over `repos`
  );

  // ── Live-session repo groups: collapse state + per-group counts ───────────
  // Status roll-up per repo, so a COLLAPSED group still says what its rows are
  // doing. Without it the header stands in for its rows and a session parked on a
  // question is invisible until you expand — the whole point of collapsing is
  // that you don't. The buckets mirror `statusTags` EXACTLY and are mutually
  // exclusive because they come from `sessionStatus()` — the same call the row
  // badge and the status filter make — so the header counts always add up to the
  // row count and can never disagree with the badge a row shows.
  const attentionByRepo = useMemo(() => rollupByRepo(sortedSessions, (s) => sessionStatus(s, p.backends), sessionRepoName), [sortedSessions, repos, p.backends]); // eslint-disable-line react-hooks/exhaustive-deps -- `sessionRepoName` is a per-render closure over `repos`
  const waitingTotal = useMemo(() => rollupTotal(attentionByRepo, "wait"), [attentionByRepo]);
  /**
   * **Which sessions already have words on a clock aimed at them.**
   *
   * The pair a waiting row could not say: *this one is waiting for you* and
   * *the answer is already written and goes at 07:00* are two different
   * situations that looked identical on this screen, and the second one is the
   * reason somebody is not typing. One reading feeds the row chip and both
   * pills (`scheduledReply.ts`), so the mark and the rows it opens cannot come
   * from two different ideas of what is scheduled.
   */
  const repliesBySession = useMemo(() => scheduledRepliesBySession(intents), [intents]);
  /** Per repo, and host-wide: does any WAITING session there have one? A dot,
   *  never a number — the pill it sits on is already a count and already the
   *  filter for it. */
  const waitingRepliesByRepo = useMemo(() => {
    const m = new Map<string, boolean>();
    for (const s of sortedSessions) {
      if (sessionStatus(s, p.backends) !== "wait" || !repliesBySession.has(s.id)) continue;
      m.set(sessionRepoName(s), true);
    }
    return m;
  }, [sortedSessions, repliesBySession, repos, p.backends]); // eslint-disable-line react-hooks/exhaustive-deps -- `sessionRepoName` is a per-render closure over `repos`
  const waitingRepliesTotal = useMemo(
    () => anyScheduledReply(sortedSessions.filter((s) => sessionStatus(s, p.backends) === "wait").map((s) => s.id), repliesBySession),
    [sortedSessions, repliesBySession, p.backends],
  );
  // Sessions blocked on a usage limit. They arrive as a GROUP (the limit is an
  // account fact), which is the whole reason the resume queue and its sheet
  // exist — so the launcher offers one way in rather than making you find the
  // rows and open each session's toolbar.
  const limitTotal = useMemo(() => rollupTotal(attentionByRepo, "limit"), [attentionByRepo]);
  const codingTotal = useMemo(() => rollupTotal(attentionByRepo, "coding"), [attentionByRepo]);
  // Starred sessions per repo — deliberately its OWN map rather than a sixth
  // bucket in `attentionByRepo`: that rollup's whole guarantee is that its
  // buckets are mutually exclusive and sum to the group's row count, and a star
  // is orthogonal to what a session is doing (a starred session is also working,
  // or waiting, or exited). Counted here so the header chip can offer the filter
  // without the roll-up starting to over-count.
  const starredByRepo = useMemo(() => starredByRepoOf(sortedSessions, sessionRepoName), [sortedSessions, repos]); // eslint-disable-line react-hooks/exhaustive-deps -- `sessionRepoName` is a per-render closure over `repos`
  const sessionNumbers = useMemo(() => sessionNumbersOf(sortedSessions, sessionRepoName), [sortedSessions, repos]); // eslint-disable-line react-hooks/exhaustive-deps -- `sessionRepoName` is a per-render closure over `repos`
  const starredTotal = useMemo(() => [...starredByRepo.values()].reduce((n, c) => n + c, 0), [starredByRepo]);
  // Follow-up flags per repo — the star's own map for the star's reason, plus
  // the colour its chip wears (`followUpFacts.ts`: one setter, or mixed).
  const flaggedByRepo = useMemo(() => flaggedByRepoOf(sortedSessions, sessionRepoName), [sortedSessions, repos]); // eslint-disable-line react-hooks/exhaustive-deps -- `sessionRepoName` is a per-render closure over `repos`
  const flaggedTotal = useMemo(() => flaggedTotalOf(flaggedByRepo), [flaggedByRepo]);
  // Sessions carrying a `shellList` at all, whatever it says — its own count
  // for the same reason `starredTotal` is its own: orthogonal to
  // `sessionStatus` (a session with only quiet shells reads `done`, one with a
  // working shell reads `coding`), so it cannot ride the status roll-up.
  const shellsTotal = useMemo(() => sortedSessions.filter((s) => s.shellList?.length).length, [sortedSessions]);
  /**
   * **Commands waiting to run in this repo** — the phone's and the desktop's,
   * counted together because a person does not think of them as two lists.
   *
   * The launcher already showed queued session OPENS (`openingCwds`) and
   * nothing else, so a repo with eleven prompts waiting on it looked exactly
   * like a repo with none. Two sources, one number:
   *   • the send queue — words still on this phone, not yet on the desktop;
   *   • intents the host is holding that have not run (`queued`/`blocked`),
   *     minus the ones armed on a clock, which the schedules chip counts and
   *     which would otherwise be counted twice on the same row.
   *
   * Archived rows are excluded for the reason `activityRows` excludes them:
   * archived is the store's own "I have seen this", and a badge that keeps
   * counting them is a badge nobody can ever clear. A row FILED on this phone
   * (`activityFiled`) is excluded for the same reason — it is the local half of
   * that same word, and a badge counting what you have already dealt with can
   * never reach zero either.
   *
   * Yes, a timed item is counted in two places on one screen — here and on
   * the launcher's schedules chip — and that is not one list counted twice:
   * one is *what this repo is waiting on*, the other *what fires on a clock,
   * host-wide*. Each tap opens exactly what it counted.
   *
   * It is a list of Activity ROW KEYS and not a number, because the number is a
   * filter: the chip's count and the cut its tap opens have to be the same
   * `keys.length`, never two walks of these two lists that could disagree about
   * one row.
   */
  const activityFiled = useActivityFiled();
  const activityConfirmedDone = useActivityConfirmedDone();
  const queuedByRepo = useMemo(
    () => queuedKeysByRepo(outbox, intents, activityFiled, (cwd) => repoForCwd(cwd)?.repoName ?? baseName(cwd)),
    [outbox, intents, repos, activityFiled], // eslint-disable-line react-hooks/exhaustive-deps -- `repoForCwd` is a per-render closure over `repos`
  );
  /** The store by id — what `isBudgetHeld` reads a chain's predecessor off. */
  const intentById = useMemo(() => new Map<string, Intent>(intents.map((i) => [i.id, i])), [intents]);

  function persistCollapsedRepos(next: Set<string>) {
    setCollapsedRepos(next);
    lsSetJson(COLLAPSED_REPOS_KEY, [...next]);
  }
  function toggleRepoCollapsed(name: string) {
    track("action:repo.collapse");
    const next = new Set(collapsedRepos);
    if (next.has(name)) next.delete(name); else next.add(name);
    persistCollapsedRepos(next);
  }
  /** The repo's primary checkout (main worktree) — target of the header's "new session". */
  const primaryRepo = (name: string): RepoTarget | null => repos.find((r) => r.repoName === name && r.isPrimary) ?? null;
  /** The repo's other checkouts, listed under its header. */
  const worktreesOf = (name: string) => visibleRepos.filter((r) => r.repoName === name && !r.isPrimary);
  /**
   * The launcher's ONE list of places work happens: every repo, with whatever
   * live sessions it currently has underneath it.
   *
   * There used to be a second section below the recent lists — "Repos &
   * worktrees" — and between the two of them a repo's verbs were split by an
   * accident: the live group header carried files/new/focus/build, the repo row
   * carried camera/first-prompt/branch/hide, and WHICH half you were offered
   * depended on whether that repo happened to have a session open. Close the
   * last session and half of a repo's affordances moved a screenful down the
   * page, under two lists whose length nobody controls. Worse, the two halves
   * disagreed about the same repo: two headers, two accents, two counts.
   *
   * So the group header is now the repo's row, sessions or none, and it holds
   * every verb. Order: by default `repoSort: "sessions"` — most open first, ties
   * alphabetically — so the repos being worked in sit on top; a person who chose
   * `"name"` gets plain alphabetical, where a repo never jumps when a session
   * starts or ends. The drag reordering owns the session order
   * INSIDE a group (it never crosses repos) and that is not re-sorted.
   *
   * A status filter is an explicit "show me these SESSIONS", so it drops the
   * sessionless repos entirely — a repo with nothing running cannot match
   * "waiting" or "coding", and listing it under a filter would answer the tap
   * with rows it did not ask for.
   */
  const repoSort = usePref("repoSort");
  const openByRepo = useMemo(() => repoSort === "sessions" ? openCountByRepo(sortedSessions, sessionRepoName) : undefined,
    [repoSort, sortedSessions, repos]); // eslint-disable-line react-hooks/exhaustive-deps -- `sessionRepoName` is a per-render closure over `repos`
  const repoGroups = useMemo(
    // The worktree cut keeps its repo's group even with no session in any of
    // them: the rows it counted are the worktree rows under that header.
    // Under the quick filter alone, a repo with no matching session still shows
    // when its own NAME matches — "garmin" finds the repo, not only its rows.
    () => repoGroupsOf(shownSessions, visibleRepos, !!statusFilter || textOn, sessionRepoName,
      statusFilter?.status === "worktrees" && statusFilter.repo ? [statusFilter.repo]
        : textOn && !statusFilter ? visibleRepos.filter((r) => matchesText(textQuery, [r.repoName, r.branch])).map((r) => r.repoName) : [],
      openByRepo),
    [shownSessions, visibleRepos, statusFilter, repos, textQuery, openByRepo], // eslint-disable-line react-hooks/exhaustive-deps -- `sessionRepoName` closes over `repos`, `textOn` derives from `textQuery`
  );
  const allReposCollapsed = repoGroups.length > 0 && repoGroups.every((g) => collapsedRepos.has(g.repoName));
  const noRepoCollapsed = repoGroups.every((g) => !collapsedRepos.has(g.repoName));

  // ── Long-press to drag a session row ──────────────────────────────────────
  // A tap opens the session, so reordering must not be a plain drag: press and
  // hold SESSION_DRAG_MS without moving, then drag. Any movement/scroll/lift
  // before that cancels back to a normal tap.
  const dragRef = useRef(false); // true from drag start until the next pointerdown — swallows the click a drag ends with
  /** Persist a new visible order, keeping ids of currently-hidden sessions and dropping dead ones. */
  function saveSessionOrder(visibleIds: string[]) {
    const next = nextSessionOrder(orderStore.get(), visibleIds, new Set(sessions.map((s) => s.id)));
    setSessionOrder(next);
    lsSetJson(SESSION_ORDER_KEY, next);
  }
  /** Drop the custom order and go back to creation order. */
  function resetSessionOrder() {
    setSessionOrder([]);
    lsDel(SESSION_ORDER_KEY);
  }
  /** pointerdown on a session row: arm the long-press that turns it into a drag. */
  function armRowDrag(e: React.PointerEvent, id: string) {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    dragRef.current = false;
    const sx = e.clientX, sy = e.clientY;
    let timer: number | undefined = window.setTimeout(() => {
      timer = undefined;
      done();
      dragRef.current = true;
      setDragSid(id);
      navigator.vibrate?.(15);
      track("action:session.reorder");
    }, SESSION_DRAG_MS);
    const move = (ev: PointerEvent) => { if (Math.hypot(ev.clientX - sx, ev.clientY - sy) > 10) cancel(); };
    const cancel = () => { if (timer) clearTimeout(timer); done(); };
    const done = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", cancel);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("scroll", cancel, true);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", cancel);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("scroll", cancel, true);
  }
  // Active drag. Window-level listeners (like Backlog's): on touch the row has
  // implicitly captured the pointer, so the scroll container never sees the moves.
  // The non-passive touchmove blocker stops the list scrolling under the finger —
  // touch-action can't be flipped mid-gesture.
  useEffect(() => {
    if (!dragSid) return;
    const move = (e: PointerEvent) => {
      const el = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null)?.closest("[data-sid]");
      const over = el?.getAttribute("data-sid");
      // Rows are grouped per repo, so a cross-repo drop would just snap back into
      // the dragged row's own block — `dragOrder` ignores it instead of flickering.
      const ids = over ? dragOrder(sortedSessions, dragSid, over, sessionRepoName) : null;
      if (ids) saveSessionOrder(ids);
    };
    const block = (e: TouchEvent) => e.preventDefault();
    const end = () => setDragSid(null);
    window.addEventListener("pointermove", move);
    window.addEventListener("touchmove", block, { passive: false });
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("touchmove", block);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-bound per drag and list; `sessionRepoName` is a per-render closure over `repos`, and `saveSessionOrder` reads `sessions`, which moves with `sortedSessions`
  }, [dragSid, sortedSessions]);

  // Refresh external `claude` processes when viewing that tab (and on connect).
  useEffect(() => {
    if (tab !== "external") return;
    api.external().then(setExternal).catch(() => setExternal([]));
  }, [tab, p.conn.status]); // eslint-disable-line react-hooks/exhaustive-deps -- `setExternal` is a module store's setter (stable); `p.conn.status` is listed so a reconnect re-reads
  const visibleExternal = useMemo(() => external.filter((e) => cwdInFocus(e.cwd)), [external, focusRepo, repos]); // eslint-disable-line react-hooks/exhaustive-deps -- `cwdInFocus` is a per-render closure over `focusRepo` + `repos`, both listed

  /**
   * Scope the view to one repo.
   *
   * On the desktop that is a second WINDOW (`?repo=<name>`), which is the point:
   * two repos side by side. **In the native shell there is no second window** —
   * Capacitor turns multiple windows off, so `window.open(…, "_blank")` either
   * no-ops silently or punts the URL to the phone's browser, where it resolves
   * against Capacitor's own local server and loads nothing. So there focus is a
   * SCREEN: set it in place, and let the routing effect push the history entry
   * that makes Android's Back unwind it (`focusRepo` is part of `routeKey`).
   */
  function openFocusWindow(name: string) {
    if (isNativeShell()) { setFocusRepo(name); return; }
    window.open(`${location.pathname}?repo=${encodeURIComponent(name)}`, "_blank");
  }
  /** Drop the repo focus in place — this window becomes a normal all-repos view. */
  function clearFocus() {
    // Nothing else to do: focus is part of the route, so the routing effect
    // rewrites the URL and — when the screen below IS the all-repos view, which
    // is the in-app case — unwinds to it rather than stacking a third entry.
    setFocusRepo(null);
  }

  /**
   * **What the schedules button is holding, and how soon — ONE cut, shared with
   * the sheet it opens.**
   *
   * This is `clockCuts`, the same call `ScheduleSheet` makes over the same two
   * lists, so the number on the chip, the sentence in its title and the header
   * of the sheet are one reading of one pool and cannot be three.
   *
   * They were three. Measured on this desktop, on one set of rows: the chip
   * said **13** (`11 not armed`), its own title said **8**, and the sheet it
   * opens said **2**. Two independent causes stacked — this call omitted
   * `lastOccurrence`, so `isSpentOnce`'s `window`/`oneShot` branch could never
   * say spent and five rows that had run were counted as waiting; and neither
   * chip reading dropped rows that had already settled, so six `done`/`failed`
   * one-offs were "standing" as well. A count on a control is a filter, and
   * eleven of the thirteen were a tap that could reach nothing.
   *
   * The pool is the durable rows AND the rule list AND this phone's queued
   * saves, because all three are drawn on the sheet; `isStandingClock` is the
   * one predicate behind every one of them (`clockCuts.ts`).
   */
  const clocks = useClocks(intents, outbox, nowTick);
  const scheduleHz = clocks.horizon;
  const scheduleWords = horizonWords(scheduleHz);
  /**
   * **…and the same pool per repo, because that is the question a repo row is
   * asked.** The header chip is host-wide: standing over fifteen repos it says
   * how much is on a clock somewhere, never what is on a clock HERE, and the
   * only way to find out was to open Schedules and read fifteen rows' worth of
   * repo names off the cards.
   *
   * Grouped off the SAME `clocks` cut rather than re-walked (`clocksByRepo`) —
   * a per-repo copy of the standing test would be one more chance to say 13
   * where the sheet says 2, fifteen times over. The number is a filter: the tap
   * carries exactly the ids it counted into the sheet's `focusIds`.
   */
  const clocksPerRepo = useMemo(
    () => clocksByRepo({ cuts: clocks, repoOf: (d) => repoForCwd(d)?.repoName ?? (baseName(d) || null), now: Date.now() }),
    [clocks, repos, nowTick], // eslint-disable-line react-hooks/exhaustive-deps -- `repoForCwd` closes over `repos`; `nowTick` stands in for the `Date.now()` read
  );
  /**
   * The bucket the chip's leading number counts — what a tap filters the list
   * to.
   *
   * **A count on a control is a filter.** The chip said "2 within the hour" and
   * opened all ten schedules, leaving the reader to re-derive which two from
   * wall-clock dates. Tapping a number now shows exactly the rows it counted,
   * and the sheet carries a bar saying so with a clear button — the same shape
   * the session-status chips already had.
   */
  const scheduleLead = horizonLead(scheduleHz);
  /**
   * The chip's own sentence — and `total` is RULES, not armed ones.
   *
   * With nothing armed at all (paused weeklies, a `window` rule still waiting
   * for its first usage reading) `horizonWords` IS the unarmed reading, so the
   * old line appended it a second time and called the pool "armed" in the same
   * breath: "3 armed rules — 3 not armed · 3 not armed". The suffix is only
   * added where it is saying something the words do not already say.
   */
  const scheduleUnarmedOnly = scheduleHz.unarmed > 0 && scheduleHz.unarmed === scheduleHz.total;
  /**
   * …and WHAT the pool is made of, because it is two kinds of thing now.
   *
   * The chip counts every standing clock and its tap opens exactly those — one
   * predicate, one edge, so "2 within the hour" opens those two whichever kind
   * they turn out to be. What changed underneath it is that a one-off aimed at
   * one place is no longer a schedule CARD but a backlog row with a clock, so
   * calling the whole pool "rules" would name nine backlog rows as rules on
   * this user's desktop. The sheet lists the first kind as cards and the second
   * as a directory of doors, and this sentence says so before the tap.
   *
   * Split off the SAME cut as the number above it. It used to be a second walk
   * over `intents` with its own copy of the standing test, and the two copies
   * disagreed by five: the title said 8 under a chip saying 13.
   */
  const scheduleKinds = clocks.kinds;
  const schedulePool = [
    scheduleKinds.rules ? `${scheduleKinds.rules} rule${scheduleKinds.rules === 1 ? "" : "s"}` : "",
    scheduleKinds.timed ? `${scheduleKinds.timed} on a clock in a backlog` : "",
  ].filter(Boolean).join(" · ");
  const scheduleTitle = scheduleWords
    ? `schedules · ${schedulePool} — ${scheduleWords}${scheduleHz.unarmed && !scheduleUnarmedOnly ? ` · ${scheduleHz.unarmed} not armed` : ""} — tap to see the ${scheduleLead ? HORIZON_LABEL[scheduleLead] : ""} ones`
    : "schedules — run a prompt on its own at a time you pick (once, every week, or around a usage window)";

  /**
   * The launcher's activity badge: what has NOT settled on this phone.
   *
   * Failed rows count too — a gravestone is the one thing on that screen
   * somebody has to come back to. Host-side waiting work is deliberately not
   * summed in: it is not this device's to be nagged about.
   *
   * It used to have to add a second ledger's rows to this, because a failed
   * queue row retired after an hour and its words moved there — so the badge
   * counted the first hour of a dead send and nothing after it, while the list
   * itself held eighty-four of them. Nothing retires now, so the queue IS the
   * count. A row the user has FILED is not counted, which is what makes the
   * badge answer "is there anything left to decide" rather than "has anything
   * ever gone wrong".
   */
  const activityBadge = outbox.filter((e) =>
    (e.status === "queued" || e.status === "failed") && !activityFiled.has(`queue:${e.ackId}`)
    && !activityConfirmedDone.has(`queue:${e.ackId}`)).length;
  /** The download queue at a glance, for the menu chip and the menu's own
   *  entry — bytes, not files (`features/pull`'s `pullSummary`). */
  const pullRecords = usePullRecords();
  // The strip's cut: rows waiting for a tap with auto-download off here are
  // in the sheet, not in the menu's progress (`stripRows`).
  const dl = pullSummary(stripRows(pullRecords, autoPull()));
  /** Apps with a build here that has not gone on — the apps screen's `ready`
   *  pane, through the same function, so the count opens exactly its rows. */
  const appsReady = readyApps(appRows(buildsOf(pullRecords), [], NO_INSTALL)).length;

  const liveCwds = new Set(sessions.map((s) => s.cwd));
  // Both id fields, through the one reader (`resumeIdOf`): a live opencode
  // session names its conversation in `backendSessionId`, and a set built
  // from `claudeSessionId` alone said every opencode row was id-less — so the
  // per-directory fallback below hid a genuinely-closed conversation behind
  // ANY other session open in that repo, which is the one case where the
  // exact reopen matters most.
  const liveConvIds = new Set(sessions.map(resumeIdOf).filter(Boolean));
  // A recent/closed entry is redundant only when ITS conversation is already
  // open. Id-less (legacy, or a backend id the host never discovered) entries
  // fall back to the old per-directory rule.
  const conversationOpen = (e: { cwd: string; claudeSessionId?: string; backendSessionId?: string }) => {
    const id = resumeIdOf(e);
    return id ? liveConvIds.has(id) : liveCwds.has(e.cwd);
  };
  const hiddenRecent = recent.filter((r) => !conversationOpen(r) && hiddenRepoPaths.has(r.cwd) && cwdInFocus(r.cwd));
  const visibleRecent = recent.filter((r) => !conversationOpen(r) && !hiddenRepoPaths.has(r.cwd) && cwdInFocus(r.cwd));
  // Sessions closed (incl. mis-tapped ×) whose conversation isn't already back open.
  const reopenable = closed.filter((c) => !conversationOpen(c) && cwdInFocus(c.cwd));
  const hiddenCount = hiddenRepos.length + hiddenSessions.length + hiddenRecent.length;

  return {
    // state
    statusFilter, setStatusFilter, toggleStatusFilter, statusFilterActive, textQuery, setTextQuery, textOn,
    collapsedRepos, persistCollapsedRepos, toggleRepoCollapsed,
    sessionOrder, saveSessionOrder, resetSessionOrder, dragSid, dragRef, armRowDrag,
    tab, setTab, repoMenu, setRepoMenu, navMenu, setNavMenu, showHidden, setShowHidden, shotPick, setShotPick,
    closeAllPick, setCloseAllPick, closeKeepStar, setCloseKeepStar,
    // names
    repoForCwd, sessionRepo, sessionRepoName, sessionRepoLabel, sessionRowBranch, sessionRowTitle,
    // the list
    visibleSessions, hiddenSessions, sortedSessions, shownSessions, repoGroups, allReposCollapsed, noRepoCollapsed, primaryRepo, worktreesOf,
    attentionByRepo, waitingTotal, repliesBySession, waitingRepliesByRepo, waitingRepliesTotal, limitTotal, codingTotal,
    starredByRepo, starredTotal, flaggedByRepo, flaggedTotal, sessionNumbers, shellsTotal, queuedByRepo, intentById,
    visibleExternal, openFocusWindow, clearFocus,
    // chips
    scheduleWords, scheduleLead, scheduleTitle, clocksPerRepo, activityBadge, dl, appsReady,
    // the other lists
    visibleRecent, hiddenRecent, reopenable, hiddenCount,
  };
}

export type LauncherModel = ReturnType<typeof useLauncherModel>;
