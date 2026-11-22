import { test } from "node:test";
import assert from "node:assert/strict";
import { rateSeries, niceCeil } from "./speedSeries.ts";

test("events closer than a window fold into one point", () => {
  // 1 MB every 50 ms = 160 Mbps; windows of 250 ms.
  const s = Array.from({ length: 10 }, (_, i) => ({ ms: (i + 1) * 50, bytes: (i + 1) * 1_000_000 }));
  const pts = rateSeries(s, 250);
  assert.equal(pts.length, 2);
  for (const p of pts) assert.ok(Math.abs(p.mbps - 160) < 1e-9);
  assert.equal(pts[1].t, 0.5);
});

test("the short tail window is kept so the line reaches the end", () => {
  const pts = rateSeries([{ ms: 300, bytes: 3_000_000 }, { ms: 400, bytes: 4_000_000 }], 250);
  assert.equal(pts.length, 2);
  assert.equal(pts[1].t, 0.4);
  assert.ok(Math.abs(pts[1].mbps - 80) < 1e-9);
});

test("no samples, no points; out-of-order samples never make a negative rate", () => {
  assert.deepEqual(rateSeries([]), []);
  const pts = rateSeries([{ ms: 300, bytes: 1000 }, { ms: 200, bytes: 500 }, { ms: 600, bytes: 2000 }], 250);
  assert.ok(pts.every((p) => p.mbps >= 0));
});

test("axis top rounds up to 1/2/5 × 10ⁿ", () => {
  assert.equal(niceCeil(0), 1);
  assert.equal(niceCeil(3.2), 5);
  assert.equal(niceCeil(17), 20);
  assert.equal(niceCeil(100), 100);
  assert.equal(niceCeil(640), 1000);
});
