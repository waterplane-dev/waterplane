// healthindex/types: The vocabulary: entries, GOOD values and thresholds, the row and point DTOs. Barrel: ../healthindex.ts (read the header there).
import type { HealthCoverage, HealthCapKind } from "./coverage.js";
export const HEALTH_ENTRIES = [
  "size", "retouch", "hatches", "context", "untested",
  "dups", "deadExports", "cycles", "cochange", "fixAfterChange", "testsWithCode",
] as const;
export type HealthEntry = (typeof HEALTH_ENTRIES)[number];

/**
 * The entries a week may be scored WITHOUT: where the row's reading is absent
 * (`{value: null, reason}` — no parser for the language, a quiet window, a
 * shallow clone), the entry is UNKNOWN (`coverage.ts`): out of the mean, one
 * applicable dimension nobody measured, never 100. The first five predate
 * coverage and keep their old rule (any one absent = no score that week).
 * A row with NO field for one of these at all comes from an engine that never
 * took the reading; there the entry does not apply on that row (P2,
 * `docs/analysis/health-metrics/P2.md`).
 */
export const HEALTH_OPTIONAL_ENTRIES: readonly HealthEntry[] = [
  "dups", "deadExports", "cycles", "cochange", "fixAfterChange", "testsWithCode",
];
/** Entries where MORE is better: scored `100 · min(1, value / good)`, floored at `HEALTH_SCORE_FLOOR`. */
export const HEALTH_HIGHER_IS_BETTER: readonly HealthEntry[] = ["testsWithCode"];
/** The lowest score a higher-is-better entry can get: the geometric mean needs a score above 0. */
export const HEALTH_SCORE_FLOOR = 1;

/**
 * The GOOD value of each reading — at or under it, the entry scores 100.
 * Opinion, and PROVISIONAL: picked by the owner from the repos on this
 * desktop on 2026-10-17, not a published standard. `retouch` most of all (a
 * fortnight's rework rate has no long record behind it yet). A repo that
 * disagrees overrides the value it is compared with (`central`), never these.
 * `context` has none here: its good line IS the repo's own warn line
 * (`contextweight.ts`): the setup sheet calls a repo lean under it, so the index
 * must not call the same repo unhealthy.
 */
export const HEALTH_GOOD = {
  /** Line-weighted mean file length, lines. */
  lineMean: 500,
  /** Longest source file, lines. */
  max: 1_000,
  /** Share of source-file edits that rework the previous edit. Provisional. */
  retouch: 0.15,
  /** UNEXPLAINED escape hatches per 1,000 source lines. */
  hatches: 2.0,
  /** Share of source files no test reaches. */
  untested: 0.2,
  // The six below were calibrated on the HEAD of six owner repos on 2026-11-09
  // (table and argument: docs/analysis/health-metrics/P2.md). Provisional too.
  /** Near-duplicate block pairs per 1,000 lines the analyzer read (engine `dups.pairsPerKloc`). */
  dups: 0.25,
  /** Exports no other file names, per 1,000 source lines. */
  deadExports: 1.5,
  /** Share of import-graph files that sit in an import cycle. */
  cycles: 0.01,
  /** Median, over the busiest files, of how many other files in the same group change with one. */
  cochange: 5,
  /** Share of recent source commits that fix what another commit changed in the week before. */
  fixAfterChange: 0.1,
  /** Share of recent source commits that also change a test. HIGHER is better: at or OVER it scores 100. */
  testsWithCode: 0.5,
} as const;
/**
 * Context's good line, as a share of the repo's warn line: all of it. The setup
 * sheet calibrated that line so a well-organised repo is NOT flagged; a good
 * line at half of it made the two instruments disagree about one number.
 */
export const HEALTH_CONTEXT_GOOD_SHARE = 1.0;
/** The headline never sits more than this many points above its worst entry. */
export const HEALTH_SCORE_CAP_GAP = 30;
/** An entry scoring under this is a `warn` alert… */
export const HEALTH_ALERT_WARN = 50;
/** …and under this a `severe` one. */
export const HEALTH_ALERT_SEVERE = 25;
/** Links of history needed before a move is called at all. */
export const HEALTH_INDEX_MIN_WEEKS = 8;
/** Prior rolling four-week windows needed before a MONTH move is called. */
export const HEALTH_INDEX_MIN_MONTH_WINDOWS = 4;
/** Width of the month horizon, in weekly points. */
export const HEALTH_INDEX_MONTH_WEEKS = 4;
/** A move must sit below this percentile of its own past to be a drop… */
export const HEALTH_INDEX_LOW_PCT = 10;
/** …or above this one to be a rise. */
export const HEALTH_INDEX_HIGH_PCT = 90;
/** …AND move the score by at least this many points. */
export const HEALTH_INDEX_MIN_POINTS = 2;
/**
 * The context-weight warn line when the repo has none of its own: the setup
 * checklist's `DEFAULT_CONTEXT_LIMITS.maxChars` (`contextweight.ts`), restated
 * as a literal so this module carries no import cycle through the index.
 * Pinned equal to it by the test.
 */
export const HEALTH_INDEX_DEFAULT_WARN_CHARS = 16_000;
/** The engine's `context.reason` for a tree with no CLAUDE.md (`metrics/context.mjs`; a tools test pins the two equal). */
export const HEALTH_NO_CLAUDE_MD = "no CLAUDE.md at this commit";

/**
 * The fields of one series row this module reads. Everything is optional
 * because a row is parsed JSON: a family can be absent (`{value: null,
 * reason}`) or missing outright, and either way that entry is absent.
 */
export interface HealthSeriesRow {
  sha?: string;
  day: string;
  ts: number;
  batch?: boolean;
  prereg?: string;
  size?: { value?: { p95?: unknown; max?: unknown; maxPath?: unknown; lineMean?: unknown } | null } | null;
  retouch?: { value?: { rate?: unknown } | null } | null;
  hatches?: { value?: Record<string, unknown> | null } | null;
  context?: { value?: { claudeMdChars?: unknown; descChars?: unknown } | null; reason?: unknown } | null;
  untested?: { value?: unknown[] | null } | null;
  dups?: { value?: { pairsPerKloc?: unknown } | null; reason?: unknown } | null;
  deadExports?: { value?: unknown[] | null; reason?: unknown } | null;
  graph?: { value?: { files?: unknown; cycleFiles?: unknown } | null; reason?: unknown } | null;
  cochange?: { value?: { hotspots?: unknown } | null; reason?: unknown } | null;
  habits?: { value?: { fix?: unknown; testsWithCode?: unknown } | null; reason?: unknown } | null;
  classics?: { value?: { loc?: unknown; files?: unknown } | null } | null;
  /** The repo's disables and overrides in force on this row; absent = none. */
  central?: HealthRowCentral | null;
  /** Which index dimensions each active pack could read (engine `reach.mjs`); absent = an older engine. Read by `coverage.ts`. */
  reach?: { value?: { packs?: unknown } | null } | null;
  /** The repo's own readings (engine `own.mjs`), HEAD rows only. The index reads only their `gate`s (`coverage.ts`). */
  own?: { readings?: unknown; gates?: unknown; refused?: unknown; unreadGates?: unknown; notRun?: unknown } | null;
}

/** `row.central` — written by the engine's `central.mjs`. */
export interface HealthRowCentral {
  /** Fingerprint of what was APPLIED on this row; "" (or absent) = nothing. */
  fp?: unknown;
  disabled?: Record<string, { why?: unknown } | null> | null;
  override?: Record<string, { value?: unknown; why?: unknown } | null> | null;
}

/** Size's two sub-readings, each with its value and score. */
export interface HealthSizeParts {
  lineMean: { value: number; score: number };
  max: { value: number; score: number; path: string | null };
}

/** Which reading an alert is about: an entry, or one of size's two sub-readings. */
export type HealthAlertSubject = Exclude<HealthEntry, "size"> | "lineMean" | "max";

export interface HealthAlert {
  level: "warn" | "severe";
  /** The entry the alert counts against (`size` for both sub-readings). */
  entry: HealthEntry;
  subject: HealthAlertSubject;
  /** The value read (after any override) and its good line. */
  value: number;
  good: number;
  score: number;
  /** The longest file's path, on a `max` alert where the engine named it. */
  path?: string;
  /** One sentence: `severe: lib/a.dart is 8,397 lines (good: under 1,000)`. */
  text: string;
}

export interface HealthIndexPoint {
  /** The ISO week's Monday, `YYYY-MM-DD` (UTC). */
  week: string;
  /** The headline SCORE, 0–100: `min(mean, worst + HEALTH_SCORE_CAP_GAP, coverage cap, gate cap)` (`coverage.ts`). */
  index: number;
  /** Geometric mean of the MEASURED entries' scores (an unknown entry is out), before any cap. */
  mean: number;
  /** Each measured entry's score, 0–100 (an unknown entry has none). */
  scores: Partial<Record<HealthEntry, number>>;
  /** Size's two sub-readings; null where size is disabled. */
  sizeParts: HealthSizeParts | null;
  /** The worst entry when the WORST-ENTRY cap set the headline, else null. */
  cappedBy: HealthEntry | null;
  /** Which cap set the headline; null when the mean did. Optional: absent from an older host. */
  capKind?: HealthCapKind | null;
  /** What applied this week, what was measured, and the repo's gates. Optional: absent from an older host. */
  coverage?: HealthCoverage;
  /** Every entry or size sub-reading under `HEALTH_ALERT_WARN`, worst first. */
  alerts: HealthAlert[];
  /** A prereg or `central` change since the previous scored week: the score
   *  stands as measured, but the link is not used to call a move. */
  gap: boolean;
  /** `ln(index / previous index)`; `null` on the first scored week and on a gap. */
  lnLink: number | null;
  /** How many entries the contributions split the mean's move over (0 on the first week and a gap). */
  comparable: number;
  /**
   * Each entry's share of the MEAN's move, in LOG POINTS:
   * `prevMean · (ln s_cur − ln s_prev) / n`. Log points are what is additive —
   * the terms of a geometric mean add in log space — so these sum EXACTLY to
   * `prevMean · ln(mean / prevMean)`. Negative = that entry's score fell
   * (its metric rose). The cap is explained apart, by `cappedBy`.
   */
  contributions: Partial<Record<HealthEntry, number>>;
  /** The values read this week (after any override); size's is `lineMean`. */
  values: Partial<Record<HealthEntry, number>>;
  prereg: string | null;
  /**
   * Days since the previous SCORED week (Monday to Monday, so a multiple of
   * 7); null on the first. A week with no commit has no row, and a week with a
   * partial basket has no score, so a link over 7 days spans weeks with no
   * score — a reader should be told before reading it as one week's move.
   */
  spanDays: number | null;
  /** Why a gap was marked: the engine's definition moved, or the repo's own
   *  `central` config moved. (`nothing` is no longer produced: every scored
   *  week has every enabled entry.) */
  gapReason?: "prereg" | "central" | "coverage" | "nothing";
  /** The repo's `central` fingerprint this week; "" = none applied. */
  central: string;
  /** Entries the repo disabled this week — out of the mean, not absent readings. */
  disabled: HealthEntry[];
  /** Entries whose value this week is the repo's override, not the engine's. */
  overridden: HealthEntry[];
  /** Source files and lines this week (`classics`), so growth can be stated;
   *  null where that reading was absent. */
  tree: { files: number; loc: number } | null;
}

export interface HealthIndexSeries {
  /** The first SCORED week — no longer a "100", just where the line starts. */
  baselineWeek: string;
  /** One point per scored week, oldest first. */
  points: HealthIndexPoint[];
}
