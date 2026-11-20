// The recovery lanes' one timer registry (`sessions/timers.ts`) over a hand-driven Clock:
// one pending timer per lane per session, teardown cancels every lane, and a wall `continue`
// typed while a net retry is pending leaves ONE continue, not two. No PTY, no daemon.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "wp-timers-"));
process.env.WATERPLANE_ROOT = root;
const timers = await import("../dist/sessions/timers.js");
const { NetRetrySlice } = await import("../dist/sessions/apiretry.js");
const drive = await import("../dist/sessions/drive.js");
const { writeContinue } = await import("../dist/recover/recoverwrite.js");

/** A Clock whose time only moves when the test says so. */
function manualClock(start = 1_000_000) {
  let t = start;
  const due = [];
  return {
    now: () => t,
    sleep: async () => {},
    after(ms, fn) {
      const d = { at: t + ms, fn };
      due.push(d);
      return () => { const i = due.indexOf(d); if (i >= 0) due.splice(i, 1); };
    },
    advance(ms) {
      t += ms;
      for (;;) {
        const i = due.findIndex((d) => d.at <= t);
        if (i < 0) break;
        due.splice(i, 1)[0].fn();
      }
    },
    count: () => due.length,
  };
}

test("re-arming a lane leaves one timer, and only the last fires", () => {
  const clock = manualClock(), s = {}, fired = [];
  timers.arm(s, "wall", 100, () => fired.push("a"), clock);
  timers.arm(s, "wall", 200, () => fired.push("b"), clock);
  assert.equal(clock.count(), 1);
  clock.advance(150);
  assert.deepEqual(fired, []);
  clock.advance(100);
  assert.deepEqual(fired, ["b"]);
  assert.equal(timers.pending(s, "wall"), false, "a fired lane is free");
});

test("lanes are independent, per session", () => {
  const clock = manualClock(), s1 = {}, s2 = {};
  for (const l of timers.LANES) timers.arm(s1, l, 10, () => {}, clock);
  timers.arm(s2, "net", 10, () => {}, clock);
  timers.cancel(s1, "net");
  assert.equal(timers.pending(s1, "net"), false);
  assert.equal(timers.pending(s1, "wall"), true);
  assert.equal(timers.pending(s2, "net"), true);
});

test("cancelAll cancels every lane (session teardown)", () => {
  const clock = manualClock(), s = {}, fired = [];
  for (const l of timers.LANES) timers.arm(s, l, 10, () => fired.push(l), clock);
  assert.equal(clock.count(), timers.LANES.length);
  timers.cancelAll(s);
  assert.equal(clock.count(), 0);
  clock.advance(1000);
  assert.deepEqual(fired, []);
  for (const l of timers.LANES) assert.equal(timers.pending(s, l), false);
});

test("a fn that re-arms its own lane is not cancelled by the lane freeing", () => {
  const clock = manualClock(), s = {};
  let n = 0;
  const go = () => { if (++n < 3) timers.arm(s, "resume", 10, go, clock); };
  timers.arm(s, "resume", 10, go, clock);
  for (let i = 0; i < 5; i++) clock.advance(10);
  assert.equal(n, 3);
});

test("a wall continue arriving while a net retry is pending types one continue, not two", async () => {
  const clock = manualClock();
  const sessions = new Map();
  const typed = [];
  let slice;
  const core = {
    clock, sessions,
    emit() {}, loadLive: () => null, persistLive() {}, recordPrompt() {},
    setAsking() {}, setCliSuggestion() {}, setTurn() {}, armPromptCheck() {},
    netTyped: (s, data) => slice.typed(s, data),
    write: (id, data) => drive.write(core, id, data),
    input: (id, data) => drive.input(core, id, data),
  };
  slice = new NetRetrySlice(core);
  const s = {
    info: { id: "s1", title: "t", running: true, remoteControl: true, cwd: root, claudeSessionId: "c" },
    hooksActive: true, turnActive: false, lastDataAt: 0, stopCount: 0,
    proc: { write: (d) => { typed.push(d); } },
  };
  s.info.netRetry = { state: "waiting", attempt: 1, max: 8, nextAt: clock.now() + 60_000, error: "x", at: 1 };
  sessions.set("s1", s);
  // The net rung is due in 60 s and would type its own `continue` then.
  let netFired = 0;
  slice.arm(s, 60_000, () => { netFired++; });
  assert.equal(timers.pending(s, "net"), true);
  // The wall's continue lands first.
  await writeContinue({ sessionId: "s1", kind: "limit", detail: "t", stillOurs: () => true, write: (d) => core.write("s1", d), recordPrompt() {} }, { sleep: async () => {}, recordSent() {} });
  assert.equal(timers.pending(s, "net"), false, "the wall's continue called the net rung off");
  clock.advance(120_000);
  assert.equal(netFired, 0, "the net rung never fires after it");
  assert.equal(typed.filter((d) => d.includes("continue")).length, 1, "one continue typed");
});
