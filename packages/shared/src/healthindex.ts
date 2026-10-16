/**
 * The health index — ONE number per repo, chained week over week from the
 * repo-health series (`<repo>/.waterplane/repohealth.jsonl`).
 *
 * **This is the one layer that judges.** The series and every sentence the
 * engine and the phone write about it stay unjudged: a reading compared to its
 * own past has no side to be on. The owner approved (2026-10-15) a separate
 * index that DOES take a side, and the side is the same for every input: each
 * metric is read as lower-is-better. That opinion lives here and nowhere else.
 *
 * Shape of the arithmetic, and why:
 *
 * - **Weeks, last row wins.** Rows bucket to ISO weeks (Monday start, UTC, off
 *   the row's own `day` string) and the LAST row of each week (greatest `ts`)
 *   is its reading — `perDay`'s semantics one level up: every family here is a
 *   STATE of the tree, and a state read earlier in the week is just an older
 *   reading. Batch rows are kept, as `perDay` keeps them.
 * - **Chained, not fixed-base.** A metric can be absent for a stretch (no skills
 *   yet, no pack that reads tests). A fixed base would need every metric in
 *   every week; a chain only needs a metric in two NEIGHBOURING weeks to count
 *   it. Each link is the geometric mean of `prev/cur` over the entries present
 *   in both weeks, so a metric that halves moves the index by the same factor
 *   whatever its unit.
 * - **Baseline = 100** at the first week where all five entries are present —
 *   an index that starts on a partial basket would rebase silently later.
 * - **A prereg change is a gap.** Rows carry the engine version they were
 *   computed under; across a change, a metric's definition may have moved, and
 *   a ratio between two definitions is a wrong number. Simplest safe rule: the
 *   link across that boundary is 1 and the week is marked `gap`.
 * - **Nothing here invents a reading**: a value that is not a finite number is
 *   absent for that week; no baseline means no index (`null`), never 100.
 * - **A repo may disable or override an entry** (`central` in its committed
 *   `health.json`, `tools/repohealth/central.mjs`). Disabled: the entry leaves
 *   the mean, and the baseline needs only the entries still enabled.
 *   Overridden: the repo's number takes the slot. Either way the row carries a
 *   fingerprint of what was applied (`central.fp`), and a link between two
 *   weeks with different fingerprints is CARRIED exactly like a prereg change
 *   — a repo's own tweak is never a health move. An override runs at HEAD
 *   only, so its series starts at its first measurement and the link into it
 *   is one of those carried links.
 */

/** The five baskets the index reads, in the order the body names them. */
export const HEALTH_ENTRIES = ["size", "retouch", "hatches", "context", "untested"] as const;
export type HealthEntry = (typeof HEALTH_ENTRIES)[number];

/**
 * Added to a ratio-type metric that can legitimately read 0 (a re-touch rate,
 * hatches per kLOC, the untested share). Without it one week at 0 makes the
 * next link `ln(0/x)` = −∞ and the index is dead for ever after. 0.01 is
 * small beside any real reading of those three (this repo: 0.57, 11.0/kLOC,
 * 0.53) and large enough that 0 → 0.01-ish moves stay finite and bounded.
 */
export const HEALTH_INDEX_EPSILON = 0.01;
/** The baseline week's value. */
export const HEALTH_INDEX_BASE = 100;
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
/** …AND move the index by at least this many points. */
export const HEALTH_INDEX_MIN_POINTS = 2;
/**
 * The context-weight warn line when the repo has none of its own: the setup
 * checklist's `DEFAULT_CONTEXT_LIMITS.maxChars` (`contextweight.ts`), restated
 * as a literal so this module carries no import cycle through the index.
 * Pinned equal to it by the test.
 */
/**
 * Cap on one entry's log ratio per weekly link: an entry can at most halve or
 * double its pull on the index in one week. A rate near zero (retouch 0.02 →
 * 0.8) is otherwise a ln-ratio of ~3.7 and one noisy reading outvotes the
 * other four — measured on a small repo as −95 points from re-touches alone.
 */
export const HEALTH_INDEX_MAX_LN = Math.LN2;
export const HEALTH_INDEX_DEFAULT_WARN_CHARS = 16_000;

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
  size?: { value?: { p95?: unknown } | null } | null;
  retouch?: { value?: { rate?: unknown } | null } | null;
  hatches?: { value?: Record<string, unknown> | null } | null;
  context?: { value?: { claudeMdChars?: unknown; descChars?: unknown } | null } | null;
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

export interface HealthIndexPoint {
  /** The ISO week's Monday, `YYYY-MM-DD` (UTC). */
  week: string;
  index: number;
  /** No comparable entry against the previous week, or a prereg change: the index was carried. */
  gap: boolean;
  /** `ln(index / previous index)`; `null` on the baseline and on a gap. */
  lnLink: number | null;
  /** How many entries the link averaged over (0 on the baseline and a gap). */
  comparable: number;
  /**
   * Each comparable entry's share of the move, in LOG POINTS:
   * `prevIndex · ln(prev/cur) / n`. Log points are what is additive — the
   * terms of a geometric mean add in log space, never in level space — so
   * these sum EXACTLY to `prevIndex · lnLink`, which is the move
   * `index − prevIndex` to first order (−4 points reads as ≈ −3.92 at 100).
   * Negative = that metric rose.
   */
  contributions: Partial<Record<HealthEntry, number>>;
  /** The effective values read this week (after the epsilon and the floor). */
  values: Partial<Record<HealthEntry, number>>;
  prereg: string | null;
  /**
   * Days since the previous MEASURED week (Monday to Monday, so a multiple of
   * 7); null on the baseline. A week with no commit has no row and no point,
   * so a link over 7 days is one that spans weeks nobody measured — a reader
   * should be told before reading it as one week's move.
   */
  spanDays: number | null;
  /** Why a gap was carried: the engine's definition moved, the repo's own
   *  `central` config moved, or no entry was present in both weeks. */
  gapReason?: "prereg" | "central" | "nothing";
  /** The repo's `central` fingerprint this week; "" = none applied. */
  central: string;
  /** Entries the repo disabled this week — out of the mean, not absent readings. */
  disabled: HealthEntry[];
  /** Entries whose value this week is the repo's override, not the engine's. */
  overridden: HealthEntry[];
  /** Source files and lines this week (`classics`), so growth since the
   *  baseline can be stated; null where that reading was absent. */
  tree: { files: number; loc: number } | null;
}

export interface HealthIndexSeries {
  baselineWeek: string;
  /** Baseline first, one point per week that has a row, oldest first. */
  points: HealthIndexPoint[];
}

const posFinite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;
const nonNegFinite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

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

/**
 * One week's five effective values; an entry is absent where its reading is.
 *
 * - `untested` is a SHARE: `untested.count / classics.files`. The untested
 *   family carries only the list, no total; `classics.files` is the source-file
 *   count of the same tree, and the engine's own sentence already reads the
 *   count "of N modules in the tree" against it. It counts test files too, so
 *   the share is a floor — but the same floor every week, which is what a
 *   chain needs. A share and not the count, so a repo that grows does not
 *   read as slipping just for having more modules.
 * - `context` is `claudeMdChars + descChars`, floored at half the warn line:
 *   below that the always-on weight is not worth a move of the index, and a
 *   tiny CLAUDE.md doubling from 400 to 800 chars would otherwise read as the
 *   biggest event in the repo. `descChars` null (no counted skills in the
 *   tree) counts as 0 descriptions.
 */
export function healthEntryValues(
  row: HealthSeriesRow,
  contextWarnChars: number | null,
): Partial<Record<HealthEntry, number>> {
  const out: Partial<Record<HealthEntry, number>> = {};
  const warn = posFinite(contextWarnChars) ? contextWarnChars : HEALTH_INDEX_DEFAULT_WARN_CHARS;
  const p95 = row.size?.value?.p95;
  if (posFinite(p95)) out.size = p95;

  const rate = row.retouch?.value?.rate;
  if (nonNegFinite(rate)) out.retouch = rate + HEALTH_INDEX_EPSILON;

  const h = row.hatches as { value?: Record<string, unknown> | null; split?: { unexplained?: unknown } } | null | undefined;
  const loc = row.classics?.value?.loc;
  if (h?.value && typeof h.value === "object" && posFinite(loc)) {
    // The UNEXPLAINED escapes where the row classified them (engine
    // 2026-10-16a on); every occurrence on an older row, which is what that
    // row's own definition counted.
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
    if (ok) out.hatches = total / (loc / 1000) + HEALTH_INDEX_EPSILON;
  }

  const ctx = row.context?.value;
  const md = ctx?.claudeMdChars;
  const desc = ctx?.descChars;
  if (nonNegFinite(md) && (desc === null || desc === undefined || nonNegFinite(desc))) {
    const sum = md + (typeof desc === "number" ? desc : 0);
    out.context = Math.max(sum, 0.5 * warn);
  }

  const list = row.untested?.value;
  const files = row.classics?.value?.files;
  if (Array.isArray(list) && posFinite(files) && list.length <= files) {
    out.untested = list.length / files + HEALTH_INDEX_EPSILON;
  }

  // The repo's own say (`central`): a disabled entry is not in the basket at
  // all; an override REPLACES the engine's value, read through the same
  // epsilon and floor, and a failed override is absent — never the engine's
  // number standing in for the repo's.
  const c = centralOf(row);
  for (const e of c.disabled) delete out[e];
  for (const e of c.overridden) {
    delete out[e];
    const v = row.central?.override?.[e]?.value;
    if (!nonNegFinite(v) || (e === "size" && v === 0)) continue;
    out[e] = e === "size" ? v : e === "context" ? Math.max(v, 0.5 * warn) : v + HEALTH_INDEX_EPSILON;
  }
  return out;
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

/**
 * The chained index over a series. `null` when no week has all five entries —
 * no baseline is no index, never a 100 nobody measured.
 */
export function healthIndex(
  rows: readonly HealthSeriesRow[],
  contextWarnChars: number | null,
): HealthIndexSeries | null {
  const weeks = healthWeeks(rows).map(({ week, row }) => {
    const c = centralOf(row);
    return {
      week,
      prereg: typeof row.prereg === "string" ? row.prereg : null,
      values: healthEntryValues(row, contextWarnChars),
      central: c.fp,
      disabled: c.disabled,
      overridden: c.overridden,
      tree: treeOf(row),
    };
  });
  // The baseline needs every entry the repo has NOT disabled — and at least
  // one: a repo that disabled all five has no index, never a 100.
  const b = weeks.findIndex((w) => {
    const enabled = HEALTH_ENTRIES.filter((e) => !w.disabled.includes(e));
    return enabled.length > 0 && enabled.every((e) => w.values[e] !== undefined);
  });
  if (b < 0) return null;
  const facts = (w: (typeof weeks)[number]) =>
    ({ values: w.values, prereg: w.prereg, central: w.central, disabled: w.disabled, overridden: w.overridden, tree: w.tree });
  const points: HealthIndexPoint[] = [{
    week: weeks[b].week, index: HEALTH_INDEX_BASE, gap: false, lnLink: null, comparable: 0,
    contributions: {}, spanDays: null, ...facts(weeks[b]),
  }];
  for (let i = b + 1; i < weeks.length; i++) {
    const prev = weeks[i - 1];
    const cur = weeks[i];
    const prevIndex = points[points.length - 1].index;
    const spanDays = daysBetween(prev.week, cur.week);
    const carried = (gapReason: "prereg" | "central" | "nothing"): HealthIndexPoint => ({
      week: cur.week, index: prevIndex, gap: true, lnLink: null, comparable: 0,
      contributions: {}, spanDays, gapReason, ...facts(cur),
    });
    if (prev.prereg !== cur.prereg) { points.push(carried("prereg")); continue; }
    if (prev.central !== cur.central) { points.push(carried("central")); continue; }
    const terms: [HealthEntry, number][] = [];
    for (const e of HEALTH_ENTRIES) {
      const a = prev.values[e];
      const c = cur.values[e];
      if (a !== undefined && c !== undefined) terms.push([e, Math.max(-HEALTH_INDEX_MAX_LN, Math.min(HEALTH_INDEX_MAX_LN, Math.log(a / c)))]);
    }
    if (terms.length === 0) { points.push(carried("nothing")); continue; }
    const n = terms.length;
    const lnLink = terms.reduce((s, [, t]) => s + t, 0) / n;
    const contributions: Partial<Record<HealthEntry, number>> = {};
    for (const [e, t] of terms) contributions[e] = (prevIndex * t) / n;
    points.push({
      week: cur.week, index: prevIndex * Math.exp(lnLink), gap: false, lnLink, comparable: n,
      contributions, spanDays, ...facts(cur),
    });
  }
  return { baselineWeek: weeks[b].week, points };
}

/** How far back "vs 12 weeks ago" looks, in weeks. */
export const HEALTH_INDEX_VS_WEEKS = 12;

export interface HealthIndexVs {
  /** `now.index / then.index` — 1.05 is five percent healthier. */
  ratio: number;
  /** Index points between the two (`now − then`). */
  delta: number;
  then: HealthIndexPoint;
  now: HealthIndexPoint;
  /** Weeks actually between the two points — `weeks` asked or more, since a
   *  week nobody measured has no point. The UI names `then.week`. */
  weeks: number;
}

/**
 * "Vs 12 weeks ago": the index at `points[at]` (default the latest) against
 * the LATEST measured point at least `weeks` earlier — however much further
 * back that is, because a week with no commit has no row and the honest
 * comparison names the week it actually used (`then.week`, `weeks`). Null
 * only when no point sits that far back (a series younger than the horizon).
 *
 * Carried links are inside the ratio as the 1s they are; a chained index has
 * already carried every prereg or `central` change between the two.
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
  const windows: number[] = [];
  for (let j = W; j < t; j++) windows.push(Math.log(points[j].index / points[j - W].index));
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

/** Plain names for an entry's move: index [0] when it rose (index slipped), [1] when it fell. */
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
  /** `Health index 94 (−4 this week)`. */
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
    ? `The index ${verb} ${pts} point${pts === 1 ? "" : "s"} ${when}: ${top.join(", ")}.`
    : `The index ${verb} ${pts} point${pts === 1 ? "" : "s"} ${when}.`;
  return {
    chip: `Health ${value} ${signedPoints(move.delta)}`,
    title: `Health index ${value} (${signedPoints(move.delta)} ${when})`,
    body,
  };
}

/** What `RepoTarget.healthIndex` carries. */
export interface RepoHealthIndex {
  value: number;
  /** The latest week's move in index points; null when that week was carried (gap) or is the baseline. */
  deltaWeek: number | null;
  /** The latest week's Monday. */
  week: string;
  move: "drop" | "rise" | null;
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
  };
}

/**
 * `GET /api/repos/:id/healthindex` — the whole chained series for the phone's
 * chart, the called move and its words. `series: null` + `reason` when there is
 * no series file or no baseline week yet; never a made-up 100.
 */
export interface HealthIndexResponse {
  series: HealthIndexSeries | null;
  move: HealthMove | null;
  words: HealthWords | null;
  /** ISO time of the last weekly refresh this host ran for the repo, if any. */
  lastRefresh: string | null;
  reason?: string;
}
