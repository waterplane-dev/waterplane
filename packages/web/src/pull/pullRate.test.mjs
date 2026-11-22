import test from "node:test";
import assert from "node:assert/strict";
import { nextNativeRate, RATE_SAMPLE_MAX_GAP_MS } from "./pullRate.ts";

test("first reading has no rate", () => {
  assert.equal(nextNativeRate(undefined, undefined, 1000, 5000), undefined);
});

test("growth over time is bytes per second, then smoothed", () => {
  const r1 = nextNativeRate(undefined, { received: 0, at: 0 }, 2_000_000, 2000);
  assert.equal(r1, 1_000_000);
  const r2 = nextNativeRate(r1, { received: 2_000_000, at: 2000 }, 4_000_000, 3000);
  assert.equal(r2, 1_000_000 * 0.7 + 2_000_000 * 0.3);
});

test("a reading from before a long gap says nothing about now", () => {
  assert.equal(nextNativeRate(500, { received: 0, at: 0 }, 9e6, RATE_SAMPLE_MAX_GAP_MS + 1), undefined);
});

test("no growth keeps the last rate; the stall shows elsewhere", () => {
  assert.equal(nextNativeRate(700, { received: 10, at: 0 }, 10, 1000), 700);
});
