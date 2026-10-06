/**
 * SVG path text for the chart geometries — one place for the number format and the rules.
 *
 * Every path in `contextPlot.ts` / `statsPlot.ts` is one decimal (`toFixed(1)`), `M` then `L`s,
 * and an area closes to the baseline with an `L` and never a bare splice of the line. Moved
 * verbatim from the copies those files each carried.
 */

/** One decimal — the only precision a path is written at. */
export const f1 = (v: number): string => v.toFixed(1);

/** Polyline through the points, as `M…L…L…`. Empty string for no points, so a caller can
 *  render it unconditionally without drawing a stray `M0,0`. */
export function polyline<T>(items: readonly T[], x: (it: T, i: number) => number, y: (it: T, i: number) => number): string {
  if (!items.length) return "";
  return items.map((s, i) => `${i ? "L" : "M"}${f1(x(s, i))},${f1(y(s, i))}`).join("");
}

/**
 * A polyline closed to the baseline — the area wash under a line.
 *
 * The leading `M` of the line is replaced by an `L`, not merely dropped. Just dropping it —
 * `` `M${first},${base}${line.slice(1)}` `` — was the first draft, and it renders: `M40,200`
 * followed directly by `40,113` is `M40,20040` plus an implicit lineto, so the fill began
 * somewhere off the top of the world and came back in as a wedge sticking out of the left of
 * the plot. `first`, `last` and `base` arrive already formatted.
 */
export function closedArea(line: string, first: string | number, last: string | number, base: string | number): string {
  return `M${first},${base}L${line.slice(1)}L${last},${base}Z`;
}

/** A filled band between two edges: the top edge left to right, then the bottom edge back
 *  (callers `unshift` it, so it is already right to left). Points are `"x,y"` strings. */
export function bandOutline(top: string[], bottom: string[]): string {
  return `M${top.join("L")}L${bottom.join("L")}Z`;
}
