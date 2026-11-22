/** `weekCosts.ts`: the limit-week view's per-week dollars. */
import test from "node:test";
import assert from "node:assert/strict";
import { weekCostRows, weekCostTakeaway } from "./weekCosts.ts";

const W = 7 * 864e5;
const cell = (back, usd) => ({
  back, openedAt: -back * W - W, resetAt: -back * W,
  totals: usd == null ? null : { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, turns: 1 },
  cost: usd == null ? null : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: usd },
});
const when = (a) => `w${-a / W - 1}`;

test("rows: newest first, uncovered weeks left out, bars against the dearest", () => {
  const rows = weekCostRows([cell(3, null), cell(2, 1000), cell(1, 0), cell(0, 500)]);
  assert.deepEqual(rows.map((r) => r.back), [0, 1, 2]);
  assert.equal(rows[0].running, true);
  assert.equal(rows[2].frac, 1);
  assert.equal(rows[0].frac, 0.5);
});

test("takeaway: a figure no row prints — the median, and the running week against it", () => {
  const rows = weekCostRows([cell(3, 3000), cell(2, 1000), cell(1, 0), cell(0, 500)]);
  assert.equal(weekCostTakeaway(rows), "Median of 2 finished weeks: $2,000; this week so far is 25% of that.");
});

test("takeaway: one finished week, and none", () => {
  assert.equal(weekCostTakeaway(weekCostRows([cell(1, 3335), cell(0, 1817)])), "Only one finished week ran anything; this week so far is 54% of it.");
  assert.equal(weekCostTakeaway(weekCostRows([cell(0, 12)])), null);
  assert.equal(weekCostTakeaway([]), null);
});
