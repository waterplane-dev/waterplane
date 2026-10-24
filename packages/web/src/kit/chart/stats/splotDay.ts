/**
 * The day axis: the cumulative / daily plot, its paths, columns and ticks, and the trend line.
 *
 * Moved out of `statsPlot.ts` unchanged (docs/notes/charts-architecture.md); that file is the
 * facade that re-exports every module in `stats/`.
 */

import { yScale, plotBox, plotY, nearestByTime } from "../chartScale.ts";
import { f1, polyline, closedArea } from "../chartPath.ts";

// ── the cumulative / daily plot ───────────────────────────────────────────

export interface DayPoint {
  /** Local midnight of the day, epoch ms — a real instant, so a gap in the
   *  series reads as elapsed time rather than as one missing column. */
  t: number;
  /** What the chart is plotting for that day. */
  v: number;
  /** The day key, for labels and the table. */
  day: string;
}

export interface DayPlot {
  x: number; y: number; w: number; h: number;
  t0: number; t1: number;
  yMax: number;
  yTicks: number[];
  px: (t: number) => number;
  py: (v: number) => number;
  /** Width one day occupies — the column width before its gap is taken out. */
  slot: number;
  /** What one bucket is worth, ms — a day unless the plot is intraday. */
  step: number;
}

export interface DayPlotInput {
  width: number;
  height: number;
  pad: { top: number; right: number; bottom: number; left: number };
  points: DayPoint[];
  /**
   * What one bucket is worth on the x axis. A day by default; an HOUR for the
   * intraday chart, which is the same geometry one level down.
   *
   * Parameterised rather than copied into a second module for the reason in the
   * header: the moment there are two time axes there are two ways of rounding
   * one, and a dashboard whose charts disagree about where a day starts is
   * worse than a dashboard with one chart.
   */
  stepMs?: number;
  /**
   * A y axis fixed by the QUESTION rather than by the data — 100 for anything
   * plotted as a percentage of a window. Omitted, the scale is picked off the
   * peak, which is right for a count and wrong for a share: a 15%-used window
   * auto-fitted to 15 looks identical to a full one.
   */
  yMax?: number;
}

export const DAY_MS = 86_400_000;
export const HOUR_MS = 3_600_000;

/**
 * A linear time axis over whole days.
 *
 * Deliberately NOT `contextPlot`'s piecewise one: there, a two-day silence
 * between two turns is dead time worth compressing; here the x axis IS the
 * calendar and a quiet fortnight is the fact being shown. The domain is padded
 * by half a day at each end so the first and last columns sit inside the plot
 * instead of half-hanging off it.
 */
export function makeDayPlot(inp: DayPlotInput): DayPlot {
  const { width, height, pad, points } = inp;
  const step = inp.stepMs && inp.stepMs > 0 ? inp.stepMs : DAY_MS;
  const { w, h } = plotBox(width, height, pad);
  const first = points.length ? points[0].t : 0;
  const last = points.length ? points[points.length - 1].t : step;
  const t0 = first - step / 2;
  const t1 = last + step / 2;
  const span = Math.max(step, t1 - t0);
  const peak = points.reduce((m, p) => (p.v > m ? p.v : m), 0);
  // A fixed ceiling keeps its own ticks — running it through `yScale` would
  // round 100 up to 120 and draw a percentage axis that goes past full.
  const fixed = inp.yMax != null && inp.yMax > 0;
  const yMax = fixed ? inp.yMax! : yScale(peak).top;
  const yTicks = fixed
    ? [0, 0.25, 0.5, 0.75, 1].map((f) => f * inp.yMax!)
    : yScale(peak).ticks;
  return {
    x: pad.left, y: pad.top, w, h, t0, t1, yMax, yTicks,
    px: (t) => pad.left + ((t - t0) / span) * w,
    py: plotY(pad.top, h, yMax),
    slot: (step / span) * w,
    step,
  };
}

/** Polyline through the running total. */
export function stepPath(p: DayPlot, pts: DayPoint[]): string {
  return polyline(pts, (s) => p.px(s.t), (s) => p.py(s.v));
}

/** The same, closed to the baseline. `L`, never a bare splice — see
 *  `contextPlot`'s `areaPath` for the wedge the splice draws. */
export function areaUnder(p: DayPlot, pts: DayPoint[]): string {
  const line = stepPath(p, pts);
  if (!line) return "";
  return closedArea(line, f1(p.px(pts[0].t)), f1(p.px(pts[pts.length - 1].t)), f1(p.py(0)));
}

export interface Column { x: number; y: number; w: number; h: number; point: DayPoint }

/**
 * One column per day, capped and gapped.
 *
 * Capped at `maxW` because a bar that fills its slot reads as a solid block —
 * the band's leftover is meant to be air. Floored at a hairline because with
 * three months of days in a phone's width a slot is under two pixels, and a
 * column rounded to zero is a day that silently did not happen.
 */
export function columns(p: DayPlot, pts: DayPoint[], maxW = 14): Column[] {
  const w = Math.max(1, Math.min(maxW, p.slot - 2));
  return pts.map((point) => {
    const top = p.py(point.v);
    return { x: p.px(point.t) - w / 2, y: top, w, h: Math.max(point.v > 0 ? 1 : 0, p.py(0) - top), point };
  });
}

/** The day nearest a pointer x — by TIME, so the answer does not change with
 *  the width. Same rule, and the same past bug, as `contextPlot`. */
export function nearestDay(p: DayPlot, pts: DayPoint[], clientX: number): DayPoint | null {
  return nearestByTime(pts, p.t0 + ((clientX - p.x) / p.w) * (p.t1 - p.t0), (s) => s.t);
}

// ── the trend line ────────────────────────────────────────────────────────

/**
 * A trailing mean over a window of CALENDAR days, not of points.
 *
 * By time rather than by index because the day series has gaps in it: a
 * seven-POINT mean over a corpus with weekends missing averages nine real days
 * in one place and seven in another, and nothing on screen says which. By
 * calendar day, a quiet day is a zero that counts — which is what "7-day
 * average" means to the person reading it, and the only reading under which the
 * line can be compared with itself across a holiday.
 *
 * **It starts late, deliberately.** Until `days` days have elapsed the window is
 * not full, and dividing a partial window by the full count draws a line that
 * ramps up from nothing — a trend that is an artefact of the left edge. So no
 * point is emitted before the series is `days` days old, and the chart's
 * sentence says so rather than the reader inferring it from a line that starts
 * in the middle.
 */
export function rollingMean(pts: DayPoint[], days = 7): DayPoint[] {
  if (pts.length < 2 || days < 2) return [];
  const span = (days - 1) * DAY_MS;
  const out: DayPoint[] = [];
  const first = pts[0].t;
  let lo = 0;
  let sum = 0;
  for (let i = 0; i < pts.length; i++) {
    sum += pts[i].v;
    // Only a point whose whole window lies inside the series is emitted.
    while (lo <= i && pts[lo].t < pts[i].t - span) { sum -= pts[lo].v; lo++; }
    if (pts[i].t - first < span) continue;
    out.push({ t: pts[i].t, day: pts[i].day, v: sum / days });
  }
  return out;
}
