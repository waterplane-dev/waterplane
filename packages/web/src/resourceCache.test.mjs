/**
 * The default read cache's pure rules: key, size cap, shape, sweep.
 *
 *     node --test packages/web/src/resourceCache.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { resCacheKey, makeEntry, entryUsable, sweepVictims, MAX_ENTRIES, MAX_VALUE_BYTES, withoutConfirm, withoutApproveToken } from "./resourceCache.ts";

test("the key names the desktop, so two desktops never share a row", () => {
  assert.notEqual(resCacheKey("a", "skills"), resCacheKey("b", "skills"));
  assert.equal(resCacheKey(null, "skills"), "local|skills");
});

test("an entry from another desktop or shape is not usable", () => {
  const e = makeEntry("a", "k", 1, { x: 1 }, 10);
  assert.ok(entryUsable(e, "a", "k", 1));
  assert.ok(!entryUsable(e, "b", "k", 1));
  assert.ok(!entryUsable(e, "a", "k", 2));
  assert.ok(!entryUsable(null, "a", "k", 1));
});

test("null, undefined, cyclic and oversized values are not kept", () => {
  assert.equal(makeEntry("a", "k", 0, null, 1), null);
  assert.equal(makeEntry("a", "k", 0, undefined, 1), null);
  const c = {}; c.c = c;
  assert.equal(makeEntry("a", "k", 0, c, 1), null);
  assert.equal(makeEntry("a", "k", 0, "x".repeat(MAX_VALUE_BYTES), 1), null);
  assert.ok(makeEntry("a", "k", 0, "x".repeat(1000), 1));
});

test("the sweep drops the oldest and nothing under the cap", () => {
  const rows = Array.from({ length: MAX_ENTRIES + 3 }, (_, i) => ({ key: `k${i}`, savedAt: i }));
  assert.deepEqual(sweepVictims(rows).sort(), ["k0", "k1", "k2"]);
  assert.deepEqual(sweepVictims(rows.slice(0, MAX_ENTRIES)), []);
});

test("a cached copy drops its one-shot consent token and keeps the rest", () => {
  const report = { checks: [1], confirm: { "android-toolchain": "t" } };
  assert.deepEqual(withoutConfirm(report), { checks: [1] });
  assert.ok("confirm" in report, "the live value is never mutated");
  assert.deepEqual(withoutConfirm({ rules: [], rev: "r", confirm: "t" }), { rules: [], rev: "r" });
  const noTokens = { rules: [] };
  assert.equal(withoutConfirm(noTokens), noTokens);
  assert.equal(withoutConfirm(null), null);
  const view = { series: [1], engine: { kind: "repo", needsApproval: true, approveToken: "t" } };
  assert.deepEqual(withoutApproveToken(view), { series: [1], engine: { kind: "repo", needsApproval: true } });
  assert.equal(view.engine.approveToken, "t");
  assert.equal(withoutApproveToken({ engine: null }).engine, null);
  const plain = { engine: { kind: "bundled" } };
  assert.equal(withoutApproveToken(plain), plain);
});
