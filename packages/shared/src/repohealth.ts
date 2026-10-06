/**
 * The repo-health series as both ends must read it.
 *
 * `tools/repohealth.mjs` measures A repo against its own git history — LOC,
 * escape hatches, co-change, untested modules — and appends one row per commit
 * to that repo's `<state dir>/repohealth.jsonl`. It costs nothing: git, regex and
 * arithmetic, no model call anywhere on the path a button can reach. The phone
 * shows the narrative it writes and offers to refresh it.
 *
 * ── The engine is not the repo ──────────────────────────────────────────────
 *
 * That tool used to be able to measure exactly one tree: its own. A repo
 * without a copy of it had no readings at all, which was twelve of the thirteen
 * repos on this desktop. It now takes `--root=<path>` and derives what a repo
 * is written in, so ONE engine reads every tree — and the words here changed
 * with it. `REPOHEALTH_TOOL` is still the one spelling of the path, but a path
 * to a script that may be the worktree's own copy or the desktop's bundled one:
 * `host/repohealth.ts` resolves which, and `RepoHealthView.engine` says which
 * it was. So "this repo has no repo-health" is no longer a sentence about a
 * missing file in the repo — the only way to have no reading now is for the
 * DESKTOP to have no engine, and `repoHealthUnavailableText` says that instead.
 *
 * ── What is here, and what is one file over ────────────────────────────────
 *
 * This file is the SHAPES and the WORDS: the paths both ends name, the types a
 * status and a plot arrive as, and the sentence for each state where there is
 * nothing to draw. Reading one run's stdout, stderr and exit code INTO those
 * shapes is `repohealthread.ts`, and the two are split because they fail
 * differently: a wrong sentence here is read by a person, a dropped field
 * there is read by nobody. Both are imported from `@waterplane/shared` and no call
 * site names either file.
 *
 * ── Nothing here applies itself ────────────────────────────────────────────
 *
 * It states paths, shapes and sentences. The refresh, the write and the
 * refusal to overwrite are the host's.
 */
import { stateRel } from "./brand.js";

/** The tool, from a repo root — the one spelling of the path that runs it.
 *  It is where a repo's OWN copy lives and where the desktop's bundled engine
 *  sits inside this checkout; which of the two ran is `RepoHealthView.engine`. */
export const REPOHEALTH_TOOL = "tools/repohealth.mjs";
/**
 * How a sentence NAMES the thing that ran, when it cannot honestly name a path.
 *
 * `classifyExit`'s errors used to open with `tools/repohealth.mjs`, which was
 * true while the only engine a repo could have was its own. It is a lie the
 * moment the desktop's bundled engine reads a Kotlin repo: the reader goes
 * looking in the tree they are standing in for a file that was never there.
 * The subject is the ENGINE, and which engine it was rides on the view.
 */
export const REPOHEALTH_ENGINE = "the repo-health engine";
/** The narrative `narrate` writes. In the outbox because it is written for a
 *  person to read: that is what the phone's gallery and the repo badge watch. */
export const REPOHEALTH_MD = ".claude/outbox/repohealth.md";
/** The plotted page `html` writes, beside its narrative. */
export const REPOHEALTH_HTML = ".claude/outbox/repohealth.html";
/** The append-only series itself — measurements, not an artifact to look at,
 *  hence the state dir and not the outbox. Under the CURRENT name; the engine
 *  (`tools/repohealth/statefile.mjs`) still reads one left under a legacy name. */
export const REPOHEALTH_SERIES = stateRel("repohealth.jsonl");

/** What is on disk: how much history has been measured, and under which
 *  definition of the metrics. */
export interface RepoHealthSeries {
  /** The `PREREG_VERSION` the most recent rows were measured under. */
  preregVersion: string;
  /** Rows (one per commit) and the days they reduce to. */
  rows: number;
  days: number;
  /** The last commit measured, and when it landed. */
  lastSha: string;
  lastDay: string;
  /**
   * MILLISECONDS, converted here — git speaks seconds and everything else on
   * this wire speaks milliseconds. Read raw, a 2026 commit renders as 1970 and
   * the phone says "last commit 690mo ago", which is what shipped before this
   * comment existed. `lastDay` stays the tool's own `%ci` day string and is
   * never derived from this number: the day belongs to the COMMIT's timezone,
   * not the reader's.
   */
  lastTs: number;
  /** Every definition present in the file. More than one ⇒ the next `update`
   *  REFUSES (exit 3) rather than mixing them; this is what lets the phone say
   *  so before the person taps refresh. */
  versions: { version: string; rows: number }[];
  /** Rows whose commit is no longer on first-parent — a rebase or an amend.
   *  Read past, left in the file, and reported at 0 as well, because a
   *  rewritten branch nobody mentions is exactly how one goes unnoticed. */
  staleRows: number;
}

/**
 * One language pack the engine activated on this tree, and what activated it.
 *
 * `files` is the extension census's count, which is the DENOMINATOR for every
 * absence a row carries: "duplication absent, no parser for Kotlin" means
 * something different over 4 Kotlin files and over 400. A pack with no count
 * is not a pack that read nothing — it is one that did not say — so the field
 * is nullable like every other reading here.
 */
export interface RepoHealthPack {
  name: string;
  version: string;
  files: number | null;
}

/**
 * What the ENGINE says about this tree, as opposed to what the SERIES says
 * about its own history.
 *
 * Every field is separately optional, and that is the whole shape of it. These
 * arrived on `status` after the engine learned `--root`, so a worktree
 * carrying its own older copy of the tool prints none of them — and the answer
 * to "which packs?" from such a repo is *it did not say*, never an empty list.
 * An empty `packs` array would read on screen as "this engine could read
 * nothing here", which is a measurement, and a wrong one.
 *
 * Why these five and not a second subcommand: `RepoHealthStep` is a closed
 * union with a text assertion behind it, so a new verb is a change in three
 * places and a field is a change in one. Each answers a question that cannot
 * be asked at all on a repo with an empty series, where `preregVersion` falls
 * back to the engine's own and everything else on `status` is null or 0.
 */
export interface RepoHealthMeasure {
  /**
   * First-parent commits at HEAD — the SIZE OF THE JOB before any row exists.
   * It is what makes "0 rows" readable as "1,329 commits to walk" rather than
   * as "nothing here", and those two want opposite things from the reader.
   */
  commits: number | null;
  /** The packs the extension census activated, newest reading. */
  packs: RepoHealthPack[] | null;
  /** The boundaries co-change stops at and LOC is broken down by, derived at
   *  HEAD by the same function each snapshot uses. */
  groups: string[] | null;
  /**
   * The definition the NEXT row would be written under, whatever the rows on
   * disk say. `RepoHealthSeries.preregVersion` is the SERIES'; these two
   * differ exactly when a re-cut is pending, which is the thing a reader
   * looking at a refusal is trying to find out.
   */
  engineVersion: string | null;
  /**
   * The exact command that re-cuts this root with this engine, ABSOLUTE on
   * both paths. Carried and never composed: a client-side copy would be right
   * in the engine's own repo and wrong in every other tree it measures, and
   * this command deletes a file.
   */
  recut: string | null;
  /**
   * The subtree this `status` was taken over, echoed by the engine — `null`
   * for the whole repo, and ABSENT from an engine that has no scopes at all.
   *
   * The echo is the only way to tell those two apart, and telling them apart
   * is load-bearing: a repo carrying its own older copy of the engine ignores
   * an unknown flag rather than failing on it, so a scoped run against one
   * would measure the WHOLE repo and write it into the subtree's series file.
   * A reading of the wrong tree, under the right name, with nothing saying so.
   * The daemon compares what it asked for against this and refuses when they
   * disagree.
   */
  scope?: string | null;
}

/** A refresh the host has in flight. `note` is what it is doing, when it said. */
export interface RepoHealthRun {
  state: "running";
  startedAt: number;
  note: string | null;
}

/** How the last refresh ended. `refused` and `error` are different outcomes and
 *  never both set: one is the tool working, the other is the tool failing. */
export interface RepoHealthOutcome {
  at: number;
  ok: boolean;
  ms: number;
  /** Which of the three steps it got to, or null when it never started one. */
  step: "update" | "narrate" | "html" | null;
  /** Exit 3: the tool ran and declined to append. `text` is its stderr
   *  VERBATIM — it contains the remedy, and the remedy deletes a file. */
  refused: { code: number; text: string } | null;
  /** Exit 1 or anything else unexpected, as one sentence. */
  error: string | null;
  /** Rows appended by `update`, or null when the summary could not be read —
   *  which is not the same as 0, and 0 is what "nothing new" means. */
  added: number | null;
  warnings: string[];
}

/**
 * ── The plot: the TOOL states, the PHONE draws ──────────────────────────────
 *
 * `plot` prints one JSON line holding every series as points, plus, for each
 * of them, the comparators the tool computed: the percentile rank inside its
 * trailing window, the sign of the slope, how many readings that window
 * actually held, the day it opens, and the reason an absence exists. The phone
 * turns days and values into pixel coordinates and computes nothing else.
 *
 * That split is not tidiness. The READING is defined once, in
 * `tools/repohealth/narrate.mjs`, beside a frozen constants block whose
 * changes are made loud by a committed fixture. A percentile re-derived on the
 * drawing end would sit outside that mechanism: it would agree the day it was
 * written and drift the first time `RANK_WINDOW_DAYS` moved, with every past
 * day silently re-read and nothing saying so. `windowReadings` and
 * `minReadings` travel on the wire for the same reason — so no client ever
 * writes 60 or 14 down.
 *
 * There is no instant on a point, deliberately. The day string is the x label;
 * `lastTs` is converted in `secondsToMs` at this boundary because git speaks
 * seconds, and a raw `ts` on 130 points would re-open that trap on a field
 * nothing needs.
 */

/** One day of one series. `v: null` = no reading that day — the line is CUT
 *  there, never interpolated and never drawn at zero. */
export interface RepoHealthPoint {
  day: string;
  /** The day's commit, short. A point can always be traced to a tree. */
  sha7: string;
  v: number | null;
}

/** A value read against its own past: where it sits in the trailing window and
 *  which way the window is going. Both `null` ⇒ `reason` says why. */
export interface RepoHealthReading {
  /** Percentile as a FRACTION in [0,1]. Two scales for this once shipped every
   *  percentile in production as `0th`; anything off the scale voids the plot. */
  rank: number | null;
  slope: "rising" | "falling" | "flat" | null;
  /** READINGS in the window, not calendar days — absences are dropped before
   *  the cut, so `n` and the span between `from` and today differ. */
  n: number;
  from: string | null;
  /** Present only when there is no rank. Never an empty string. */
  reason?: string;
}

export interface RepoHealthPlotSeries {
  /** `size.p95`, `retouch.rate`, … — the tool's own key, never re-derived. */
  key: string;
  /** A noun phrase that reads as the subject of "…is now". Printed verbatim. */
  label: string;
  /** Appended to a value; `""` for a dimensionless rate. */
  unit: string;
  points: RepoHealthPoint[];
  /** The latest day's value, or null when that day has none. */
  last: number | null;
  reading: RepoHealthReading;
  /** The second sentence: the numbers behind the value — a rate's denominator,
   *  a rate's payload. `""` when the series has nothing to add. */
  detail: string;
  /** Set when the family read NOTHING on the latest day, carrying the metric's
   *  own reason. An absent family is never drawn as zeros. */
  absent?: string;
}

/** One area's always-on context weight, latest day. Every number is nullable
 *  because a reading that could not be taken is absent, not 0. */
export interface RepoHealthArea {
  expected: number | null;
  ceiling: number | null;
  p90: number | null;
  commits: number | null;
  subs: number | null;
  /**
   * Why this area's numbers are the nulls they are, in the metric's own words.
   *
   * There are two kinds of null here and they want opposite readings. An area
   * no commit has touched yet has no usual load — the honest sentence is "no
   * commit has touched this area yet". An area whose ROUTER description names
   * no source group can never be attributed a commit at all, however many
   * land in it: `ceiling` is still a real number and the other three are null
   * for ever. Reading the nulls and inferring which is the reader doing the
   * measurement's job from the outside, so the metric says it and
   * `areaRowWords` prefers this over its own guess.
   *
   * Absent when the area HAS its readings — never an empty string, which is
   * the shape a client prints as a blank excuse.
   */
  reason?: string;
}

export interface RepoHealthPlotContext {
  /** Keyed by area (`host`, `shared`, `web`). Empty when nothing was read. */
  areas: Record<string, RepoHealthArea>;
  absent?: string;
  /**
   * Why `areas` is EMPTY, which is not the same fact as `absent`.
   *
   * `absent` is the whole family unread on the latest day — no CLAUDE.md, no
   * `.claude/skills` — and the repo-wide weight goes with it. This one is a
   * family that WAS read and yielded no per-area rows: either no skill in the
   * tree routes to another (no `<router>-*` convention, which is most repos on
   * this desktop), or the routers there are not among the skills counted. On a
   * chart `{}` and "this repo does not work that way" are the same blank, and
   * this is the sentence that tells them apart.
   */
  areasAbsent?: string;
}

export interface RepoHealthPlotClassics {
  loc: RepoHealthPoint[];
  files: RepoHealthPoint[];
  /** Production dependencies. `devDeps` is a different count and never summed
   *  into this one. */
  deps: RepoHealthPoint[];
  /**
   * One source group, in NAME order, carrying the tool's own statement of
   * which are the big ones: `rank` 0 is the largest on the latest day, ties by
   * name. The phone folds all past its palette into one hueless band, and with
   * name order deciding that too it kept `.` (158 lines), `deploy` (122) and
   * `packages/app` (140) and folded `packages/web` (80,062) away. WHICH groups matter is the tree's fact and
   * the tool's to state; HOW MANY fit is the palette's and stays on the phone,
   * where a hue is still assigned by name among the kept. Optional: an engine
   * predating it says nothing and the drawing end folds by position as before;
   * a `rank` that is not a count is dropped rather than voiding the plot.
   */
  packages: { pkg: string; rank?: number; points: RepoHealthPoint[] }[];
  /**
   * The same source lines cut by file TYPE instead of by group — one entry per
   * extension the active packs claim, in name order, with the same `rank` the
   * groups carry so the fold keeps the big ones.
   *
   * A group says which part of the tree grew; a type says what grew in it. In
   * a monorepo the two answers coincide often enough that having only one of
   * them is how a reader concludes the wrong thing about the other.
   *
   * `pack` is the language pack that claims the extension, so a filter can
   * speak in languages as well as in suffixes; null where no active pack
   * claims it, which is a fact and not a blank. `files` is that type's file
   * count on the latest day — the denominator for "12,228 lines of .mjs".
   *
   * Optional: an engine older than the field says nothing, and the section is
   * then absent rather than drawn empty.
   */
  types?: { ext: string; pack: string | null; rank: number; files: number | null; points: RepoHealthPoint[] }[];
  /** Lines per source file on the latest day, biggest first, capped by the
   *  tool. A distribution of today, not a series — null when there is none. */
  tape: number[] | null;
  /** The tape's paths, index for index — `tapePaths[i]` names `tape[i]`, null
   *  where the row held no path. Relative to the plot's `scope`. Optional: an
   *  engine older than the field sends none, and the bars are then drawn with
   *  no name to tap for. */
  tapePaths?: (string | null)[];
  absent?: string;
}

/**
 * The longest source file: its length over the series, and its name today.
 *
 * Not a `series` entry — those are pre-registered in the tool and each one is
 * a narrative subject. This is the one figure the drawn HTML page carried and
 * the phone could not, which is the difference between "the sheet holds every
 * card that page has" and a claim that is false by one number and one string.
 *
 * `path` and `day` are the LATEST reading's, and they travel together: a file
 * growing 400 lines and a different file taking the crown are opposite events
 * with the same number, so a name with no day beside it is the half of the
 * pair that can mislead. `path` is null when the latest day read no size.
 */
export interface RepoHealthLongest {
  points: RepoHealthPoint[];
  /** Which file held the crown on each reading, index for index with
   *  `points`; null where that row named none. Optional: an engine older than
   *  the field sends none, and the chart then draws the length unnamed. */
  paths?: (string | null)[];
  path: string | null;
  day: string | null;
}

export interface RepoHealthPlot {
  /**
   * The subtree these readings are of, or null for the whole repo.
   *
   * It travels because every PATH in this document is relative to it: a scoped
   * plot's longest file is `src/App.tsx` where the repo's is
   * `apps/ba3-web/src/App.tsx`, and a reader handed the first with no scope
   * beside it has a path that does not resolve. Optional, so an engine older
   * than scopes is read as the repo-wide reading it is.
   */
  scope?: string | null;
  preregVersion: string;
  /** `PREREG.RANK_WINDOW_DAYS` — the window a rank was taken in. */
  windowReadings: number;
  /** `PREREG.RANK_MIN_POINTS` — the shortest history that gets a rank at all. */
  minReadings: number;
  /** Day-rows in the series. Every `points` array is exactly this long, so any
   *  one of them gives the x axis. */
  days: number;
  series: RepoHealthPlotSeries[];
  context: RepoHealthPlotContext;
  classics: RepoHealthPlotClassics;
  /** Absent on a host or a tool older than the field — the sheet then draws
   *  the column and the name it has, never a blank it presents as a reading. */
  longest?: RepoHealthLongest;
}

/** Everything a repo row and its sheet need, in one read. */
export interface RepoHealthView {
  /**
   * WHICH reading this is: a subtree of the repo, or null for the whole thing.
   *
   * Echoed on every answer, including the ones where nothing ran. Every path
   * in a scoped view — the longest file, the re-touch offenders, the groups —
   * is relative to it, so a client holding a view with no scope beside it
   * cannot print a path that resolves.
   */
  scope: string | null;
  /**
   * The subtrees this repo is configured to measure separately, in the order
   * they were stored.
   *
   * A fact about the repo rather than about this reading, so it rides on the
   * scoped views too: the picker that switches between them is drawn from this
   * list, and it has to be there whichever reading is on screen.
   */
  scopes: string[];
  /**
   * Whether ANY engine can read this worktree — which is not the same question
   * it used to be.
   *
   * It used to mean "`tools/repohealth.mjs` is in this repo", and on a desktop
   * whose engine reads every tree that question has no consequences. `false`
   * now means the DESKTOP has no engine at all: not the repo's own copy, not
   * the bundled one, not `<PREFIX>REPOHEALTH_ENGINE`. `engine` below says which
   * of the two answered when this is true.
   */
  tool: boolean;
  /**
   * Which engine read this worktree, or null when none could.
   *
   * `repo` is the worktree's own `tools/repohealth.mjs` and it wins, because a
   * repo carrying the tool is the authority on its own root. `bundled` is this
   * desktop's, pointed at the worktree with `--root=`. Worth saying out loud
   * on a screen: the two can be different versions of the engine, and a
   * reading that moved because the engine changed is a different event from
   * one that moved because the code did.
   */
  engine: { kind: "repo" | "bundled" } | null;
  /** The repo's own HEAD, so "measured through" can be compared to "now". */
  head: { sha: string; ts: number } | null;
  series: RepoHealthSeries | null;
  /**
   * What the engine says about this tree — packs, groups, the size of the job,
   * the re-cut line. `null` when the engine printed none of it (an older copy
   * in a repo of its own) or when `status` could not be read at all.
   */
  measure: RepoHealthMeasure | null;
  /**
   * Why this read has no series to show, in the engine's own words — or null
   * when nothing went wrong.
   *
   * A failed `status` used to be `series: null` and silence, which on screen
   * is indistinguishable from a repo nobody has measured yet: one wants a tap
   * on *refresh* and the other wants a person to look at why the engine could
   * not read the tree ("not a git repository: …"). This is `classifyExit`'s
   * sentence for that exit, or the desktop-has-no-engine sentence when there
   * was nothing to run. It explains an absence; it never stands in for one.
   */
  readError: string | null;
  /**
   * The cap ONE step of the engine gets on this desktop, in ms
   * (`<PREFIX>REPOHEALTH_TIMEOUT_MS`). Sent because a backfill's honest wait is a
   * fact about the desktop and not about the repo: a phone that has to say
   * "this can take a few minutes" must not hold its own copy of a number the
   * desktop can change.
   */
  stepTimeoutMs: number;
  /** First-parent commits after `lastSha`. **null = could not tell** (no
   *  series, or a sha the live history no longer contains) — never 0, which is
   *  the claim that the plot is current. */
  behind: number | null;
  narrative: { text: string; mtime: number; relPath: string } | null;
  page: { relPath: string; mtime: number } | null;
  run: RepoHealthRun | null;
  last: RepoHealthOutcome | null;
  /**
   * The plottable series — and the field is OPTIONAL on purpose, because
   * three things can be true and only two of them are "no chart".
   *
   *  - **absent** — this HOST predates `plot`. It has no answer, which is not
   *    the answer "nothing to plot", and the fix is upgrading the desktop.
   *  - **`null`** — the tool ran and said nothing usable (no series yet, or a
   *    line that did not survive validation).
   *  - **an object** — draw it.
   *
   * Read raw, `undefined` is falsy and the first state silently becomes the
   * second, with no sentence anywhere on the path — the mistake
   * `local/no-raw-optional-cap` exists to stop on `BackendInfo.caps` and the
   * same one `hasRepoHealth` carries. Resolve it through
   * `repoHealthPlotAvailability()`.
   */
  plot?: RepoHealthPlot | null;
  /**
   * Why `plot` is null, when the ENGINE is the reason — and null when it is
   * not, which includes the ordinary "nothing measured yet".
   *
   * `plot: null` says a chart could not be drawn; it does not say whether a
   * tap on *refresh* would change that. Those are opposite answers. A repo
   * with no series yet is one tap from a chart. A repo carrying its own copy
   * of the engine that is older than the `plot` subcommand exits 2 on it
   * every time, and a repo that ships the tool is read with its own copy —
   * so no tap on that screen can ever help, and the standing sentence sent
   * the reader to press it anyway. This carries the engine's own reason, the
   * way `readError` does for the series, and the sheet prints it instead of
   * the remedy that does not apply.
   *
   * Optional and nullable: an older desktop sends no such field, which is the
   * same nothing-to-say as `null`, because this is a sentence and not a
   * capability.
   */
  plotError?: string | null;
  readAt: number;
}

/**
 * Whether this repo offers repo-health at all — resolved here and nowhere else.
 *
 * `RepoTarget.hasRepoHealth` is OPTIONAL on the wire, and an absent field means
 * the HOST is older than the feature: that desktop has no answer, not the
 * answer "no". Read raw, `undefined` is falsy, so the control would vanish with
 * no sentence anywhere on the path — the same mistake `local/no-raw-optional-cap`
 * exists to stop on `BackendInfo.caps`. Three states, and the third one is not
 * a shrug: it is the only state whose fix is upgrading the desktop.
 */
export type RepoHealthAvailability = "offered" | "absent" | "unknown";

export function repoHealthAvailability(
  repo: { hasRepoHealth?: boolean } | null | undefined,
): RepoHealthAvailability {
  if (!repo || typeof repo.hasRepoHealth !== "boolean") return "unknown";
  return repo.hasRepoHealth ? "offered" : "absent";
}

/**
 * Why the control is not here, for `Unavailable.tsx` — never a greyed button,
 * and null when there is nothing to explain.
 *
 * `absent` used to say the REPO was missing `tools/repohealth.mjs`, and that
 * sentence sent the reader to copy 10k lines into their repo. It is the wrong
 * address now: one engine reads every tree, so the only way to have no reading
 * is for the desktop to be holding no engine — which is a fix on the desktop,
 * next to the daemon, and the sentence has to say so or it aims the reader at
 * the one thing that will not help.
 */
export function repoHealthUnavailableText(a: RepoHealthAvailability): string | null {
  if (a === "absent") {
    return `No repo-health engine on this desktop — neither this repo's own ${REPOHEALTH_TOOL} ` +
      `nor a bundled one was found, so there is nothing to read the history with.`;
  }
  if (a === "unknown") return "This desktop is older than repo health and cannot say whether this repo has it.";
  return null;
}

/**
 * The same three states for the PLOT, and the third one is again not a shrug.
 *
 * `plot` is an optional field: absent means this host cannot answer, `null`
 * means it answered nothing. Collapsing the two would draw the same empty
 * panel over two different next actions — upgrade the desktop, or measure the
 * series — and the reader cannot tell them apart from a blank chart.
 */
export type RepoHealthPlotAvailability = "plotted" | "none" | "unknown";

export function repoHealthPlotAvailability(
  view: { plot?: RepoHealthPlot | null } | null | undefined,
): RepoHealthPlotAvailability {
  if (!view || !("plot" in view) || view.plot === undefined) return "unknown";
  return view.plot === null ? "none" : "plotted";
}

/**
 * Why there is no chart, in words — never a greyed control, and null when
 * there is a chart to draw.
 *
 * `reason` is `RepoHealthView.plotError`: the engine's own account of why the
 * read produced nothing, carried only when the ENGINE is the reason. Where
 * there is one it REPLACES the standing sentence rather than joining it,
 * because the standing sentence ends in a remedy — *refresh it to measure
 * one* — and the whole point of the field is that in these cases refreshing
 * cannot help. Two sentences, one of them telling the reader to press a
 * button that will do nothing, is worse than the one that is true.
 */
export function repoHealthPlotUnavailableText(
  a: RepoHealthPlotAvailability,
  reason?: string | null,
): string | null {
  if (a === "none") {
    if (typeof reason === "string" && reason.length > 0) return reason;
    return `${REPOHEALTH_ENGINE} read no series to plot here — refresh it to measure one.`;
  }
  if (a === "unknown") return "This desktop is older than the repo-health plot and sent no series to draw.";
  return null;
}

