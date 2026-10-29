// healthindex/move: The move detector: a drop or rise called only against the series' own past. Barrel: ../healthindex.ts (read the header there).
import { HEALTH_INDEX_MIN_WEEKS, HEALTH_INDEX_MIN_MONTH_WINDOWS, HEALTH_INDEX_MONTH_WEEKS, HEALTH_INDEX_LOW_PCT, HEALTH_INDEX_HIGH_PCT, HEALTH_INDEX_MIN_POINTS, type HealthIndexPoint } from "./types.js";

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
