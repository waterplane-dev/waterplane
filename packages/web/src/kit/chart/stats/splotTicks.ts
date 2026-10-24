/**
 * The day axis's x labels — a slice of `splotDay.ts` (re-exported by `statsPlot.ts`), split
 * out when the day form got its own rules (docs/notes/charts-architecture.md).
 */

import { fmtAxisDay, fmtAxisTime } from "../chartFmt.ts";
import { DAY_MS, type DayPlot } from "./splotDay.ts";

type Tick = { x: number; label: string; anchor: "start" | "middle" | "end" };
const edge = (i: number, last: number): Tick["anchor"] => (i === 0 ? "start" : i === last ? "end" : "middle");

/** The x labels, placed by pixel. Intraday: three clock-aware labels. Day plots name DAYS
 *  only (never a clock): one tick for one day, one per day up to a week, else three. */
export function dayTicks(p: DayPlot): Tick[] {
  const span = p.t1 - p.t0;
  if (p.step < DAY_MS) return [0, 0.5, 1].map((f, i) => ({ x: p.x + f * p.w, label: fmtAxisTime(p.t0 + f * span, span), anchor: edge(i, 2) }));
  const n = Math.round(span / p.step);
  // Buckets sit on LOCAL midnights and a DST day is 23h or 25h: walk the calendar, not ms.
  const first = new Date(p.t0 + p.step / 2);
  const dayI = (i: number) => new Date(first.getFullYear(), first.getMonth(), first.getDate() + i).getTime();
  if (n <= 1) return [{ x: p.x + p.w / 2, label: fmtAxisDay(dayI(0)), anchor: "middle" }];
  // Past a week: the first, middle and last BUCKET (not the padded half-day beyond).
  if (n > 7) return [0, Math.round((n - 1) / 2), n - 1].map((d, k) => ({ x: p.x + (k / 2) * p.w, label: fmtAxisDay(dayI(d)), anchor: edge(k, 2) }));
  return Array.from({ length: n }, (_, i) => ({ x: p.px(dayI(i)), label: fmtAxisDay(dayI(i)), anchor: edge(i, n - 1) }));
}
