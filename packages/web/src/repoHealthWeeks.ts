/**
 * The region's "weeks" x axis for the per-day plot series: one point per ISO
 * week, that week's LAST day — the same rule the health index uses for its
 * weekly points (`shared/healthindex.ts`'s `healthWeeks`), so a week reads the
 * same reading on the score and on every tile. Pure, node-tested
 * (`repoHealthWeeks.test.mjs`).
 *
 * Deliberately NOT in `repoHealthPlot.ts`: that module has no imports and
 * draws what the tool states. Folding is a choice of which readings to draw,
 * made here, and the caption names it (`axisModeWords`).
 *
 * A null value is still a point: the week's last point is kept whatever its
 * value, and the plot's hole rule then cuts the line there. Picking the last
 * NON-null point instead would quietly move a reading from the day it was read
 * to a day the week did not end on.
 */
import { isoWeekOf } from "@waterplane/shared";

/**
 * Indexes of the points to keep: for each ISO week, the index of its last
 * point in input order. A day that is not a `YYYY-MM-DD` has no week and is
 * kept as its own point (never dropped, never merged into a neighbour).
 * Ascending, so the result runs the direction the input does.
 */
export function weekLastIndices(days: readonly string[]): number[] {
  const last = new Map<string, number>();
  const keep: boolean[] = days.map(() => false);
  days.forEach((d, i) => {
    const w = isoWeekOf(d);
    if (w === null) keep[i] = true;
    else last.set(w, i);
  });
  for (const i of last.values()) keep[i] = true;
  const out: number[] = [];
  keep.forEach((k, i) => { if (k) out.push(i); });
  return out;
}

/** Each ISO week's LAST point, oldest first (input assumed oldest first). */
export function foldWeeks<T extends { day: string }>(points: readonly T[]): T[] {
  return weekLastIndices(points.map((p) => p.day)).map((i) => points[i]);
}
