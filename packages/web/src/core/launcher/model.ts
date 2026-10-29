/**
 * The launcher's pure half: how the list is ordered, cut, rolled up and
 * counted, and the SCOPE a bulk close starts from (the facets themselves are
 * `closeModel.ts`'s). No React, no DOM — tested by `model.test.mjs` under
 * `node --test`.
 *
 * Every function that needs a session's STATUS takes it as an argument
 * (`statusOf`, `matches`): that reader is `sessionFacts.tsx`'s, one copy for
 * the row badge, the roll-up, the filter and the tab strip, and it is a TSX
 * module node cannot load. Handing it in keeps this file testable without a
 * second copy of the rule.
 */
import type { Intent, RepoSetupState, RepoTarget, SessionInfo } from "@waterplane/shared";
import { branchLabel, glueCompanions, isBacklogRow, isScheduleRow, repoLabel } from "@waterplane/shared";
import type { OutboxEntry, OutboxStatus } from "../../outbox";
import { baseName } from "../../format.ts";
import { intentRowKey, queueRowKey } from "../../activityRows.ts";
import { bucketOf } from "../../activity/activityBucket.ts";
import { isFlagged } from "../sessions/followUpFacts.ts";

/** A session's status bucket — `sessionFacts.tsx`'s `sessionStatus` values. */
export type StatusBucket = "wait" | "limit" | "coding" | "done" | "exited";
export interface RepoStatusRollup { wait: number; limit: number; coding: number; done: number; exited: number }
/**
 * Status FILTER on the live list: which rows the launcher is showing. Set by
 * tapping any status badge — a row's own, or a repo header's roll-up chip, which
 * is the tap everyone tries first ("2 waiting" is a count of rows; the rows are
 * what you want). `repo` scopes it to the group whose chip was tapped; a row
 * badge filters across every repo, because that badge says nothing about a group.
 *
 * Deliberately EPHEMERAL — never persisted. A filter that survives a reload
 * hides sessions with no visible cause, which is indistinguishable from the
 * sessions being gone; the one bug this must not create.
 */
export interface StatusFilter<F extends string = string> { status: F; repo?: string }

// ── Names ──────────────────────────────────────────────────────────────────
/** The repo (worktree) a directory is, or is INSIDE, if the listing knows it.
 *  Exact first; else the deepest worktree containing it on a path boundary —
 *  a shell that `cd`'d into `trading/backend` still belongs to `trading`, and
 *  `/dev/app-worktrees/x` is never inside `/dev/app`. Outside every repo ⇒ null. */
export const repoOfCwd = (repos: readonly RepoTarget[], cwd: string): RepoTarget | null => {
  const exact = repos.find((r) => r.worktreePath === cwd);
  if (exact) return exact;
  let best: RepoTarget | null = null;
  for (const r of repos) {
    const root = r.worktreePath.replace(/\/+$/, "");
    if (!root || !cwd.startsWith(root + "/")) continue;
    if (!best || root.length > best.worktreePath.replace(/\/+$/, "").length) best = r;
  }
  return best;
};
/** The repo NAME a session belongs to — the group it is listed under. `repoLabel`, so two clones
 *  with one folder name are two groups (`ciqkit · garmin/`), never one that opens in either. */
export const sessionRepoNameIn = (repos: readonly RepoTarget[], s: { cwd: string }) => { const r = repoOfCwd(repos, s.cwd); return r ? repoLabel(r) : baseName(s.cwd); };
/** `repo · branch`, for a row's own gist fallback. */
export const sessionRepoLabelIn = (repos: readonly RepoTarget[], s: SessionInfo) => { const r = repoOfCwd(repos, s.cwd); return r ? `${repoLabel(r)} · ${r.branch}` : baseName(s.cwd); };
// Within the live list rows are grouped under a repo header, so repeating the
// repo name in each row title is redundant and (with the status/count badges)
// crushes it to "usm…". Show the branch instead — that's what the header lacks
// and it tells same-repo sessions apart alongside their status/age tags.
//
// Except when the branch is the ordinary one (`shared/naming.ts`'s
// `branchLabel`): on a desktop where every primary sits on `main`, that word
// was the first thing on every row and said nothing that told two rows apart.
// What takes the space is the desktop's own name for the session.
export const sessionRowBranchIn = (repos: readonly RepoTarget[], s: SessionInfo) => { const r = repoOfCwd(repos, s.cwd); return r ? branchLabel(r) : baseName(s.cwd); };
/** The one-line name for a session OUTSIDE the list — a sheet head, a toast.
 *  Never empty: the branch when it is worth saying, else the derived name,
 *  else the repo. In the list the two are drawn side by side instead. */
export const sessionRowTitleIn = (repos: readonly RepoTarget[], s: SessionInfo) =>
  sessionRowBranchIn(repos, s) || (s.tabTitle ?? "").trim() || sessionRepoNameIn(repos, s);

// ── Chip words ─────────────────────────────────────────────────────────────
/** How an in-flight open reads on a chip: what it is doing, and how many. */
// The COUNT is never hidden. It used to appear only past one — so the common
// case, a single queued open, rendered as the bare word "queued" beside a
// spinner: a chip that says something is waiting and refuses to say how much,
// on the one screen whose job is to answer that. One is a number too.
export const openingText = (o: { status: OutboxStatus; n: number }) =>
  `${o.status === "pending" ? "opening…" : "queued"} ${o.n}`;
export const openingTitle = (o: { status: OutboxStatus; n: number }) =>
  `${o.n > 1 ? `${o.n} sessions ` : ""}${o.status === "pending"
    ? "opening — waiting for the desktop to confirm"
    : "queued — opens when the link is back"}`;
/** The setup rollup in words, ONE copy: the two row chips and the two menu
 *  entries all say it, and four hand-rolled copies of one sentence is four
 *  chances for the amber wording and the red wording to drift apart. */
export const setupTitle = (s: RepoSetupState) =>
  `repo setup: ${s.issues} ${!s.ok ? "issue" : "thing to look at"}${s.issues > 1 ? "s" : ""}${s.fixable ? `, ${s.fixable} one-tap fixable` : ""} — open the checklist`;
/** The menu entry, which is ALWAYS drawn: the checklist is reachable whether
 *  or not anything is wrong, so with a clean (or unchecked) repo it is the
 *  bare verb and only a rollup with findings carries its count. */
export const setupMenuLabel = (s?: RepoSetupState) => (s && s.issues > 0 ? `repo readings · ${s.issues}` : "repo readings");
export const setupMenuTitle = (s?: RepoSetupState) =>
  (s && s.issues > 0 ? setupTitle(s) : "open this repo's readings");

// ── Order ──────────────────────────────────────────────────────────────────
// Live-session row order: STABLE BY CREATION TIME, oldest on top, newest at the
// bottom — the one ordering that never moves a row under your finger. It used to
// sort by attention-priority (waiting → coding → done) grouped per repo, which
// reshuffled the list whenever a session flipped status; even frozen-per-set that
// meant every open/close re-laid-out the whole list. Now: no status, no starred,
// no repo grouping in the sort key — only createdAt, then a per-device manual
// override (long-press a row and drag). New sessions always append at the bottom.
//
// FINAL PASS: rows of the same repo are kept CONTIGUOUS. The list is rendered
// with a repo group header per run of same-repo rows (and a row's own title is
// just its branch — the header carries the repo name), so an interleaved order
// emitted the same header over and over: one "myapp (18)" header per run, and
// with the group collapsed, one repeated header per run and nothing else. That
// is the duplicate-rows bug. Grouping is stable and status-free: a repo sits at
// the position of its OLDEST session, so nothing reshuffles when a session
// flips state; a new session lands at the end of its repo's block.
export function sortSessions(visible: readonly SessionInfo[], order: readonly string[], repoName: (s: SessionInfo) => string): SessionInfo[] {
  const byCreated = [...visible].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
  let out = byCreated;
  if (order.length) {
    const by = new Map(byCreated.map((s) => [s.id, s]));
    out = [];
    for (const id of order) { const s = by.get(id); if (s) { out.push(s); by.delete(id); } }
    // Anything the manual order doesn't know about (a session created since) keeps
    // its createdAt position relative to the other newcomers, appended at the end.
    for (const s of byCreated) if (by.has(s.id)) out.push(s);
  }
  const groups = new Map<string, SessionInfo[]>();
  for (const s of out) {
    const n = repoName(s);
    const g = groups.get(n);
    if (g) g.push(s); else groups.set(n, [s]);
  }
  // A companion shell sits right under its session, whatever the order says.
  return glueCompanions([...groups.values()].flat());
}

/** A new visible order to persist, keeping ids of currently-hidden sessions and dropping dead ones. */
export function nextSessionOrder(prev: readonly string[], visibleIds: readonly string[], alive: ReadonlySet<string>): string[] {
  const shown = new Set(visibleIds);
  // Hidden-but-alive sessions (other focus window / hidden repo) aren't part of
  // the dragged list — keep them, appended, so their order isn't silently lost.
  const rest = prev.filter((id) => alive.has(id) && !shown.has(id));
  return [...visibleIds, ...rest];
}

/**
 * The visible order after dragging `dragId` over `overId`, or null for a move
 * that is not one. Rows are grouped per repo, so a cross-repo drop would just
 * snap back into the dragged row's own block — ignore it instead of flickering.
 */
export function dragOrder(sorted: readonly SessionInfo[], dragId: string, overId: string, repoName: (s: SessionInfo) => string): string[] | null {
  if (!overId || overId === dragId) return null;
  const src = sorted.find((s) => s.id === dragId), dst = sorted.find((s) => s.id === overId);
  if (!src || !dst || repoName(src) !== repoName(dst)) return null;
  const ids = sorted.map((s) => s.id);
  const from = ids.indexOf(dragId), to = ids.indexOf(overId);
  if (from === -1 || to === -1) return null;
  ids.splice(from, 1);
  ids.splice(to, 0, dragId);
  return ids;
}

// ── Cut + roll-ups ─────────────────────────────────────────────────────────
/** What the list actually renders under a status filter. The ROLL-UPS stay on
 *  the unfiltered list on purpose: a chip that recounted itself against the
 *  filter it just applied would read "1" for the group you are looking at and
 *  hide the fact that the other repos still have work waiting. */
export function filterSessions<F extends string>(sorted: SessionInfo[], f: StatusFilter<F> | null,
  matches: (s: SessionInfo, status: F) => boolean, repoName: (s: SessionInfo) => string): SessionInfo[] {
  if (!f) return sorted;
  return sorted.filter((s) => matches(s, f.status) && (!f.repo || repoName(s) === f.repo));
}

/** Status roll-up per repo. Mutually exclusive buckets off the ONE status reader,
 *  so the header counts always add up to the row count. */
export function rollupByRepo(sorted: readonly SessionInfo[], statusOf: (s: SessionInfo) => StatusBucket,
  repoName: (s: SessionInfo) => string): Map<string, RepoStatusRollup> {
  const m = new Map<string, RepoStatusRollup>();
  for (const s of sorted) {
    const n = repoName(s);
    const cur = m.get(n) ?? { wait: 0, limit: 0, coding: 0, done: 0, exited: 0 };
    cur[statusOf(s)]++;
    m.set(n, cur);
  }
  return m;
}

/** Sum one bucket over every repo. */
export const rollupTotal = (m: ReadonlyMap<string, RepoStatusRollup>, k: keyof RepoStatusRollup) =>
  [...m.values()].reduce((n, a) => n + a[k], 0);

/** Starred sessions per repo — its own map, never a sixth roll-up bucket (a
 *  star is orthogonal to status, and the buckets must sum to the row count). */
export function starredByRepoOf(sorted: readonly SessionInfo[], repoName: (s: SessionInfo) => string): Map<string, number> {
  const m = new Map<string, number>();
  for (const s of sorted) if (s.starred) { const n = repoName(s); m.set(n, (m.get(n) ?? 0) + 1); }
  return m;
}

/**
 * **A number per OPEN session, counted per repo from 0**, in the list's own
 * order (`sortSessions`, so a drag renumbers) and BEFORE any status filter —
 * a cut hides rows, it never renumbers the ones left. A session whose process
 * has gone (`running` false) gets no number and does not take one.
 */
export function sessionNumbersOf(sorted: readonly SessionInfo[], repoName: (s: SessionInfo) => string): Map<string, number> {
  const next = new Map<string, number>();
  const out = new Map<string, number>();
  for (const s of sorted) {
    if (!s.running) continue;
    const n = repoName(s);
    const i = next.get(n) ?? 0;
    out.set(s.id, i);
    next.set(n, i + 1);
  }
  return out;
}

/**
 * The launcher's ONE list of places work happens: every repo, with whatever
 * live sessions it currently has underneath it, alphabetically by repo name
 * (case-insensitive) — a repo keeps its place whether or not anything runs in
 * it. Sessions inside a group keep the session list's own order. A status
 * filter drops the sessionless repos — they cannot match a status.
 *
 * `openByRepo` is the default order (`repoSort: "sessions"`): most open
 * sessions first, ties alphabetically; `"name"` drops it for the plain sort. Counted off every live session, not the
 * filtered ones, so typing a filter does not reshuffle the repos it leaves.
 */
export type RepoOrder = "name" | "sessions";
export const REPO_ORDERS: readonly RepoOrder[] = ["name", "sessions"];
export const REPO_ORDER_LABEL: Record<RepoOrder, string> = { name: "alphabetical", sessions: "most open sessions first" };

/** Live sessions per repo name — what `repoSort: "sessions"` ranks by. */
export function openCountByRepo(sessions: readonly SessionInfo[], repoName: (s: SessionInfo) => string): Map<string, number> {
  const m = new Map<string, number>();
  for (const s of sessions) if (s.running) { const n = repoName(s); m.set(n, (m.get(n) ?? 0) + 1); }
  return m;
}

export function repoGroupsOf(shown: readonly SessionInfo[], visibleRepos: readonly RepoTarget[], filtered: boolean,
  repoName: (s: SessionInfo) => string, keep: readonly string[] = [],
  openByRepo?: ReadonlyMap<string, number>): { repoName: string; sessions: SessionInfo[] }[] {
  const byName = new Map<string, SessionInfo[]>();
  const order: string[] = [];
  for (const s of shown) {
    const n = repoName(s);
    let arr = byName.get(n);
    if (!arr) { arr = []; byName.set(n, arr); order.push(n); }
    arr.push(s);
  }
  for (const r of visibleRepos) { const n = repoLabel(r); if ((!filtered || keep.includes(n)) && !byName.has(n)) { byName.set(n, []); order.push(n); } }
  order.sort((a, b) => (openByRepo ? (openByRepo.get(b) ?? 0) - (openByRepo.get(a) ?? 0) : 0)
    || a.localeCompare(b, undefined, { sensitivity: "base", numeric: true }));
  return order.map((name) => ({ repoName: name, sessions: byName.get(name) ?? [] }));
}

/**
 * **Commands waiting to run in each repo**, as Activity ROW KEYS — the phone's
 * queue (not failed) and the desktop's held intents (`queued`/`blocked`, not
 * archived, not a standing schedule rule), minus what this phone has FILED.
 * Keys and not a number, because the number is a filter: the chip's count and
 * the cut its tap opens are the same `keys.length`.
 */
export function queuedKeysByRepo(outbox: readonly OutboxEntry[], intents: readonly Intent[], filed: { has(key: string): boolean },
  repoNameOfCwd: (cwd: string) => string): Map<string, string[]> {
  const m = new Map<string, string[]>();
  const bump = (cwd: string, key: string) => {
    if (filed.has(key)) return; // already dealt with
    const name = repoNameOfCwd(cwd);
    if (!name) return;
    const cur = m.get(name);
    if (cur) cur.push(key); else m.set(name, [key]);
  };
  for (const e of outbox) {
    if (e.status === "failed") continue; // a failure is not "waiting" — Activity triages those
    if (e.cwd) bump(e.cwd, queueRowKey(e.ackId));
  }
  for (const i of intents) {
    if (i.archived) continue;
    if (i.state !== "queued" && i.state !== "blocked") continue;
    // A timed one-off is this repo's waiting work and is counted; only a
    // standing RULE (or a one-off sweep, which belongs to no single repo) is
    // left to the schedules chip.
    if (isScheduleRow(i)) continue;
    if (i.cwd) bump(i.cwd, intentRowKey(i.id));
  }
  return m;
}

/**
 * **The menu's activity count, as the Activity row keys it opens** — what is still open.
 *
 * Two sources. This phone's send queue: words not yet on the desktop, and the
 * failed ones (a gravestone is the one row somebody has to come back to). And
 * the desktop's rows in the `needsYou` bucket — a dead session, a gate, a box
 * waiting for an answer, an agent-posted item that waits for a tap. Those will
 * never move without a person, and leaving them out (the badge used to count
 * the queue only) meant an item waiting three hours for a tap sat behind the
 * menu with no mark at all. Host work that clears itself — idle-waits, clocks —
 * stays out: that is not news.
 *
 * Keys, not a number, because the number is a filter: the menu's tap opens
 * exactly these. Archived and child-of-a-sweep intents are skipped because
 * Activity draws no row for them; a launch still in the queue counts once,
 * under the host's row
 * (`selectActivity`'s dedupe), and not at all unless that row needs you. `marked` is this
 * phone's filed + confirmed-done marks.
 */
export function activityOpenKeys(outbox: readonly OutboxEntry[], intents: readonly Intent[],
  marked: { has(key: string): boolean }): string[] {
  const needs = intents.filter((i) => !i.archived && (i.groupId == null || i.groupId === i.id)
    && bucketOf(i.state, i.blockReason ?? null) === "needsYou");
  // `selectActivity`'s dedupe: a launch the host already holds drops its queue row.
  const hostHas = new Set(intents.filter((i) => !i.archived
    && (i.state === "queued" || i.state === "blocked" || i.state === "starting")).map((i) => i.id));
  const keys = [
    ...outbox.filter((e) => (e.status === "queued" || e.status === "failed") && !hostHas.has(e.ackId))
      .map((e) => queueRowKey(e.ackId)),
    ...needs.map((i) => intentRowKey(i.id)),
  ];
  return keys.filter((k) => !marked.has(k));
}

/**
 * **Where the "waiting" chip's tap opens**, off the SAME keys that gave its number.
 *
 * The Backlog is a view of the intent store (`isBacklogRow`), and Activity lists every row. So the
 * chip may open the Backlog only when every row it counted is one of the Backlog's rows, in one
 * checkout: a queued launch, build or sweep child is counted here yet has no Backlog row, and a
 * Backlog cut over its id shows "0 of N" for something that is waiting. Anything else (a phone-side
 * send, a mixed set) opens Activity, which reads all of it.
 */
export function queuedChipCut(keys: readonly string[], intents: readonly Intent[]):
  { kind: "backlog"; cwd: string; ids: string[] } | { kind: "activity" } {
  const keySet = new Set(keys);
  const rows = intents.filter((i) => keySet.has(intentRowKey(i.id)));
  const cwds = new Set(rows.map((i) => i.cwd));
  if (rows.length === keys.length && cwds.size === 1 && rows[0].cwd && rows.every(isBacklogRow)) {
    return { kind: "backlog", cwd: rows[0].cwd, ids: rows.map((i) => i.id) };
  }
  return { kind: "activity" };
}

// ── Bulk close ─────────────────────────────────────────────────────────────
// The facet engine that used to live here — `CloseHow`, `closePick`,
// `closeCounts`, `STALE_MS`, `CLOSE_CUSTOM_DEFAULT_H` — is `closeModel.ts`
// now: seven combinable facets replaced the five single-cut buttons this file
// used to count. `closeScope`/`starredSpared` stay — the star toggle is a
// SCOPE decision, made before any facet, and both the close sheet and its
// test still read these two.

/**
 * A mark a person left on a session that a bulk close spares while the toggle
 * holds: a star, or a follow-up flag (R-sessions-041) — whoever set the flag.
 * ONE predicate behind the scope, the spared count and the toggle's words.
 */
export const isCloseSpared = (s: SessionInfo): boolean => !!s.starred || isFlagged(s);

/** The sessions a bulk close would touch: the repo's (or all listed), minus the
 *  starred and flagged ones while `keepStar` holds — ONE list every count and
 *  close reads. */
export function closeScope(visible: readonly SessionInfo[], repo: string | undefined, keepStar: boolean,
  repoName: (s: SessionInfo) => string): SessionInfo[] {
  const inRepo = repo ? visible.filter((s) => repoName(s) === repo) : [...visible];
  return keepStar ? inRepo.filter((s) => !isCloseSpared(s)) : inRepo;
}
/** The marked sessions in reach of a bulk close, split by mark: `starred` and
 *  `flagged` may overlap (a session can carry both), `n` counts each once. */
export interface MarkedCount { n: number; starred: number; flagged: number }
export function closeMarked(visible: readonly SessionInfo[], repo: string | undefined,
  repoName: (s: SessionInfo) => string): MarkedCount {
  const inRepo = repo ? visible.filter((s) => repoName(s) === repo) : visible;
  const marked = inRepo.filter(isCloseSpared);
  return { n: marked.length, starred: marked.filter((s) => s.starred).length, flagged: marked.filter(isFlagged).length };
}
/** The marked sessions a bulk close is currently sparing — 0 when the toggle is off. */
export function starredSpared(visible: readonly SessionInfo[], repo: string | undefined, keepStar: boolean,
  repoName: (s: SessionInfo) => string): number {
  return keepStar ? closeMarked(visible, repo, repoName).n : 0;
}
/** What the marks are, in words: `2 starred`, `1 flagged`, `3 starred & flagged`. */
export function markedWords(c: MarkedCount): string {
  const what = c.starred && c.flagged ? "starred & flagged" : c.flagged ? "flagged" : "starred";
  return `${c.n} ${what}`;
}

/**
 * The launcher's quick filter: every word typed must appear somewhere in what
 * the row SHOWS (title, prompts, repo, branch), case-insensitive, in any
 * order. Text on screen only — searching what sessions SAID is the search
 * sheet's job, over the host's transcripts. A blank query matches everything.
 */
export function matchesText(query: string, fields: readonly (string | null | undefined)[]): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = fields.filter(Boolean).join("\n").toLowerCase();
  return words.every((w) => hay.includes(w));
}
