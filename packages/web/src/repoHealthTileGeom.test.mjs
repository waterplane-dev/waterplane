/**
 * The tiles grid's pure halves: which tile is open, the area under a curve,
 * the reading an untouched readout names, and the grid's own words.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { latestIndex, openAmong, sparkAreaPath, toggleOpen } from "./repoHealthTileGeom.ts";
import { sparkGeom } from "./repoHealthPlot.ts";
import { TILE_FOLD_LABEL, areaAbsentWords, tileToggleTitle } from "./repoHealthTileWords.ts";

test("one tile open at a time: a tap opens, the same tap folds, another tap moves", () => {
  assert.equal(toggleOpen(null, "size.p95"), "size.p95");
  assert.equal(toggleOpen("size.p95", "size.p95"), null);
  assert.equal(toggleOpen("size.p95", "retouch.rate"), "retouch.rate");
});

test("an open key a refresh dropped is no open tile", () => {
  assert.equal(openAmong("gone", ["a", "b"]), null);
  assert.equal(openAmong("a", ["a", "b"]), "a");
  assert.equal(openAmong(null, ["a"]), null);
});

test("a flat series gets no wash; neither does no path", () => {
  const g = sparkGeom([3, 3, 3], 100, 32);
  assert.ok(g?.flat);
  assert.equal(sparkAreaPath(g.d, 31.5, g.flat), "");
  assert.equal(sparkAreaPath("", 31.5, false), "");
});

test("the wash closes each run to the floor and never bridges a hole", () => {
  const g = sparkGeom([1, 2, null, 3, 4], 100, 32);
  const a = sparkAreaPath(g.d, 31.5, g.flat);
  const runs = a.split("Z").filter(Boolean);
  assert.equal(runs.length, 2, "two runs, two closed areas");
  for (const r of runs) {
    assert.match(r, /^M[\d.]+,31\.5L/, "starts on the floor, then an L — never a bare splice");
    assert.match(r, /L[\d.]+,31\.5$/, "ends back on the floor");
  }
  // The first run ends at x=25 (index 1), the second starts at x=75 (index 3).
  assert.match(runs[0], /L25\.0,31\.5$/);
  assert.match(runs[1], /^M75\.0,31\.5/);
  assert.doesNotMatch(a, /NaN/);
});

test("a lone reading between holes is a dot, not an area", () => {
  const g = sparkGeom([1, null, 2, null, 3, 4], 100, 32);
  const a = sparkAreaPath(g.d, 31.5, g.flat);
  assert.equal(a.split("Z").filter(Boolean).length, 1);
});

test("the untouched readout names the newest drawn reading", () => {
  assert.equal(latestIndex([1, 2, null]), 1);
  assert.equal(latestIndex([null, null]), null);
  assert.equal(latestIndex([]), null);
});

test("per-area absences are said, each its own sentence", () => {
  assert.match(areaAbsentWords({ areas: {}, absent: "the family was not read" }), /not taken on the latest day — the family was not read/);
  assert.match(areaAbsentWords({ areas: {}, areasAbsent: "no router skills" }), /No per-area reading here — no router skills\./);
  assert.match(areaAbsentWords({ areas: {} }), /^No per-area reading here\./);
  assert.equal(areaAbsentWords({ areas: { host: {} } }), null);
});

test("no verdict word in the grid's words", () => {
  const all = [
    TILE_FOLD_LABEL, tileToggleTitle("p95 file size", false), tileToggleTitle("p95 file size", true),
    areaAbsentWords({ areas: {}, absent: "x" }), areaAbsentWords({ areas: {} }),
  ].join("\n");
  for (const w of ["score", "grade", "healthy", "unhealthy", "good", "bad", "should", "worse", "better"]) {
    assert.doesNotMatch(all, new RegExp(`\\b${w}\\b`, "i"));
  }
});
