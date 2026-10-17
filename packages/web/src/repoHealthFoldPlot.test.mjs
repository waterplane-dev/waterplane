/** The x-axis choice over a whole plot, pure (`node --test`). */
import test from "node:test";
import assert from "node:assert/strict";
import { foldPlot } from "./repoHealthFoldPlot.ts";

const DAYS = ["2026-09-28", "2026-10-01", "2026-10-04", "2026-10-05", "2026-10-14"];
const pts = (vs) => DAYS.map((day, i) => ({ day, sha7: `s${i}`, v: vs[i] }));
const series = (key) => ({ key, source: "central", label: key, unit: "", points: pts([1, 2, 3, 4, 5]), last: 5, reading: { rank: null, slope: null, n: 5, from: null }, detail: "" });

const plot = () => ({
  preregVersion: "1", windowReadings: 15, minReadings: 2, days: 5,
  series: [series("size.p95"), { ...series("untested.count"), variant: { kind: "override", why: "", means: "", unit: "", points: pts([9, 8, 7, 6, 5]), last: 5, since: null } }],
  context: { areas: {} },
  classics: {
    loc: pts([10, 20, 30, 40, 50]), files: pts([1, 1, 1, 1, 1]), deps: pts([0, 0, 0, 0, 0]),
    packages: [{ pkg: "a", points: pts([1, 2, 3, 4, 5]) }],
    types: [{ ext: "ts", pack: null, rank: 1, files: 3, points: pts([1, 2, 3, 4, 5]) }],
    tape: [300, 200, 100],
  },
  longest: { points: pts([100, 110, 120, 130, 140]), paths: ["a", "a", "b", "b", "c"], path: "c", day: "2026-10-14" },
  own: { file: "health.json", declared: true, series: [{ ...series("own.x"), source: "repo", means: "", better: null }] },
});

test("commits hands the plot back untouched", () => {
  const p = plot();
  assert.equal(foldPlot(p, "commits"), p);
});

test("weeks folds every per-day array to each week's last day, by one rule", () => {
  const f = foldPlot(plot(), "weeks");
  const want = ["2026-10-04", "2026-10-05", "2026-10-14"];
  const days = (a) => a.map((q) => q.day);
  assert.deepEqual(days(f.series[0].points), want);
  assert.deepEqual(days(f.series[1].variant.points), want);
  assert.deepEqual(days(f.classics.loc), want);
  assert.deepEqual(days(f.classics.packages[0].points), want);
  assert.deepEqual(days(f.classics.types[0].points), want);
  assert.deepEqual(days(f.own.series[0].points), want);
  assert.deepEqual(days(f.longest.points), want);
  // The holder names ride with their lengths, never shifted onto another week.
  assert.deepEqual(f.longest.paths, ["b", "b", "c"]);
  // One day's columns are not a series.
  assert.deepEqual(f.classics.tape, [300, 200, 100]);
});
