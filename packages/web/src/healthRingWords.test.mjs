/** The ring gauge's geometry, pure (`node --test`). */
import test from "node:test";
import assert from "node:assert/strict";
import { ringGeom } from "./healthRingWords.ts";

const pt = (s) => s.match(/-?[\d.]+/g).map(Number);

test("the track starts bottom-left and ends bottom-right, a 270° clockwise sweep", () => {
  const g = ringGeom(50, 40, 6);
  assert.ok(g);
  assert.equal(g.cx, 43);
  assert.equal(g.cy, 43);
  assert.equal(g.w, 86);
  const [sx, sy, , , , large, sweep, ex, ey] = pt(g.track);
  assert.ok(sx < g.cx && sy > g.cy, "starts bottom-left");
  assert.ok(ex > g.cx && ey > g.cy, "ends bottom-right");
  assert.equal(large, 1);
  assert.equal(sweep, 1);
  assert.ok(Math.abs(sy - ey) < 0.01, "the gap is level at the bottom");
  assert.ok(Math.abs(g.h - (ey + 3)) < 0.01, "the box stops under the ends");
});

test("50 is the top of the ring; under 2/3 is a small arc", () => {
  const g = ringGeom(50, 40, 6);
  const [, , , , , large, , ex, ey] = pt(g.arc);
  assert.ok(Math.abs(ex - g.cx) < 0.01 && Math.abs(ey - 3) < 0.01);
  assert.equal(large, 0);
  assert.equal(pt(ringGeom(70, 40, 6).arc)[5], 1, "past 180° the large-arc flag flips");
});

test("0 draws no arc, 100 is the whole track, out of range clamps", () => {
  assert.equal(ringGeom(0, 40, 6).arc, null);
  assert.equal(ringGeom(0, 40, 6).end, null);
  assert.equal(ringGeom(-12, 40, 6).arc, null);
  const full = ringGeom(100, 40, 6);
  assert.equal(full.arc, full.track);
  assert.equal(ringGeom(140, 40, 6).arc, full.track);
  assert.equal(ringGeom(140, 40, 6).value, 100);
});

test("a value or size that cannot be drawn is null, never an empty ring", () => {
  assert.equal(ringGeom(NaN, 40, 6), null);
  assert.equal(ringGeom(Infinity, 40, 6), null);
  assert.equal(ringGeom(50, 0, 6), null);
  assert.equal(ringGeom(50, 40, -1), null);
  for (const v of [0, 1, 33, 99.9, 100]) assert.doesNotMatch(ringGeom(v, 40, 6).track + (ringGeom(v, 40, 6).arc ?? ""), /NaN/);
});
