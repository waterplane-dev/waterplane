/**
 * The y scales and the plot box both chart geometries are built on, with no DOM in them.
 *
 * `contextPlot.ts` (the piecewise time axis) and `statsPlot.ts` (the linear day axis) draw
 * different x axes and the SAME y one: the same nice-number ticks, the same clamp into the
 * domain, the same inner box inside a padded frame, the same nearest-by-time pick. These were
 * written twice; they live here once. The function bodies are moved verbatim.
 */

/**
 * The y axis: its top and its ticks, from ONE computation.
 *
 * Deriving the two separately is a bug that looks like a chart. The first draft
 * rounded the domain up to a nice ceiling and then asked for ticks over that
 * ceiling — which produced a domain of 250k carrying a tick labelled 300k, and
 * since a value is clamped into the domain before it is drawn, that label sat
 * at the top of the plot naming a height nothing could reach. Every reading on
 * the chart was then a third lower than the axis said.
 *
 * So the ticks come first and the top of the axis IS the last tick. `want` is
 * five rather than four on purpose: at four, a 200k window rounds its step up
 * to 100k and the whole conversation is squashed into the bottom 60% of the
 * plot for no reason.
 */
export function yScale(rawMax: number, want = 5): { top: number; ticks: number[] } {
  if (!(rawMax > 0)) return { top: 1, ticks: [0, 1] };
  // A little headroom, so a curve that touches its ceiling is not drawn ON the
  // top edge where its label has nowhere to go.
  const target = rawMax * 1.04;
  const raw = target / want;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const f = raw / mag;
  // Floored at 1: the axis counts TOKENS, so a sub-integer step would produce
  // ticks that round to the same label twice ("0, 0, 1, 1").
  const step = Math.max(1, (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * mag);
  const top = Math.ceil(target / step) * step;
  const ticks: number[] = [];
  for (let v = 0; v <= top + step / 2; v += step) ticks.push(Math.round(v));
  return { top, ticks };
}

/**
 * The shared axis: 0 to 100% of the window, in whole 25% steps.
 *
 * Returned in TOKENS so the rest of the plot needs no second unit — only the
 * tick LABELS are percentages. The top rises past 100% only for a series that
 * exceeds its window, and then still in 25% steps, so two charts' gridlines
 * remain the same heights.
 */
export function pctScale(windowTok: number, peak: number): { top: number; ticks: number[] } {
  const steps = Math.max(4, Math.ceil((peak / windowTok) * 4 - 1e-9));
  const top = (windowTok / 4) * steps;
  const ticks: number[] = [];
  for (let i = 0; i <= steps; i++) ticks.push(Math.round((windowTok / 4) * i));
  return { top, ticks };
}

export interface PlotPad { top: number; right: number; bottom: number; left: number }

/** The inner plot box inside a padded frame — never under one unit, so a degenerate frame
 *  still divides cleanly. */
export function plotBox(width: number, height: number, pad: PlotPad): { w: number; h: number } {
  return {
    w: Math.max(1, width - pad.left - pad.right),
    h: Math.max(1, height - pad.top - pad.bottom),
  };
}

/** Value → y pixel in a plot box starting at `top` and `h` tall, CLAMPED into `0..yMax` — a
 *  reading past the domain is drawn on the edge, never off the plot. */
export function plotY(top: number, h: number, yMax: number): (v: number) => number {
  return (v) => top + h - (Math.max(0, Math.min(v, yMax)) / yMax) * h;
}

/**
 * The item nearest an instant, by TIME rather than by pixel.
 *
 * Same answer at any width, which matters because a readout is the only way to read an
 * individual value and a phone rotating must not change which point a given moment resolves
 * to. Each candidate's distance to the POINTER is compared with the incumbent's distance to the
 * pointer — a first draft compared a candidate against itself, which is right on an evenly
 * spaced series and wrong everywhere else. Ties keep the earlier item.
 */
export function nearestByTime<T>(items: readonly T[], t: number, at: (x: T) => number): T | null {
  if (!items.length) return null;
  let best = items[0];
  for (const s of items) if (Math.abs(at(s) - t) < Math.abs(at(best) - t)) best = s;
  return best;
}
