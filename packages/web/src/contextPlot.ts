/**
 * The context-window graph's geometry, with no DOM in it.
 *
 * ── Why this is its own file ────────────────────────────────────────────────
 *
 * A chart is the one kind of view where being *slightly* wrong is invisible.
 * A row that renders the wrong verdict is caught by anyone reading it; a curve
 * whose y axis silently excludes the ceiling it is drawn against, or whose
 * event tick lands two pixels off the cliff it names, looks exactly like a
 * correct chart. So the scales, the ticks, the paths and the hit-testing are
 * plain functions over plain numbers, pinned by `contextPlot.test.mjs`, and
 * `ContextGraph.tsx` is left with nothing to do but emit SVG.
 *
 * ── What the graph is claiming ──────────────────────────────────────────────
 *
 * One series — how many tokens each request carried — over real time, with two
 * kinds of event on the same axis: a compaction (the conversation was
 * summarised and the window fell) and a usage wall (the account refused). Both
 * come dated from the CLI's own log, which is the whole reason this can be a
 * graph at all (host `ctxlog.ts`).
 *
 * Two rules that are easy to lose in a refactor:
 *
 *  - **The y domain must contain every reference line it draws.** A ceiling
 *    line clipped off the top of the plot is worse than no ceiling line: the
 *    curve then looks like it is nowhere near the limit.
 *  - **Every chart shares one y axis: 0 to 100% of the model's window.** Two
 *    sessions' graphs are only worth putting side by side if "half full" means
 *    the same thing on both, and a per-chart axis fitted to each series' own
 *    peak makes a 40k conversation and a 900k one look identical. The window
 *    comes from the model (`@waterplane/shared`'s `contextWindowFor`); when the model
 *    is not recognised the axis falls back to TOKENS and the chart says so,
 *    rather than pretending to a percentage it cannot compute.
 *  - **The axis is not re-fitted to the data.** The top stays 100% even for a
 *    conversation that only ever reached 12%, because a curve hugging the floor
 *    IS the answer to "how full is it". The one exception is a series that
 *    somehow exceeds the window: the top then rises in whole 25% steps, so the
 *    gridlines still line up with every other chart.
 */
/*
 * FACADE. The geometry lives in `contextPlot/` by subject (docs/notes/charts-architecture.md);
 * this file only re-exports it, so no importer has to change. The formatting, scales and path
 * text both plots share are in `kit/chart/` (`chartFmt`, `chartScale`, `chartPath`).
 *
 *   cplotAxis    the piecewise time axis, `Plot` and `makePlot`, axis labels
 *   cplotSpend   what a conversation has spent: facts, sentences, split, the agents' band
 *   cplotPaths   line / area / stacked bands, the nearest reading
 *   cplotModels  which palette slot each model wears, the by-model stack
 *   cplotAgents  subagent swim lanes and lines
 *   cplotSpark   the two row miniatures
 *   cplotWords   event labels, the axis note, the series summary
 */
export { fmtTokens, fmtTokensFine, fmtAxisTime } from "./kit/chart/chartFmt.ts";
export { pctScale, yScale } from "./kit/chart/chartScale.ts";
export * from "./contextPlot/cplotAxis.ts";
export * from "./contextPlot/cplotSpend.ts";
export * from "./contextPlot/cplotPaths.ts";
export * from "./contextPlot/cplotModels.ts";
export * from "./contextPlot/cplotAgents.ts";
export * from "./contextPlot/cplotSpark.ts";
export * from "./contextPlot/cplotWords.ts";
