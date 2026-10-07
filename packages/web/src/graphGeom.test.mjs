/**
 * The machine graphs' geometry (`graphGeom.ts`). Pinned: the readings span the
 * whole width (the strip's right-aligned slots left two thirds of the sheet's
 * graph blank), a gap is never bridged, a lone reading is never dropped, a
 * value past the ceiling is clamped, and a gap in one line is not a gap in
 * the graph.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { gapXs, lineGeom, roomyCeiling, seriesStats, xAt, yAt } from "./graphGeom.ts";

const F = { w: 300, h: 100, lo: 0, hi: 100 };

test("readings span the full width, first at 0 and last at w", () => {
  assert.equal(xAt(0, 47, 300), 0);
  assert.equal(xAt(46, 47, 300), 300);
  const g = lineGeom([10, 20, 30], F);
  assert.equal(g.runs.length, 1);
  assert.match(g.runs[0], /^0\.0,/);
  assert.match(g.runs[0], / 300\.0,[\d.]+$/);
});

test("a gap splits the line instead of bridging it", () => {
  const g = lineGeom([10, 20, null, 30, 40], F);
  assert.equal(g.runs.length, 2);
  assert.equal(g.areas.length, 2);
});

test("a lone reading between gaps is a dot, not dropped", () => {
  const g = lineGeom([10, 20, null, 50, null, 30, 40], F);
  assert.equal(g.runs.length, 2);
  assert.equal(g.dots.length, 1);
  assert.equal(g.dots[0].x, 150);
});

test("values outside the frame are clamped onto its edge", () => {
  assert.equal(yAt(250, F), yAt(100, F));
  assert.equal(yAt(-5, F), yAt(0, F));
  assert.ok(yAt(100, F) >= 0 && yAt(0, F) <= F.h);
});

test("a graph gap needs EVERY line to be missing", () => {
  assert.deepEqual(gapXs([[1, null, 3], [1, 2, 3]], 200), []);
  assert.deepEqual(gapXs([[1, null, 3], [1, null, 3]], 200), [100]);
});

test("stats read only what was measured", () => {
  assert.equal(seriesStats([null, null]), null);
  assert.deepEqual(seriesStats([5, null, 2, 9, null]), { last: 9, min: 2, max: 9 });
});

test("the fitted rpm ceiling has headroom and a floor", () => {
  assert.equal(roomyCeiling([1005, 1007], 2000, 500), 2000);
  assert.equal(roomyCeiling([3000], 2000, 500), 4000);
  assert.equal(roomyCeiling([null], 2000, 500), 2000);
});
