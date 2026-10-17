/**
 * The region's x-axis choice applied to a whole plot: `weeks` folds every
 * per-day array to each ISO week's last day (`foldWeeks`), `commits` hands the
 * plot back untouched. Pure, node-tested (`repoHealthFoldPlot.test.mjs`).
 *
 * One function so the tiles, the longest file, the stacks, the magnitudes and
 * the repo's own readings fold by ONE rule — a tile drawing 31 weeks beside a
 * stack drawing 214 days would be two x axes on one screen. Arrays that ride
 * PARALLEL to a points array (`longest.paths`) are cut by the same indices, or
 * a holder's name would land on another week's length.
 *
 * NOT applied to the readings table: it prints the last 14 readings as they
 * were taken, in either mode. Nor to `classics.tape`: that is one day's
 * columns, not a series.
 */
import type { RepoHealthPlot, RepoHealthPlotSeries, RepoHealthPoint } from "@waterplane/shared";
import { foldWeeks, weekLastIndices } from "./repoHealthWeeks.ts";

export type PlotAxis = "weeks" | "commits";

const fold = (pts: RepoHealthPoint[]): RepoHealthPoint[] => foldWeeks(pts);

function foldSeries<T extends RepoHealthPlotSeries>(s: T): T {
  const v = s.variant;
  return {
    ...s,
    points: fold(s.points),
    ...(v && v.kind === "override" ? { variant: { ...v, points: fold(v.points) } } : {}),
  };
}

export function foldPlot(plot: RepoHealthPlot, axis: PlotAxis): RepoHealthPlot {
  if (axis === "commits") return plot;
  const c = plot.classics;
  const longest = plot.longest;
  let foldedLongest = longest;
  if (longest) {
    const keep = weekLastIndices(longest.points.map((p) => p.day));
    const paths = longest.paths;
    foldedLongest = {
      ...longest,
      points: keep.map((i) => longest.points[i]),
      ...(paths && paths.length === longest.points.length ? { paths: keep.map((i) => paths[i]) } : {}),
    };
  }
  return {
    ...plot,
    series: plot.series.map(foldSeries),
    classics: {
      ...c,
      loc: fold(c.loc),
      files: fold(c.files),
      deps: fold(c.deps),
      packages: c.packages.map((p) => ({ ...p, points: fold(p.points) })),
      ...(c.types ? { types: c.types.map((t) => ({ ...t, points: fold(t.points) })) } : {}),
    },
    ...(foldedLongest ? { longest: foldedLongest } : {}),
    ...(plot.own ? { own: { ...plot.own, series: plot.own.series.map(foldSeries) } } : {}),
  };
}
