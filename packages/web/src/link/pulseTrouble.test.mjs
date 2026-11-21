/**
 * When the connection strip shows itself in "only when something is wrong" mode.
 *
 *     node --test packages/web/src/link/pulseTrouble.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { HOLD_MS, SLOW_MS, stripShown, troubleReasons } from "./pulseTrouble.ts";

const ok = (n, ms = 20) => Array.from({ length: n }, (_, i) => ({ at: i, ms }));
const base = { status: "open", samples: ok(12), insecure: false, stuckSends: 0, restarting: false };

test("a good link has nothing to say", () => {
  assert.deepEqual(troubleReasons(base), []);
});

test("each wrong fact names itself", () => {
  assert.deepEqual(troubleReasons({ ...base, status: "offline" }), ["offline"]);
  assert.deepEqual(troubleReasons({ ...base, status: "connecting" }), ["offline"]);
  assert.deepEqual(troubleReasons({ ...base, insecure: true }), ["insecure"]);
  assert.deepEqual(troubleReasons({ ...base, stuckSends: 2 }), ["stuck"]);
  assert.deepEqual(troubleReasons({ ...base, restarting: true }), ["restart"]);
  assert.deepEqual(troubleReasons({ ...base, samples: [...ok(9), { at: 9, ms: null }] }), ["lossy"]);
  assert.deepEqual(troubleReasons({ ...base, samples: ok(10, SLOW_MS + 1) }), ["slow"]);
});

test("an old miss or one slow probe is not trouble", () => {
  assert.deepEqual(troubleReasons({ ...base, samples: [{ at: 0, ms: null }, ...ok(10)] }), []);
  assert.deepEqual(troubleReasons({ ...base, samples: [...ok(9), { at: 9, ms: 2000 }] }), []);
});

test("misses while offline are the offline reason, not a second one", () => {
  assert.deepEqual(troubleReasons({ ...base, status: "offline", samples: [{ at: 0, ms: null }] }), ["offline"]);
});

test("always is always; trouble mode holds the strip after the last wrong reading", () => {
  assert.equal(stripShown("always", [], null, 0), true);
  assert.equal(stripShown("trouble", [], null, 0), false);
  assert.equal(stripShown("trouble", ["slow"], null, 0), true);
  assert.equal(stripShown("trouble", [], 1000, 1000 + HOLD_MS - 1), true);
  assert.equal(stripShown("trouble", [], 1000, 1000 + HOLD_MS), false);
});
