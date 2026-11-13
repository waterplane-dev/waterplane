/**
 * The agent readings' weekly bars: a week not taken draws no bar, stacks
 * accumulate bottom-first in value space, the top is a printed tick, and a tap
 * anywhere in a slot picks that week.
 *
 *     node --test packages/web/src/agentWeekPlot.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { colAt, labelCols, weekBars } from "./agentWeekPlot.ts";

test("a null week has no parts; a stack's parts sit on each other and its top is the total", () => {
  const g = weekBars([[2, 3], null, [0, 0]], 300, 100, 40, 6);
  assert.equal(g.cols[1].parts, null);
  assert.equal(g.cols[1].total, null);
  assert.deepEqual(g.cols[2].parts, []); // a zero is present, just empty
  const [a, b] = g.cols[0].parts;
  assert.ok(Math.abs(a.y - (b.y + b.h)) < 1e-9);
  assert.equal(g.ticks.at(-1), g.top);
  assert.ok(g.top >= 5);
});

test("a ratio under one gets a fractional top, not a scale floored at 1", () => {
  const g = weekBars([[0.4], [0.2]], 100, 100, 0, 0);
  assert.ok(g.top < 1 && g.top >= 0.4, String(g.top));
});

test("a tap picks by slot, clamped; labels never collide and the picked week keeps its label", () => {
  assert.equal(colAt(45, 40, 120, 12), 0);
  assert.equal(colAt(155, 40, 120, 12), 11);
  assert.equal(colAt(-5, 40, 120, 12), 0);
  const cx = (i) => 40 + 10 * (i + 0.5);
  assert.deepEqual(labelCols(12, 1, cx, 38), [1, 11]);
  assert.deepEqual(labelCols(12, 6, cx, 38), [0, 6, 11]);
});
