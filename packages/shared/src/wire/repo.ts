/** A repo or worktree: its git state, its setup verdict, and the CLI install behind it. */
import type { ContextLimitsView } from "../contextweight.js";
import type { RepoHealthIndex } from "../healthindex.js";

/**
 * How this desktop's `claude` got onto the PATH, which is the ONLY thing that
 * decides what the update button may run. Read off the resolved binary path,
 * never configured: an install route people can mistype is an upgrade command
 * aimed at a package manager that does not own the binary.
 *
 * `unknown` is a real answer and the button REFUSES on it, rather than guessing
 * a manager and reporting its complaint as the CLI's.
 */
export type InstallRoute = "brew" | "npm" | "native" | "unknown";

/** Status of the host's `claude-code` install — used by the in-app update banner. */
export interface UpdateInfo {
  /** True when an update is available — from the install route's index OR the CLI's own nag banner. */
  available: boolean;
  /** Which signal raised `available`: the route's own index, or the CLI banner (registry ahead of it). */
  source?: "brew" | "npm" | "cli";
  /** How the binary was installed — decides the upgrade command. Absent until first probed. */
  route?: InstallRoute;
  /** The upgrade command this route would run, as a person reads it ("brew upgrade --cask …").
   *  The phone PRINTS this on the button instead of re-deriving it: two derivations of
   *  "which package manager owns claude" is one of them being wrong on somebody's desktop. */
  applyLabel?: string;
  /** Resolved path of the binary the host spawns (best-effort) — what `route` was read off. */
  binPath?: string;
  /** Installed version (best-effort). */
  current?: string;
  /** Latest version the route's index offers, or the version the CLI nag named (best-effort). */
  latest?: string;
  /** True while an upgrade is in flight. */
  running: boolean;
  /** ms since epoch of last poll. */
  lastChecked?: number;
  /** Last poll/apply error string, if any. */
  lastError?: string;
  /** Outcome of the most recent upgrade invocation. */
  lastResult?: { ok: boolean; message: string; at: number };
  /** Tail of the upgrade's stdout/stderr (live while running, retained briefly after). */
  log?: string[];
}

/** Git review types (Tier 3). */
export interface GitFile {
  path: string;
  code: string;
  staged: boolean;
  from?: string;
}

export interface GitStatus {
  branch: string;
  upstream?: string;
  ahead: number;
  behind: number;
  files: GitFile[];
  clean: boolean;
}

/** One commit as the history view lists it. `at` is the author date, epoch ms. */
export interface GitCommit {
  sha: string;
  short: string;
  author: string;
  at: number;
  subject: string;
}

/**
 * The branch's commits against its upstream, in three disjoint lists:
 * `incoming` is on the upstream and not here (what a pull brings), `outgoing`
 * is here and not on the upstream (what a push sends), `shared` is the recent
 * history both have. `incoming` is only as fresh as the desktop's last fetch —
 * `fetchedAt` says when that was, ABSENT when the desktop cannot tell.
 * No upstream ⇒ `upstream` absent, both directions empty, `shared` is the
 * branch's own recent history. Each list is capped; `*Total` is the real count.
 */
export interface GitLog {
  branch: string;
  upstream?: string;
  incoming: GitCommit[];
  incomingTotal: number;
  outgoing: GitCommit[];
  outgoingTotal: number;
  shared: GitCommit[];
  fetchedAt?: number;
}

/**
 * The push the desktop is running (or last ran) in one worktree. A push runs
 * the repo's pre-push hook — the full local CI here, tens of minutes — so it
 * is a job on the host that the phone starts and then asks after, never one
 * request held open across it.
 */
export interface GitPushState {
  running: boolean;
  /** Epoch ms the push started. */
  startedAt: number;
  /** Present once it ended: what `git push` said. */
  result?: { ok: boolean; output?: string; error?: string; finishedAt: number };
  /** What the push has printed so far — absent from a host that does not stream it. */
  progress?: GitPushProgress;
}

/**
 * A push's output as it streams, read by the host (`pushprogress.ts`): the
 * local-CI hook's steps, the e2e runner's count, and the last few lines.
 * `steps` is empty for a hook whose format the host does not know — the tail
 * is still there.
 */
export interface GitPushProgress {
  steps: { name: string; state: "running" | "ok" | "failed" | "skipped" | "done"; secs?: number; why?: string }[];
  /** e2e scripts finished (and of those failed) of the total the runner announced. */
  e2e?: { done: number; failed: number; total: number };
  /** The latest lines printed, colour codes out, oldest first. */
  tail: string[];
}

export interface GitBranch {
  name: string;
  current: boolean;
  upstream?: string;
  /** Checked out in a different worktree — can't switch to it from here. */
  inUseElsewhere: boolean;
}

/** A git repo / worktree that a session can be started in. */
export interface RepoTarget {
  id: string;
  repoName: string;
  branch: string;
  isPrimary: boolean;
  worktreePath: string;
  /** Outbox artifacts dropped since this repo's outbox was last opened — the
   *  "something to look at" badge. The inbox is deliberately NOT counted: it
   *  holds what the phone itself uploaded. */
  outboxCount: number;
  /**
   * The instant `outboxCount` was measured against — the oldest of this repo's
   * per-subdir "seen" marks, so a file the badge counted can never fall outside
   * it.
   *
   * On the wire because a count on a control is a FILTER, and a filter needs the
   * EDGE the number came from, not an approximation of it. Tapping "42" used to
   * open the gallery's own default window and show none of them; carrying the
   * window fixed that, and carrying the actual boundary is what makes the grid
   * show those 42 rather than those 42 plus everything older. Absent = this repo
   * has no outbox marker yet, i.e. nothing has ever been counted.
   */
  outboxSeenAt?: number;
  /** Files with uncommitted changes (staged, unstaged or untracked — `git status
   *  --porcelain -uall`), respecting .gitignore. It is the size of the list the
   *  git view opens, so the badge and the sheet it opens cannot disagree. */
  changedCount: number;
  /** Commits on this branch not on its upstream, and the other way round — the
   *  same `## a...b [ahead N, behind M]` header the git view prints. ABSENT when
   *  the branch has no upstream (nothing to count against), never 0 for that. */
  ahead?: number;
  behind?: number;
  /** Whether the repo has an `origin` remote — where the git view pushes. `false`
   *  = local only, nothing to push to (the launcher says so). ABSENT = not known
   *  (an older host, or a count not taken yet) — never drawn as "no remote". */
  hasOrigin?: boolean;
  /** A git job the desktop is running in this worktree right now — a push (its
   *  pre-push checks take minutes) or a pull — so the launcher's git button can
   *  spin while it runs. ABSENT = none running (or an older host). */
  gitRunning?: "push" | "pull";
  /** What the host's own setup sweep last concluded about this worktree, when it
   *  has looked at all. Absent = never checked (a repo discovered seconds ago,
   *  or a host with the watcher switched off) — which is NOT the same as clean,
   *  so the UI must not badge on its absence. */
  setup?: RepoSetupState;
  /**
   * Whether an ENGINE can read this worktree — the gate on the repo-health
   * control.
   *
   * It used to mean "`tools/repohealth.mjs` exists in this worktree", and that
   * was the same question while the tool could only measure its own checkout.
   * It is not any more: the engine takes `--root=<path>` and derives what a
   * repo is written in, so the host answers with whichever engine it RESOLVED
   * — the worktree's own copy if it has one, else this desktop's bundled one.
   * `false` therefore means the desktop is holding no engine at all, which is
   * a fix beside the daemon and not a file to copy into the repo. The name is
   * unchanged on purpose: the wire is versioned, and renaming a field to
   * record a widened meaning costs every older client the control.
   *
   * **Absent means this HOST is older than the feature, NOT that the tool is
   * missing.** Read raw, `undefined` is falsy, so every repo on a desktop one
   * version behind would quietly lose a control that would work there, with no
   * sentence anywhere on the path — the mistake `local/no-raw-optional-cap`
   * exists to stop on `BackendInfo.caps`. Resolve it through
   * `repoHealthAvailability()` in `shared/repohealth.ts`, which has the third
   * state and the words for it.
   */
  hasRepoHealth?: boolean;
  /**
   * The live session whose agent made this worktree (`isolation: "worktree"`),
   * read off the CLI's own `subagents/*.meta.json`. The launcher draws the
   * worktree under that session's row. Absent = no live owner known; the row
   * stays with the repo's other worktrees.
   */
  ownerSessionId?: string;
  /**
   * The repo's health score (`shared/healthindex.ts`): one number out of 100
   * over the repo-health series, against fixed good values, every metric read
   * lower-is-better. `deltaWeek` is null on a gap or first scored week; `move`
   * is a CALLED move only (`assessHealthMove`); `mean`, `cappedBy` and `alert`
   * are absent from a host older than the absolute score. Absent = unknown —
   * no series or an older host — never 0.
   */
  healthIndex?: RepoHealthIndex;
}

/**
 * Whether a secondary worktree can go without losing anything — the answer to
 * `GET /api/repos/:id/worktree/leftover`, re-derived by the remove itself.
 *
 * A worktree nobody is in reads as clutter, and the only thing that makes
 * deleting one safe is knowing nothing lives ONLY there: no commit that is not
 * on the primary checkout's branch (by patch, so a cherry-picked agent commit
 * counts as landed), no uncommitted or untracked file, nothing in its
 * gitignored outbox/inbox, and no session running inside it. Each number is
 * the fact; `blockers` is the same facts as sentences, empty exactly when the
 * remove would go ahead.
 */
export interface WorktreeLeftover {
  branch: string;
  /** The branch the repo's primary checkout is on — "landed" means on this. */
  base: string;
  /** Commits on this worktree's HEAD whose SHA is not on `base`. */
  ahead: number;
  /** Of those, the ones whose CHANGE is not on `base` either (`git cherry`). */
  unlanded: number;
  /** `git status --porcelain` entries, untracked included. */
  uncommitted: number;
  /** Files under its `.claude/outbox/` + `.claude/inbox/` — gitignored, so no commit holds them. */
  transport: number;
  /** Sessions this host lists whose cwd is inside it. */
  sessions: number;
  /** The live session whose agent made it (`isolation: "worktree"`) is still open. */
  ownerLive: boolean;
  /** Minutes since git last touched it (its HEAD, index or reflog), or null when unreadable. */
  idleMinutes: number | null;
  /** Every reason it is not safe to remove, in words. Empty ⇔ safe. */
  blockers: string[];
}

/**
 * The setup checklist boiled down to what a repo row can show: the host checks
 * repos on its own (see host `setupwatch.ts`) so a repo that appeared while
 * nobody was looking still gets inspected, and this is the rollup the phone
 * badges from. Only REPO-scope checks count — a missing host-wide Gemini key is
 * not a fact about this repo and must not chip every row in the list.
 *
 * **The badge's GATE and the badge's STYLE are different questions, and both
 * are answered from the two numbers below — there is deliberately no third
 * field for either.**
 *
 *  - *Whether* the launcher chip renders is `issues > 0`. It was `!ok` once, and
 *    that was wrong in a way nothing complained about: most of these checks can
 *    only ever warn (context weight, tracked transport files, a `.env` that
 *    slipped through), so a repo whose setup sheet was full of amber showed
 *    nothing at all on the row that opens it. Measured when the context-weight
 *    row landed: the sheet said 35k chars of always-on instructions, the row
 *    said nothing. A thing to look at is still something to do, and it belongs
 *    on the row.
 *  - *How* it renders is `!ok` — red "issue" when something is genuinely broken,
 *    amber "thing to look at" when the findings are all warns.
 *  - *What the chip does NOT answer* is "where is the checklist" — it is a
 *    FINDINGS badge and is absent exactly when there is nothing to report, which
 *    includes a repo nobody has inspected. The repo's expanded menu carries a
 *    `repo setup · N` entry drawn whatever the verdict is; the two are not
 *    alternatives, and neither one's gate may be widened into the other's job.
 *
 * A separate `failing` field existed for a few hours and was deleted: it was the
 * exact complement of `ok` (`summarize()` computed one as `every(≠fail)` and the
 * other as `some(=fail)`), so it was a second wire name for one fact — and
 * `SetupWatcher`'s constructor, which rebuilds entries from `.waterplane/setup.json`,
 * did not read it back. After every `npm run restart` (routine here) a genuinely
 * failing repo therefore wore the amber style for up to `RECHECK_MS` = 6 hours.
 * Derive the style from `ok`; don't add the field back.
 */
export interface RepoSetupState {
  /** No repo-scope check is failing (warns allowed) — same rule as
   *  `ComplianceReport.ok`. The badge's STYLE, never its gate. */
  ok: boolean;
  /** Repo-scope checks that are not passing (fails + warns). The badge's GATE. */
  issues: number;
  /** Distinct one-tap fix ids among those issues. */
  fixable: number;
  /** When the worktree was last inspected. */
  checkedAt: number;
  /** When this worktree was first seen by the host — a repo the sweep has just
   *  met is the case this whole path exists for. */
  firstSeenAt: number;
}

/**
 * One row of the repo setup checklist — is this repo wired the way waterplane expects?
 * `status`: pass (compliant) · warn (works but should be fixed) · fail (broken/missing).
 * `fix`, when set, is the id to pass to the fix endpoint to auto-remediate.
 */
export interface ComplianceCheck {
  id: string;
  label: string;
  status: "pass" | "warn" | "fail";
  /** Human-readable explanation of the current state. */
  detail: string;
  /** Fix action id (POST .../compliance/fix) when auto-remediable, else null. */
  fix: string | null;
  /** `"host"` when the check is about the HOST, not this repo (the Gemini
   *  credential is one key for the whole daemon). Repo rollups skip these:
   *  otherwise one unset env var reads as "every repo is misconfigured".
   *  Absent = repo scope. */
  scope?: "host";
  /**
   * `context-weight` only: the always-on chars this check measured, as a
   * FIGURE rather than only as prose inside `detail`.
   *
   * One subject is now read by two clocks. This check weighs the WORKING TREE
   * as it stands; the repo-health series weighs the last commit it measured.
   * The sheet prints both side by side and reconciles neither, because an
   * uncommitted CLAUDE.md edit is precisely what a reader wants to see there.
   * Carried as a number because the alternative was prising it back out of
   * `detail` with a regex — a parser that would break silently the first time
   * anyone reworded the sentence.
   *
   * Absent on every other check, and on this one when there is no CLAUDE.md to
   * weigh. Never 0 for "not measured".
   */
  alwaysOnChars?: number;
  /**
   * A thing to CONSIDER, not a finding: a cost reading against a line
   * somebody chose (`context-weight`, `auto-compact`), where nothing is broken
   * and "leave it as it is" is a legitimate answer. It keeps its `warn`
   * status — the fact is still on that side of the line — but it is never
   * counted in the badge or "Fix all", and it may be `ignored` per repo.
   * Absent = an ordinary check. Which ids carry it is `ADVISORY_CHECKS`.
   */
  advisory?: true;
  /**
   * The person said "ignore this here" (`advisory` rows only). The row is
   * still measured and still sent — hiding it on the host would make "stop
   * ignoring" a guess about what it would say — the phone draws it folded.
   */
  ignored?: true;
}

/** The checks that are a thing to consider rather than a finding, and the only
 *  ones a person may ignore per repo. One list, read by both ends. */
export const ADVISORY_CHECKS: readonly string[] = ["context-weight", "auto-compact", "apk-install"];

/**
 * Whether one check is a FINDING — the predicate behind every setup number.
 *
 * Repo scope and not passing, which is exactly what the host's `summarize()`
 * counts into `RepoSetupState.issues`. It lives here because the phone filters
 * the same list to decide which rows to SHOW, and a badge that counts 3 beside
 * a sheet that lists 4 is a count that does not open what it counted — the
 * failure "a count on a control is a filter" names. One predicate feeding both
 * the number and the cut is the only shape in which they cannot disagree.
 *
 * Host scope is excluded for the reason `summarize()` gives: one unset
 * GEMINI_API_KEY is a fact about the daemon, and counting it would flag every
 * repo on the machine at once.
 */
export function isSetupFinding(c: ComplianceCheck): boolean {
  return c.scope !== "host" && c.status !== "pass" && !c.advisory && !c.ignored;
}

/**
 * Whether one check is an open thing to CONSIDER: an advisory row on the wrong
 * side of its line that nobody has ignored. Never a finding (see
 * `isSetupFinding`), so never counted — but still a row that offers its
 * remedy, because "consider" is a suggestion you can take, not one you can't.
 */
export function isSetupConsider(c: ComplianceCheck): boolean {
  return c.scope !== "host" && c.status !== "pass" && !!c.advisory && !c.ignored;
}

/** Full compliance report for one repo/worktree. */
export interface ComplianceReport {
  repoId: string;
  repoName: string;
  /** True when no check is failing (warns allowed). */
  ok: boolean;
  checks: ComplianceCheck[];
  /**
   * The context-weight thresholds this repo is measured against, and which
   * layer each came from (repo override > host env > shipped default).
   *
   * On the report rather than on the `context-weight` check, because it is true
   * of the repo whether or not that row is present: a repo with no CLAUDE.md
   * has nothing to weigh and no row, and the sheet must still be able to show —
   * and change — the line that will apply the moment it gets one.
   */
  contextLimits?: ContextLimitsView;
  /** When this repo's own override was written, or null when it has none. Shown
   *  ("set 3 days ago"), never used to decide anything. */
  contextLimitsSetAt?: number | null;
  /** What the `auto-compact` fix writes on this host — the Settings choice, or
   *  `AUTO_COMPACT_SUGGESTED` when nobody chose. Absent from an older desktop,
   *  which always wrote the suggested value. */
  autoCompactDefault?: string;
  /**
   * One-shot confirm tokens, one per `CONFIRM_GATED_FIXES` id this report offers, minted by the
   * host for THIS worktree (`host/confirmgate.ts`). The phone echoes the one for the fix its
   * second tap confirms (`POST …/compliance/fix` `{ fixes: [id], confirm }`); without it the host
   * refuses the fix. Absent from an older desktop, which needed none.
   */
  confirm?: Record<string, string>;
}

/** Result of ignoring (or un-ignoring) one advisory check in one repo.
 *  `ok:false` = nothing was stored, and `error` says why. */
export interface ComplianceIgnoreResult {
  ok: boolean;
  error?: string;
  report?: ComplianceReport;
}

/** Result of writing (or clearing) one repo's context-weight thresholds.
 *  `ok:false` means NOTHING was written — an out-of-range number is refused in
 *  words rather than stored as a repaired value the user never chose. */
export interface ComplianceLimitsResult {
  ok: boolean;
  error?: string;
  /** The re-run report, so the row re-states itself against the new line. */
  report?: ComplianceReport;
  limits?: ContextLimitsView;
}

/** Result of applying one or more fix actions, with the refreshed report. */
/** The desktop's own checklist (`GET /api/host/setup`): the `scope: "host"` rows, which no repo's checklist lists. */
export interface HostSetupReport {
  checks: ComplianceCheck[];
}

/** `POST /api/host/setup/fix`: what ran, in its own words, and the rows re-read. */
export interface HostSetupFixResult {
  ok: boolean;
  applied: string[];
  notes: string[];
  checks: ComplianceCheck[];
}

export interface ComplianceFixResult {
  ok: boolean;
  applied: string[];
  notes: string[];
  error?: string;
  report?: ComplianceReport;
}
