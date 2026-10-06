/**
 * The token-statistics charts' geometry, with no DOM in it.
 *
 * Same split and the same reason as `contextPlot.ts`: a chart is the one view
 * where being slightly wrong looks exactly like being right, so the scales, the
 * bars and the stacks are plain functions over plain numbers and the `.tsx`
 * emits SVG. It borrows `contextPlot`'s time axis and tick scale deliberately —
 * two chart modules with two ways of rounding an axis is how a dashboard ends
 * up with two visual languages.
 *
 * Three forms live here, each picked for its data's job:
 *
 *  - **Cumulative area** — the running total over real dates. One series, so no
 *    legend; it is the answer to the question the screen was asked.
 *  - **Daily columns** — one column per active day. Also one series: the split
 *    by kind is NOT stacked here, because 96% of every column would be a single
 *    colour and the other three would be invisible slivers pretending to be
 *    information.
 *  - **Horizontal bars** — by model, by repo. Horizontal because the categories
 *    are long names, and a rotated axis label is a worse chart than a rotated
 *    layout.
 *
 * And one non-chart: `compose`, the single 100%-wide part-to-whole strip for
 * the four token kinds. That is the one place stacking is right — one bar, four
 * segments, exact values in the legend beside it — and it is also the only
 * honest way to show a 96/3/0.2/0.007 split at all.
 */
/*
 * FACADE. The geometry lives in `stats/` by subject (docs/notes/charts-architecture.md); this file
 * only re-exports it, so no importer has to change. The scales, path text and nearest-by-time
 * pick it shares with `contextPlot.ts` are `chartScale.ts` / `chartPath.ts` / `chartFmt.ts`.
 * The `.ts` extensions are explicit so `node --test` can resolve these modules straight over the
 * TypeScript; `moduleResolution: Bundler` accepts them and Vite rewrites them.
 *
 *   splotDay     the day axis: cumulative/daily plot, step/area paths, columns, ticks, trend line
 *   splotBars    horizontal bars, the composition strip, the clock face
 *   splotWeeks   calendar weeks
 *   splotMix     composition over time: stacked columns, gap-filled series, stacked areas
 *   splotUsage   the limit windows' history: segments, burn rate, outlook, crosshair pick
 */
export * from "./stats/splotDay.ts";
export * from "./stats/splotBars.ts";
export * from "./stats/splotWeeks.ts";
export * from "./stats/splotMix.ts";
export * from "./stats/splotUsage.ts";
