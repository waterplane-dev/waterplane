import test from "node:test";
import assert from "node:assert/strict";
import { weekCalKey, WEEK_MS } from "./logic.ts";

const now = Date.UTC(2026, 9, 1, 12);
const u = (over = {}) => ({
  ok: true, sessionPct: 2, weeklyPct: 94, sessionResetAt: null,
  weeklyResetAt: now + 86_400_000, checkedAt: now - 60_000, ...over,
});

test("weekCalKey: a live weekly reading is keyed by itself", () => {
  assert.equal(weekCalKey(u(), now), `${now + 86_400_000}:${now - 60_000}:94`);
});

test("weekCalKey: no key where a share would be a wrong number", () => {
  assert.equal(weekCalKey(null, now), null);
  assert.equal(weekCalKey(u({ weeklyPct: null }), now), null);
  assert.equal(weekCalKey(u({ weeklyPct: 3 }), now), null);          // ±0.5 of 3%
  assert.equal(weekCalKey(u({ weeklyResetAt: null }), now), null);
  assert.equal(weekCalKey(u({ weeklyResetAt: now - 1 }), now), null); // rolled
  assert.equal(weekCalKey(u({ weeklyResetAt: now + WEEK_MS, checkedAt: now - 1 }), now), null); // week just opened
});
