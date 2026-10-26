import test from "node:test";
import assert from "node:assert/strict";
import { RUNNING_GAP_MS, SCREEN_SWEEP_MAX, screenSweepIds, sweepScreens } from "./screenSweep.ts";

const now = 10 * RUNNING_GAP_MS;

test("the attached session is never swept; idle ones every sweep", () => {
  const s = [{ id: "a", running: true, idle: true }, { id: "b", running: false }, { id: "c", running: true, idle: true }];
  assert.deepEqual(screenSweepIds(s, "a", new Map([["b", now], ["c", now]]), now, false), ["b", "c"]);
});

test("a running session is re-read only after the gap, four times longer on data saver", () => {
  const s = [{ id: "r", running: true, idle: false }];
  const asked = new Map([["r", now - RUNNING_GAP_MS + 1]]);
  assert.deepEqual(screenSweepIds(s, null, asked, now, false), []);
  assert.deepEqual(screenSweepIds(s, null, new Map([["r", now - RUNNING_GAP_MS]]), now, false), ["r"]);
  assert.deepEqual(screenSweepIds(s, null, new Map([["r", now - RUNNING_GAP_MS]]), now, true), []);
  assert.deepEqual(screenSweepIds(s, null, new Map(), now, true), ["r"]);
});

test("only the newest that the phone keeps are asked for", () => {
  const s = Array.from({ length: SCREEN_SWEEP_MAX + 3 }, (_, i) => ({ id: `s${i}`, running: false }));
  assert.equal(screenSweepIds(s, null, new Map(), now, false).length, SCREEN_SWEEP_MAX);
});

test("a 204 applies nothing, a tap during the fetch wins, a failure is retried", async () => {
  const applied = [];
  const asked = new Map();
  let attachedNow = null;
  await sweepScreens(["u", "t", "x", "ok"], {
    fetchTail: async (id, since) => {
      if (id === "u") { assert.equal(since, 7); return null; }
      if (id === "x") throw new Error("404 screen tail");
      if (id === "t") attachedNow = "t";
      return { data: "bytes", seq: 9, boot: "b1" };
    },
    heldSeq: (id) => (id === "u" ? 7 : undefined),
    attached: (id) => id === attachedNow,
    apply: async (id) => { applied.push(id); },
  }, asked);
  assert.deepEqual(applied, ["ok"]);
  assert.equal(asked.has("x"), false);
  assert.equal(asked.has("ok"), true);
});
