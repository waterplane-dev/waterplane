/**
 * The health score — ONE number per repo, read week by week from the
 * repo-health series (`<repo>/.waterplane/repohealth.jsonl`) against fixed
 * "good" values, capped by its worst entry, with the week-over-week trend as a
 * second line beneath it.
 *
 * **This is the one layer that judges.** The series and every sentence the
 * engine and the phone write about it stay unjudged: a reading compared to its
 * own past has no side to be on. The owner approved (2026-10-15) a separate
 * number that DOES take a side, and the side is the same for every input: each
 * metric is read as lower-is-better. That opinion lives here and nowhere else.
 *
 * Why it is ABSOLUTE now, and not chained (owner, 2026-10-17):
 *
 * - **A chained index measures a repo against itself, so a repo that was bad
 *   at its own baseline read 100.** The first version set 100 at the repo's
 *   first full week and chained ratios from there. picture-app's baseline week
 *   (2026-05-25) already had a 4,764-line file; by October the same file was
 *   8,397 lines and the headline still said 95. A number that calls the worst
 *   file in the desktop's repos "about as healthy as ever" is not a health
 *   number. So every entry is now scored against one GOOD value per metric:
 *   `100 · min(1, good / value)` — 100 at or under good, halving as the
 *   reading doubles past it.
 * - **The cap: an average of five buried an 8,397-line file.** A geometric
 *   mean lets four quiet entries outvote one on fire: before the cap
 *   picture-app averaged 66 and this repo 63 — the repo with the giant file
 *   looked the healthier of the two. So the headline is
 *   `min(mean, worst + HEALTH_SCORE_CAP_GAP)`: no repo scores more than 30
 *   above its worst entry, and `cappedBy` names that entry whenever the cap is
 *   what set the number, so the reader is told which reading holds it down.
 * - **Size reads the giant files.** The p95 the first version read is blind
 *   to the top 5% — one huge file barely moves it. Size is now two readings,
 *   blended geometrically: `lineMean` (the line-weighted mean file length,
 *   "the length of the file the average line lives in", which a giant file
 *   drags up in proportion to its weight) and `max` (the longest file).
 * - **The GOOD values are opinion, and provisional** (`HEALTH_GOOD`): numbers
 *   the owner picked from the repos on this desktop, not a standard. A repo
 *   that disagrees overrides the entry in its committed `health.json`
 *   (`central`, `tools/repohealth/central.mjs`) — the override replaces the
 *   VALUE read, never the good line — or disables it.
 *
 * The rest of the arithmetic, and why:
 *
 * - **Weeks, last row wins.** Rows bucket to ISO weeks (Monday start, UTC, off
 *   the row's own `day` string) and the LAST row of each week (greatest `ts`)
 *   is its reading — `perDay`'s semantics one level up: every family here is a
 *   STATE of the tree, and a state read earlier in the week is just an older
 *   reading. Batch rows are kept, as `perDay` keeps them.
 * - **No score over a partial basket.** A week where any ENABLED entry is
 *   absent has no score and no point — a score over four of five entries would
 *   read as a jump the week the fifth came back. Size needs BOTH `lineMean`
 *   and `max`, so rows from engines before `lineMean` existed score nothing;
 *   history comes back by re-measuring, never by guessing.
 * - **The trend is the second line.** Between consecutive SCORED weeks,
 *   `lnLink = ln(score / previous score)` feeds the move detector
 *   (`assessHealthMove`) exactly as the chained links did. A prereg or
 *   `central` change still marks the week `gap` — the link across it is not
 *   used to call a move, because the definitions moved — but the score itself
 *   is shown as measured: an absolute score has nothing to carry.
 * - **Nothing here invents a reading**: a value that is not a finite number is
 *   absent for that week; no scored week means no series (`null`), never a
 *   number nobody measured.
 * - **A repo may disable or override an entry.** Disabled: the entry leaves
 *   the mean, the cap and the alerts. Overridden: the repo's number is the
 *   value read (for size it replaces `lineMean`; the longest file stays the
 *   engine's). Either way the row carries a fingerprint of what was applied
 *   (`central.fp`), and a change of it marks the week `gap` like a prereg
 *   change — a repo's own tweak is never a health move.
 * - **Alerts name the offender.** Any entry (or size sub-reading) scoring
 *   under 50 is a `warn`, under 25 `severe`, each with ONE sentence worded
 *   here so the phone and VS Code say it alike; the longest-file alert names
 *   the file.
 */

/** The five baskets the score reads, in the order the body names them. */
export const HEALTH_ENTRIES = ["size", "retouch", "hatches", "context", "untested"] as const;
export type HealthEntry = (typeof HEALTH_ENTRIES)[number];

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
} as const;
/** Context's good line, as a share of the repo's warn line: all of it — the setup sheet calibrated
 *  that line so a well-organised repo is NOT flagged; half of it made the two disagree on one number. */
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
  classics?: { value?: { loc?: unknown; files?: unknown } | null } | null;
  /** The repo's disables and overrides in force on this row; absent = none. */
  central?: HealthRowCentral | null;
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
  /** The headline SCORE, 0–100: `min(mean, worst + HEALTH_SCORE_CAP_GAP)`. */
  index: number;
  /** Geometric mean of the enabled entries' scores, before the cap. */
  mean: number;
  /** Each enabled entry's score, 0–100. */
  scores: Partial<Record<HealthEntry, number>>;
  /** Size's two sub-readings; null where size is disabled. */
  sizeParts: HealthSizeParts | null;
  /** The worst entry when the cap set the headline (`index < mean`), else null. */
  cappedBy: HealthEntry | null;
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
  gapReason?: "prereg" | "central" | "nothing";
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

const posFinite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;
const nonNegFinite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

/** `100 · min(1, good / value)`; a value at or under 0 is 100. */
export function healthScore(value: number, good: number): number {
  return value <= 0 ? 100 : 100 * Math.min(1, good / value);
}

/** The Monday (UTC) of the ISO week holding `day` (`YYYY-MM-DD`), or null for a malformed day. */
export function isoWeekOf(day: string): string | null {
  if (typeof day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const t = Date.parse(`${day}T00:00:00Z`);
  if (!Number.isFinite(t)) return null;
  const dow = (new Date(t).getUTCDay() + 6) % 7; // Monday = 0
  return new Date(t - dow * 86_400_000).toISOString().slice(0, 10);
}

/** The last row (greatest `ts`) of each ISO week, oldest week first. */
export function healthWeeks(rows: readonly HealthSeriesRow[]): { week: string; row: HealthSeriesRow }[] {
  const byWeek = new Map<string, HealthSeriesRow>();
  for (const r of rows) {
    if (!r || typeof r.ts !== "number") continue;
    const week = isoWeekOf(r.day);
    if (!week) continue;
    const prev = byWeek.get(week);
    if (!prev || r.ts >= prev.ts) byWeek.set(week, r);
  }
  return [...byWeek.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([week, row]) => ({ week, row }));
}

/** The good line of the context entry for a repo's warn line (null = the default). */
export function healthContextGood(contextWarnChars: number | null): number {
  return HEALTH_CONTEXT_GOOD_SHARE * (posFinite(contextWarnChars) ? contextWarnChars : HEALTH_INDEX_DEFAULT_WARN_CHARS);
}

/** One week's readings: the five values (size's is `lineMean`), plus size's longest file. */
export interface HealthEntryReadings {
  values: Partial<Record<HealthEntry, number>>;
  /** The longest file, read beside `lineMean`; absent where size is. */
  max?: { value: number; path: string | null };
}

/**
 * One week's values, raw (no epsilon, no floor — `min(1, good/value)` is
 * finite for any value ≥ 0); an entry is absent where its reading is.
 *
 * - `size` is `lineMean` and needs `max` beside it; either missing ⇒ absent.
 * - `untested` is a SHARE: `untested.count / classics.files` — the source-file
 *   count of the same tree, which counts test files too, so the share is a
 *   floor. A share and not the count, so a repo that grows does not read as
 *   slipping just for having more modules.
 * - `hatches` is UNEXPLAINED escapes per kLOC where the row classified them
 *   (engine 2026-10-16a on); every occurrence on an older row.
 * - `context` is `claudeMdChars + descChars`; `descChars` null (no counted
 *   skills) counts as 0 descriptions.
 */
export function healthEntryReadings(row: HealthSeriesRow): HealthEntryReadings {
  const values: Partial<Record<HealthEntry, number>> = {};
  let max: HealthEntryReadings["max"];
  const sz = row.size?.value;
  // `max` is read on its own: an override REPLACES lineMean and keeps the
  // engine's max, so it must not depend on the engine's lineMean being there.
  // Where `max` is absent size is absent on BOTH paths (an override cannot
  // invent the longest file); where only lineMean is absent, size is absent
  // without an override and the override's value stands with the engine's max.
  // A `max` left without a size value is dropped at the end.
  if (sz && nonNegFinite(sz.max)) {
    max = { value: sz.max, path: typeof sz.maxPath === "string" && sz.maxPath ? sz.maxPath : null };
  }
  if (sz && nonNegFinite(sz.lineMean) && max) values.size = sz.lineMean;

  const rate = row.retouch?.value?.rate;
  if (nonNegFinite(rate)) values.retouch = rate;

  const h = row.hatches as { value?: Record<string, unknown> | null; split?: { unexplained?: unknown } } | null | undefined;
  const loc = row.classics?.value?.loc;
  if (h?.value && typeof h.value === "object" && posFinite(loc)) {
    let total = 0;
    let ok = true;
    if (h.split && typeof h.split === "object") {
      if (nonNegFinite(h.split.unexplained)) total = h.split.unexplained;
      else ok = false;
    } else {
      for (const v of Object.values(h.value)) {
        if (!nonNegFinite(v)) { ok = false; break; }
        total += v;
      }
    }
    if (ok) values.hatches = total / (loc / 1000);
  }

  const ctx = row.context?.value;
  const md = ctx?.claudeMdChars;
  const desc = ctx?.descChars;
  // No CLAUDE.md is nothing the repo loads every turn: 0, on the engine's exact words (its skills go unmeasured then).
  if (!ctx && row.context?.reason === HEALTH_NO_CLAUDE_MD) values.context = 0;
  else if (nonNegFinite(md) && (desc === null || desc === undefined || nonNegFinite(desc))) values.context = md + (typeof desc === "number" ? desc : 0);

  const list = row.untested?.value;
  const files = row.classics?.value?.files;
  if (Array.isArray(list) && posFinite(files) && list.length <= files) {
    values.untested = list.length / files;
  }

  // The repo's own say (`central`): a disabled entry is not in the basket at
  // all; an override REPLACES the engine's value (for size, `lineMean` — the
  // longest file stays measured), and a failed override is absent — never the
  // engine's number standing in for the repo's.
  const c = centralOf(row);
  for (const e of c.disabled) {
    delete values[e];
    if (e === "size") max = undefined;
  }
  for (const e of c.overridden) {
    delete values[e];
    const v = row.central?.override?.[e]?.value;
    if (!nonNegFinite(v)) continue;
    if (e === "size" && !max) continue;
    values[e] = v;
  }
  if (values.size === undefined) max = undefined;
  return max ? { values, max } : { values };
}

/** The five values alone — `healthEntryReadings(row).values`. The warn line is not read here any more (scores read it). */
export function healthEntryValues(row: HealthSeriesRow, _contextWarnChars?: number | null): Partial<Record<HealthEntry, number>> {
  return healthEntryReadings(row).values;
}

const isEntry = (k: string): k is HealthEntry => (HEALTH_ENTRIES as readonly string[]).includes(k);

/**
 * What the repo applied on this row: its fingerprint and which entries it
 * disabled or overrode. An entry both disabled and overridden reads disabled
 * (the engine never writes both; a hand-edited row must not count twice).
 */
export function centralOf(row: HealthSeriesRow): { fp: string; disabled: HealthEntry[]; overridden: HealthEntry[] } {
  const c = row.central;
  if (!c || typeof c !== "object") return { fp: "", disabled: [], overridden: [] };
  const fp = typeof c.fp === "string" ? c.fp : "";
  const keysOf = (o: unknown): HealthEntry[] =>
    o && typeof o === "object" ? Object.keys(o).filter(isEntry) : [];
  const disabled = HEALTH_ENTRIES.filter((e) => keysOf(c.disabled).includes(e));
  const overridden = HEALTH_ENTRIES.filter((e) => keysOf(c.override).includes(e) && !disabled.includes(e));
  return { fp, disabled, overridden };
}

function treeOf(row: HealthSeriesRow): { files: number; loc: number } | null {
  const v = row.classics?.value;
  return v && nonNegFinite(v.files) && nonNegFinite(v.loc) ? { files: v.files, loc: v.loc } : null;
}

const DAY_MS = 86_400_000;
const daysBetween = (a: string, b: string): number =>
  Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);

// ── words: one wording for the phone and VS Code ────────────────────────────

/** A whole number with thousands separators, locale-free: `8,397`. */
const commas = (n: number): string => Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
const pct = (x: number): string => `${Math.round(x * 100)}%`;
const oneDp = (x: number): string => (Math.round(x * 10) / 10).toFixed(1);

/** Plain names for an entry, as the cap sentence names it. */
export const HEALTH_ENTRY_LABEL: Record<HealthEntry, string> = {
  size: "file length",
  retouch: "re-touches",
  hatches: "escape hatches",
  context: "CLAUDE.md + skill descriptions",
  untested: "untested modules",
};

function alertText(level: HealthAlert["level"], subject: HealthAlertSubject, value: number, good: number, path?: string): string {
  const body = (() => {
    switch (subject) {
      case "max":
        return `${path ?? "the longest file"} is ${commas(value)} lines (good: under ${commas(good)})`;
      case "lineMean":
        return `the average line sits in a file of ${commas(value)} lines (good: under ${commas(good)})`;
      case "retouch":
        return `${pct(value)} of recent file edits rework the edit before (good: under ${pct(good)})`;
      case "hatches":
        return `${oneDp(value)} unexplained escape hatches per 1,000 lines (good: under ${oneDp(good)})`;
      case "context":
        return `CLAUDE.md + skill descriptions are ${commas(value)} chars (good: under ${commas(good)})`;
      case "untested":
        return `${pct(value)} of source files have no test reaching them (good: under ${pct(good)})`;
    }
  })();
  return `${level}: ${body}`;
}

function alertOf(entry: HealthEntry, subject: HealthAlertSubject, value: number, good: number, path?: string | null): HealthAlert | null {
  const score = healthScore(value, good);
  if (!(score < HEALTH_ALERT_WARN)) return null;
  const level = score < HEALTH_ALERT_SEVERE ? "severe" : "warn";
  const p = path ?? undefined;
  return { level, entry, subject, value, good, score, ...(p ? { path: p } : {}), text: alertText(level, subject, value, good, p) };
}

/**
 * The cap, said once: `null` when the cap did not set the number. The worst
 * entry's score is derived (`value − HEALTH_SCORE_CAP_GAP`), so the wire
 * summary can be worded from its three fields alone.
 */
export function healthCapWords(s: { value: number; mean: number; cappedBy: HealthEntry | null }): string | null {
  if (!s.cappedBy || !(s.value < s.mean)) return null;
  const worst = Math.round(s.value - HEALTH_SCORE_CAP_GAP);
  return `Capped at ${Math.round(s.value)} by ${HEALTH_ENTRY_LABEL[s.cappedBy]} (${worst} of 100): the entries average ${Math.round(s.mean)}, and the score stays within ${HEALTH_SCORE_CAP_GAP} of its worst entry.`;
}

/** One week's score from its readings; null when any enabled entry is absent, or none is enabled. */
function scoreWeek(r: HealthEntryReadings, disabled: readonly HealthEntry[], contextWarnChars: number | null) {
  const enabled = HEALTH_ENTRIES.filter((e) => !disabled.includes(e));
  if (enabled.length === 0 || enabled.some((e) => r.values[e] === undefined)) return null;
  const ctxGood = healthContextGood(contextWarnChars);
  const scores: Partial<Record<HealthEntry, number>> = {};
  let sizeParts: HealthSizeParts | null = null;
  const alerts: HealthAlert[] = [];
  for (const e of enabled) {
    const v = r.values[e] as number;
    if (e === "size") {
      const m = r.max!;
      sizeParts = {
        lineMean: { value: v, score: healthScore(v, HEALTH_GOOD.lineMean) },
        max: { value: m.value, score: healthScore(m.value, HEALTH_GOOD.max), path: m.path },
      };
      scores.size = Math.sqrt(sizeParts.lineMean.score * sizeParts.max.score);
      // Size alerts on its sub-readings: the blend is under a line only if one
      // of them is, and the sub-reading is what can be named.
      const a1 = alertOf("size", "lineMean", v, HEALTH_GOOD.lineMean);
      const a2 = alertOf("size", "max", m.value, HEALTH_GOOD.max, m.path);
      if (a1) alerts.push(a1);
      if (a2) alerts.push(a2);
      continue;
    }
    const good = e === "context" ? ctxGood : HEALTH_GOOD[e];
    scores[e] = healthScore(v, good);
    const a = alertOf(e, e, v, good);
    if (a) alerts.push(a);
  }
  const n = enabled.length;
  // A score of 0 cannot occur (good > 0, value finite), so ln is finite.
  const mean = Math.exp(enabled.reduce((s, e) => s + Math.log(scores[e] as number), 0) / n);
  let worst: HealthEntry = enabled[0];
  for (const e of enabled) if ((scores[e] as number) < (scores[worst] as number)) worst = e;
  const capped = (scores[worst] as number) + HEALTH_SCORE_CAP_GAP;
  const index = Math.min(mean, capped);
  alerts.sort((a, b) => a.score - b.score);
  return { index, mean, scores, sizeParts, cappedBy: capped < mean ? worst : null, alerts, enabled };
}

/**
 * The scored series. `null` when no week has every enabled entry — no score
 * is no series, never a number nobody measured.
 */
export function healthIndex(
  rows: readonly HealthSeriesRow[],
  contextWarnChars: number | null,
): HealthIndexSeries | null {
  const points: HealthIndexPoint[] = [];
  for (const { week, row } of healthWeeks(rows)) {
    const c = centralOf(row);
    const readings = healthEntryReadings(row);
    const s = scoreWeek(readings, c.disabled, contextWarnChars);
    if (!s) continue;
    const prereg = typeof row.prereg === "string" ? row.prereg : null;
    const prev = points[points.length - 1];
    const base = {
      week, index: s.index, mean: s.mean, scores: s.scores, sizeParts: s.sizeParts,
      cappedBy: s.cappedBy, alerts: s.alerts, values: readings.values, prereg,
      central: c.fp, disabled: c.disabled, overridden: c.overridden, tree: treeOf(row),
    };
    if (!prev) {
      points.push({ ...base, gap: false, lnLink: null, comparable: 0, contributions: {}, spanDays: null });
      continue;
    }
    const spanDays = daysBetween(prev.week, week);
    const gapReason = prev.prereg !== prereg ? "prereg" : prev.central !== c.fp ? "central" : null;
    if (gapReason) {
      points.push({ ...base, gap: true, lnLink: null, comparable: 0, contributions: {}, spanDays, gapReason });
      continue;
    }
    // Same fingerprint ⇒ same enabled set, so every entry is in both weeks.
    const n = s.enabled.length;
    const contributions: Partial<Record<HealthEntry, number>> = {};
    for (const e of s.enabled) {
      const a = prev.scores[e];
      const b = s.scores[e];
      if (a !== undefined && b !== undefined) contributions[e] = (prev.mean * (Math.log(b) - Math.log(a))) / n;
    }
    points.push({
      ...base, gap: false, lnLink: Math.log(s.index / prev.index), comparable: n, contributions, spanDays,
    });
  }
  if (points.length === 0) return null;
  return { baselineWeek: points[0].week, points };
}

/** One row by the SAME formula a week uses (`scoreWeek`); null when an enabled entry is absent. */
export function healthRowScore(
  row: HealthSeriesRow,
  contextWarnChars: number | null,
): { index: number; mean: number; scores: Partial<Record<HealthEntry, number>>; cappedBy: HealthEntry | null } | null {
  const s = scoreWeek(healthEntryReadings(row), centralOf(row).disabled, contextWarnChars);
  return s ? { index: s.index, mean: s.mean, scores: s.scores, cappedBy: s.cappedBy } : null;
}

/** One scored commit (a series row) for the phone's commits axis. No lnLink, contributions or move. */
export interface HealthCommitPoint {
  sha7: string;
  day: string;
  ts: number;
  week: string;
  index: number;
  mean: number;
  cappedBy: HealthEntry | null;
  /** Prereg or central fingerprint differs from the previous scored row: do not join the line. */
  gap: boolean;
}

export interface HealthCommitSeries {
  points: HealthCommitPoint[];
  /** Scored rows before thinning. */
  total: number;
  thinned: boolean;
}

/** Thin to ~`max`: each ISO week's LAST point stays; `ceil(n/max)`-long runs keep their min and max index. At most 2*max + weeks. */
export function thinCommitPoints(points: readonly HealthCommitPoint[], max: number): HealthCommitPoint[] {
  if (points.length <= max) return [...points];
  const keep = new Set<number>();
  const lastOfWeek = new Map<string, number>();
  points.forEach((p, i) => lastOfWeek.set(p.week, i));
  for (const i of lastOfWeek.values()) keep.add(i);
  const run = Math.ceil(points.length / Math.max(1, max));
  for (let a = 0; a < points.length; a += run) {
    let lo = a, hi = a;
    const end = Math.min(points.length, a + run);
    for (let i = a; i < end; i++) {
      if (points[i].index < points[lo].index) lo = i;
      if (points[i].index > points[hi].index) hi = i;
    }
    keep.add(lo);
    keep.add(hi);
  }
  return [...keep].sort((x, y) => x - y).map((i) => points[i]);
}

/** Every scorable row as a commit point, thinned to about `max`; `null` when no row scores. */
export function healthIndexCommits(rows: readonly HealthSeriesRow[], contextWarnChars: number | null, max = 240): HealthCommitSeries | null {
  const sorted = rows.filter((r) => r && typeof r.ts === "number").sort((a, b) => a.ts - b.ts);
  const all: HealthCommitPoint[] = [];
  let prev: { prereg: string | null; central: string } | null = null;
  for (const row of sorted) {
    const week = isoWeekOf(row.day);
    const s = week ? healthRowScore(row, contextWarnChars) : null;
    if (!week || !s) continue;
    const prereg = typeof row.prereg === "string" ? row.prereg : null;
    const central = centralOf(row).fp;
    all.push({
      sha7: typeof row.sha === "string" ? row.sha.slice(0, 7) : "",
      day: row.day, ts: row.ts, week, index: s.index, mean: s.mean, cappedBy: s.cappedBy,
      gap: prev !== null && (prev.prereg !== prereg || prev.central !== central),
    });
    prev = { prereg, central };
  }
  if (all.length === 0) return null;
  const points = thinCommitPoints(all, max);
  return { points, total: all.length, thinned: points.length < all.length };
}

/** `absent` = an older host (no key), `none` = the host looked and nothing scores, else `present`. */
export function healthCommitsAvailability(view: { commits?: HealthCommitSeries | null } | null | undefined): "absent" | "none" | "present" {
  if (!view || view.commits === undefined) return "absent";
  return view.commits && view.commits.points.length > 0 ? "present" : "none";
}

/** How far back "vs 12 weeks ago" looks, in weeks. */
export const HEALTH_INDEX_VS_WEEKS = 12;

export interface HealthIndexVs {
  /** `now.index / then.index` — 1.05 is five percent healthier. */
  ratio: number;
  /** Score points between the two (`now − then`). */
  delta: number;
  then: HealthIndexPoint;
  now: HealthIndexPoint;
  /** Weeks actually between the two points — `weeks` asked or more, since a
   *  week nobody measured has no point. The UI names `then.week`. */
  weeks: number;
}

/**
 * "Vs 12 weeks ago": the score at `points[at]` (default the latest) against
 * the LATEST measured point at least `weeks` earlier — however much further
 * back that is, because a week with no commit has no row and the honest
 * comparison names the week it actually used (`then.week`, `weeks`). Null
 * only when no point sits that far back (a series younger than the horizon).
 *
 * Both ends are absolute scores, so the ratio is simply the two numbers —
 * including any prereg or `central` change between them (the point's `gap`
 * says one happened; the caller decides whether to say so).
 */
export function healthIndexVs(
  points: readonly HealthIndexPoint[],
  weeks: number = HEALTH_INDEX_VS_WEEKS,
  at: number = points.length - 1,
): HealthIndexVs | null {
  const now = points[at];
  if (!now || !(weeks > 0) || !Number.isFinite(now.index)) return null;
  const nowT = Date.parse(`${now.week}T00:00:00Z`);
  const target = nowT - weeks * 7 * DAY_MS;
  for (let i = at - 1; i >= 0; i--) {
    const t = Date.parse(`${points[i].week}T00:00:00Z`);
    if (t > target) continue;
    const then = points[i];
    if (!(then.index > 0)) return null;
    return {
      ratio: now.index / then.index,
      delta: now.index - then.index,
      then,
      now,
      weeks: Math.round((nowT - t) / (7 * DAY_MS)),
    };
  }
  return null;
}

export interface HealthMove {
  kind: "drop" | "rise" | null;
  horizon: "week" | "month" | null;
  /** Index points the horizon moved (latest − then); null when there is no comparable move to state. */
  delta: number | null;
  reason: string;
}

export interface HealthMoveOpts {
  minWeeks?: number;
  minMonthWindows?: number;
  lowPct?: number;
  highPct?: number;
  minPoints?: number;
}

/** Linear-interpolated percentile (0–100) of a non-empty list. */
function percentile(xs: readonly number[], p: number): number {
  const s = [...xs].sort((a, b) => a - b);
  const pos = (p / 100) * (s.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

/**
 * Whether the latest move is unusual for THIS repo: the week's link against
 * the distribution of every earlier link, then (only if the week says nothing)
 * the last four weeks against every earlier rolling four-week change. Both
 * need the percentile AND a minimum number of points, so a dead-flat series
 * cannot call a 0.1-point wobble a drop. Under `HEALTH_INDEX_MIN_WEEKS` links
 * of history there is no distribution to stand on: `kind: null`, with why.
 */
export function assessHealthMove(points: readonly HealthIndexPoint[], opts: HealthMoveOpts = {}): HealthMove {
  const minWeeks = opts.minWeeks ?? HEALTH_INDEX_MIN_WEEKS;
  const minMonth = opts.minMonthWindows ?? HEALTH_INDEX_MIN_MONTH_WINDOWS;
  const lowPct = opts.lowPct ?? HEALTH_INDEX_LOW_PCT;
  const highPct = opts.highPct ?? HEALTH_INDEX_HIGH_PCT;
  const minPts = opts.minPoints ?? HEALTH_INDEX_MIN_POINTS;
  const none = (reason: string, horizon: HealthMove["horizon"] = null, delta: number | null = null): HealthMove =>
    ({ kind: null, horizon, delta, reason });

  const last = points[points.length - 1];
  if (!last) return none("no index yet");
  const links = points.filter((p) => p.lnLink !== null) as (HealthIndexPoint & { lnLink: number })[];
  if (links.length < minWeeks) {
    return none(`${links.length} weekly link${links.length === 1 ? "" : "s"} so far; a move is called after ${minWeeks}`);
  }

  // Week: only when the latest point IS a link — a carried week moved nothing.
  if (last.lnLink !== null) {
    const prior = links.slice(0, -1).map((p) => p.lnLink);
    const prevIndex = points[points.length - 2].index;
    const delta = last.index - prevIndex;
    if (last.lnLink < percentile(prior, lowPct) && -delta >= minPts) {
      return { kind: "drop", horizon: "week", delta, reason: `the latest week's link sits below the ${lowPct}th percentile of ${prior.length} earlier weeks` };
    }
    if (last.lnLink > percentile(prior, highPct) && delta >= minPts) {
      return { kind: "rise", horizon: "week", delta, reason: `the latest week's link sits above the ${highPct}th percentile of ${prior.length} earlier weeks` };
    }
  }

  // Month: ln(index_t / index_{t-4}) against every earlier rolling window.
  const W = HEALTH_INDEX_MONTH_WEEKS;
  const t = points.length - 1;
  if (t < W) return none("too few weeks for a four-week reading");
  // A window that spans a `gap` point compares two scores measured under
  // different definitions: it is not a move. Skipped as history, and when the
  // current window is one, no month move is called at all.
  const spansGap = (j: number): boolean => {
    for (let k = j - W + 1; k <= j; k++) if (points[k].gap) return true;
    return false;
  };
  if (spansGap(t)) return none("the last four weeks span a change of definition, so there is no month move to compare");
  const windows: number[] = [];
  for (let j = W; j < t; j++) if (!spansGap(j)) windows.push(Math.log(points[j].index / points[j - W].index));
  const monthDelta = last.index - points[t - W].index;
  if (windows.length < minMonth) {
    return none(`${windows.length} earlier four-week window${windows.length === 1 ? "" : "s"}; a month move is called after ${minMonth}`);
  }
  const ln = Math.log(last.index / points[t - W].index);
  if (ln < percentile(windows, lowPct) && -monthDelta >= minPts) {
    return { kind: "drop", horizon: "month", delta: monthDelta, reason: `the last four weeks sit below the ${lowPct}th percentile of ${windows.length} earlier four-week windows` };
  }
  if (ln > percentile(windows, highPct) && monthDelta >= minPts) {
    return { kind: "rise", horizon: "month", delta: monthDelta, reason: `the last four weeks sit above the ${highPct}th percentile of ${windows.length} earlier four-week windows` };
  }
  return none("within this repo's usual range", null, last.lnLink !== null ? last.index - points[t - 1].index : null);
}

/** Plain names for an entry's move: [0] when its metric rose (its score fell), [1] when it fell. */
const ENTRY_WORDS: Record<HealthEntry, [string, string]> = {
  size: ["files grew longer", "files got shorter"],
  retouch: ["more re-touched files", "fewer re-touched files"],
  hatches: ["more escape hatches", "fewer escape hatches"],
  context: ["CLAUDE.md + skill descriptions grew", "CLAUDE.md + skill descriptions shrank"],
  untested: ["more untested modules", "fewer untested modules"],
};

/** A signed whole number with a real minus sign: `−4`, `+3`, `±0`. */
export function signedPoints(n: number): string {
  const r = Math.round(n);
  if (r === 0) return "±0";
  return r < 0 ? `−${-r}` : `+${r}`;
}

export interface HealthWords {
  /** Short label for the repo row: `Health 94 −4`. */
  chip: string;
  /** `Health score 94 (−4 this week)`. */
  title: string;
  /** Names the (at most two) metrics that carried the move, or "" when none can be named. */
  body: string;
}

/**
 * When the latest measured week happened, worded against the week it is now:
 * `this week` only when they are the same ISO week — a week with no commit has
 * no point, so the newest one can be months old — else `in the week of <Monday>`.
 * `currentWeek` absent = the caller did not say, and the claim falls back to
 * naming the week (never a `this week` nobody checked).
 */
export function healthWeekWhen(week: string, currentWeek?: string | null): string {
  return currentWeek && week === currentWeek ? "this week" : `in the week of ${week}`;
}

/**
 * The notification and chip wording for a called move. `null` when there is
 * nothing to say (no move called, or no points) — a sentence is never written
 * around a null. `currentWeek` (the ISO week's Monday, `isoWeekOf(today)`)
 * decides whether the latest point may be called "this week".
 */
export function healthMoveWords(points: readonly HealthIndexPoint[], move: HealthMove, currentWeek?: string | null): HealthWords | null {
  const last = points[points.length - 1];
  if (!last || !move.kind || !move.horizon || move.delta === null) return null;
  const value = Math.round(last.index);
  const span = move.horizon === "week" ? 1 : HEALTH_INDEX_MONTH_WEEKS;
  const latest = currentWeek && last.week === currentWeek;
  const when = move.horizon === "week"
    ? healthWeekWhen(last.week, currentWeek)
    : latest ? "over four weeks" : `over the four weeks to ${last.week}`;
  const sums: Partial<Record<HealthEntry, number>> = {};
  for (const p of points.slice(-span)) {
    for (const e of HEALTH_ENTRIES) {
      const c = p.contributions[e];
      if (c !== undefined) sums[e] = (sums[e] ?? 0) + c;
    }
  }
  const sign = move.kind === "drop" ? -1 : 1;
  const top = HEALTH_ENTRIES
    .filter((e) => (sums[e] ?? 0) * sign > 0)
    .sort((a, b) => Math.abs(sums[b] ?? 0) - Math.abs(sums[a] ?? 0))
    .slice(0, 2)
    .map((e) => `${ENTRY_WORDS[e][move.kind === "drop" ? 0 : 1]} (${signedPoints(sums[e] ?? 0)})`);
  const verb = move.kind === "drop" ? "slipped" : "rose";
  const pts = Math.abs(Math.round(move.delta));
  const body = top.length
    ? `The score ${verb} ${pts} point${pts === 1 ? "" : "s"} ${when}: ${top.join(", ")}.`
    : `The score ${verb} ${pts} point${pts === 1 ? "" : "s"} ${when}.`;
  return {
    chip: `Health ${value} ${signedPoints(move.delta)}`,
    title: `Health score ${value} (${signedPoints(move.delta)} ${when})`,
    body,
  };
}

/** What `RepoTarget.healthIndex` carries. */
export interface RepoHealthIndex {
  /** The latest headline score, 0–100. */
  value: number;
  /** The latest week's move in score points; null on a gap week or the first scored week. */
  deltaWeek: number | null;
  /** The latest week's Monday. */
  week: string;
  move: "drop" | "rise" | null;
  // The four below are OPTIONAL on purpose: the phone updates over the air,
  // so it can meet a host from before the absolute score. Absent = that host
  // did not say — never "not capped" or "no alert".
  /** The mean before the cap, so `healthCapWords` can be said from this summary alone. */
  mean?: number;
  /** The entry holding the score down when the cap set it, else null. */
  cappedBy?: HealthEntry | null;
  /** The worst alert level on the latest week; null when nothing is under the warn line. */
  alert?: "warn" | "severe" | null;
  /** That worst alert's sentence; null with it. */
  alertText?: string | null;
}

/** The wire summary for one repo, or null where there is no index (the field stays ABSENT, never 0). */
export function repoHealthIndexOf(series: HealthIndexSeries | null, move?: HealthMove | null): RepoHealthIndex | null {
  const pts = series?.points;
  const last = pts?.[pts.length - 1];
  if (!pts || !last) return null;
  const prev = pts[pts.length - 2];
  return {
    value: last.index,
    deltaWeek: last.lnLink !== null && prev ? last.index - prev.index : null,
    week: last.week,
    move: move?.kind ?? null,
    mean: last.mean,
    cappedBy: last.cappedBy,
    alert: last.alerts[0]?.level ?? null,
    alertText: last.alerts[0]?.text ?? null,
  };
}

/**
 * `GET /api/repos/:id/healthindex` — the whole scored series for the phone's
 * chart (the latest point carries the alerts and `cappedBy`), the called move
 * and its words. `series: null` + `reason` when there is no series file or no
 * scored week yet; never a made-up number.
 */
export interface HealthIndexResponse {
  series: HealthIndexSeries | null;
  move: HealthMove | null;
  words: HealthWords | null;
  /** ISO time of the last weekly refresh this host ran for the repo, if any. */
  lastRefresh: string | null;
  reason?: string;
  /** Context per request by ISO week (`healthspend.ts`); absent with no ledger (older host; VS Code before its first log scan). */
  spend?: import("./healthspend.js").HealthSpendWeek[];
  /** Scored commits, thinned. ABSENT only on an older host; null = no row scores (or no series). */
  commits?: HealthCommitSeries | null;
}
