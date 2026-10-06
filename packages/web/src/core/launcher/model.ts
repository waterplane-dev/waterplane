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
import { branchLabel, isBacklogRow, isScheduleRow } from "@waterplane/shared";
import type { OutboxEntry, OutboxStatus } from "../../outbox";
import { baseName } from "../../format.ts";
import { intentRowKey, queueRowKey } from "../../activityRows.ts";

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
/** The repo (worktree) a directory is, if the listing knows it. */
export const repoOfCwd = (repos: readonly RepoTarget[], cwd: string) => repos.find((r) => r.worktreePath === cwd) ?? null;
/** The repo NAME a session belongs to — the group it is listed under. */
export const sessionRepoNameIn = (repos: readonly RepoTarget[], s: { cwd: string }) => repoOfCwd(repos, s.cwd)?.repoName ?? baseName(s.cwd);
/** `repo · branch`, for a row's own gist fallback. */
export const sessionRepoLabelIn = (repos: readonly RepoTarget[], s: SessionInfo) => { const r = repoOfCwd(repos, s.cwd); return r ? `${r.repoName} · ${r.branch}` : baseName(s.cwd); };
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
  return [...groups.values()].flat();
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
 * The launcher's ONE list of places work happens: every repo, with whatever
 * live sessions it currently has underneath it. Repos with live sessions first,
 * in the session list's own order, then the rest as the listing gives them. A
 * status filter drops the sessionless repos — they cannot match a status.
 */
export function repoGroupsOf(shown: readonly SessionInfo[], visibleRepos: readonly RepoTarget[], filtered: boolean,
  repoName: (s: SessionInfo) => string, keep: readonly string[] = []): { repoName: string; sessions: SessionInfo[] }[] {
  const byName = new Map<string, SessionInfo[]>();
  const order: string[] = [];
  for (const s of shown) {
    const n = repoName(s);
    let arr = byName.get(n);
    if (!arr) { arr = []; byName.set(n, arr); order.push(n); }
    arr.push(s);
  }
  for (const r of visibleRepos) if ((!filtered || keep.includes(r.repoName)) && !byName.has(r.repoName)) { byName.set(r.repoName, []); order.push(r.repoName); }
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

/** The sessions a bulk close would touch: the repo's (or all listed), minus the
 *  starred ones while `keepStar` holds — ONE list every count and close reads. */
export function closeScope(visible: readonly SessionInfo[], repo: string | undefined, keepStar: boolean,
  repoName: (s: SessionInfo) => string): SessionInfo[] {
  const inRepo = repo ? visible.filter((s) => repoName(s) === repo) : [...visible];
  return keepStar ? inRepo.filter((s) => !s.starred) : inRepo;
}
/** The starred sessions a bulk close is currently sparing — 0 when the toggle is off. */
export function starredSpared(visible: readonly SessionInfo[], repo: string | undefined, keepStar: boolean,
  repoName: (s: SessionInfo) => string): number {
  if (!keepStar) return 0;
  const inRepo = repo ? visible.filter((s) => repoName(s) === repo) : visible;
  return inRepo.filter((s) => s.starred).length;
}
