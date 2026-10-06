/**
 * The dictation watchdog: when the microphone stops hearing, it is SAID.
 *
 *     node --test packages/web/src/dictateWatch.test.mjs
 *
 * The reported defect was silence: the screen timed out mid-dictation, the
 * capture stopped receiving audio, and the button went on saying "listening".
 */
import test from "node:test";
import assert from "node:assert/strict";
import { LAG_MS, STALL_MS, captureStall, clock, stallToast } from "./dictateWatch.ts";

const live = { now: 10_000, startedAt: 0, heardSeconds: 9.5, lastFrameAt: 9_800, track: "live", ctx: "running", visible: true };

test("audio still arriving is not a stall", () => {
  assert.equal(captureStall(live), null);
  assert.equal(captureStall({ ...live, now: live.lastFrameAt + STALL_MS - 1 }), null);
});

test("a gap past STALL_MS is a stall, named by its likeliest cause", () => {
  const late = { ...live, now: live.lastFrameAt + STALL_MS };
  assert.match(captureStall(late), /interrupted/);
  assert.match(captureStall({ ...late, visible: false }), /screen turned off/);
  assert.match(captureStall({ ...late, ctx: "suspended" }), /paused the audio/);
});

test("a hole in the middle of the clip is a stall even once audio flows again", () => {
  // Screen off for a while, back on: the context resumed and frames arrive,
  // but the clip is short of the wall clock by the time it was paused.
  assert.equal(captureStall({ ...live, heardSeconds: 10 - LAG_MS / 1000 + 0.1 }), null);
  assert.match(captureStall({ ...live, heardSeconds: 4 }), /interrupted/);
});

test("an ended track is a stall at once, before any gap", () => {
  assert.match(captureStall({ ...live, track: "ended" }), /taken away/);
});

test("the clock is m:ss and never negative", () => {
  assert.equal(clock(0), "0:00");
  assert.equal(clock(61.9), "1:01");
  assert.equal(clock(300), "5:00");
  assert.equal(clock(-3), "0:00");
});

test("the toast says when it stopped and that the heard part is kept", () => {
  const t = stallToast(102, "the app went to the background or the screen turned off");
  assert.match(t, /at 1:42/);
  assert.match(t, /being read/);
});
