# The two plots and the annotator: target shape of the split

`packages/web/src/contextPlot.ts` (1421 lines), `packages/web/src/kit/chart/statsPlot.ts` (1196) and
`packages/web/src/ImageAnnotator.tsx` (1468) are cut by subject. All three originals stay importable
(same exports, read off the type checker) and become a facade. The rules the code holds are the
`web-numbers` skill's (one y axis, a total is never printed without its split, heuristics degrade
to absent) and `web-files`'s (an annotated image); this note is only about where the code lives.

## The plots: dedupe first, then split

The two plots draw different x axes (a piecewise time axis with drawn breaks; a linear calendar of
days) and the SAME everything else. Written twice, they now live once in `kit/chart/`:

| file | holds |
| --- | --- |
| `kit/chart/chartFmt.ts` | `fmtTokens`, `fmtTokensFine`, `fmtAxisTime` — one wording for an axis label and a readout |
| `kit/chart/chartScale.ts` | `yScale`, `pctScale`, `plotBox`, `plotY` (the clamp into `0..yMax`), `nearestByTime` |
| `kit/chart/chartPath.ts` | `f1` (one decimal), `polyline`, `closedArea` (an `L`, never a bare splice), `bandOutline` |

This dedupe changes structure and **never output**: the bodies are moved verbatim, and
`tools/plotpins.test.mjs` compares every exported pure function of both plots, over seeded
fixtures, with a golden recorded before the first move (a digest per observation), plus the export
surface of each facade. `contextPlot.test.mjs` and `statsPlot.test.mjs` pass untouched. Number
formatting is not altered (`toFixed(1)` in paths, the token wording in labels).

Then each plot is split by subject; the original path is a facade of `export *`:

| `contextPlot/` | holds |
| --- | --- |
| `cplotAxis.ts` | the piecewise time axis, `Plot`/`makePlot`, `SampleValue`/`TOK`/`USED`, axis labels |
| `cplotSpend.ts` | spend facts and their sentences, the split, the agents' spend band |
| `cplotPaths.ts` | `linePath`, `areaPath`, `stackBands`, `kindSeries`, `nearestSample` |
| `cplotModels.ts` | which palette slot each model wears, the by-model stack series |
| `cplotAgents.ts` | subagent swim lanes and lines, their sentences |
| `cplotSpark.ts` | the two row miniatures |
| `cplotWords.ts` | event labels, the axis note, the series summary |

| `kit/chart/stats/` | holds |
| --- | --- |
| `splotDay.ts` | the day axis, step/area paths, columns, ticks, the trend line, `DAY_MS`/`HOUR_MS` |
| `splotBars.ts` | horizontal bars, the composition strip, the clock face |
| `splotWeeks.ts` | calendar weeks |
| `splotMix.ts` | stacked columns, gap-filled series, stacked areas |
| `splotUsage.ts` | the limit windows' history, burn rate, outlook, crosshair pick |

Imports run one way: `chart*` ← `cplot*`/`splot*` ← the facade. The `cplot*` slices import each
other without a cycle (`cplotAxis` is the root). Prefixes because basenames are unique across packages.

## The annotator

`ImageAnnotator.tsx` is one 1340-line component: ~30 `useState`/`useRef`s, six effects and the whole
interaction written as closures over them, then the JSX. It becomes a composer over `annotator/`:

| file | holds |
| --- | --- |
| `ImageAnnotator.tsx` | FACADE: the props and the exported types, `useAnnotator`, then the regions |
| `annotator/annTypes.ts` | `Tool`, `Shape`, `AnnSource`, `AnnSend`, `AnnDispatch`, the colour / thickness tables |
| `annotator/annGeom.ts` | pure geometry: `normRect`, `segDist`, `shapeBBox`, `badgeAnchor`, `inkOn`, `baseWidth` |
| `annotator/annDraw.ts` | canvas painting over a `ctx`: shapes, bands, mosaic, badges, selection, knobs |
| `annotator/useAnnotator.ts` | THE state hook: every `useState`/`useRef`/`useEffect`, verbatim and in order |
| `annotator/annEdit.ts`, `annPointer.ts`, `annRead.ts`, `annSend.ts` | the handlers, as factories over the hook's context (bodies verbatim) |
| `annotator/AnnToolbar.tsx`, `AnnStage.tsx`, `AnnBars.tsx`, `AnnSendBar.tsx` | the regions: no hooks of their own, they read the model |

A hook in a region is forbidden (a child's effects run before its parent's, so moving one reorders
effects — the refactoring note's "hook ORDER" rule). A factory is called during render, destructures
the render-time state it closes over, and returns the same functions it did as closures, so what a
callback reads (ref vs render value) is unchanged. Proof: the server-rendered markup of the sheet,
over five prop combinations, byte-identical before and after.

## Caps and pins

`tools/webshape.test.mjs` ratchets the three facades and lists every file in the four folders once
with its own cap (none over 500). `tools/plotpins.test.mjs` is the golden above.
