/**
 * A weekly wall read off the SCREEN names only a bare clock time, no date.
 *
 * Owner decision (2026-10-31): that time is the EARLIEST the window can lift, so
 * it is kept — resolved by the detector to its next occurrence — rather than
 * dropped. Because the real day is unknown it is a LOWER BOUND: an attempt there
 * that finds the wall still standing re-arms at the same time the next day
 * (`limitretry.ts`'s `daily`), never in a loop. An instant the CLI's own log
 * recorded (`dated`) still wins over it for the rest of the block.
 *
 * Pinned twice: the pure cadence, and `WallSlice.markLimitBlocked` driven on a
 * fake core (no PTY, no banner text — the instants are passed in directly).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const { nextLimitAttempt, LADDER_MS } = await import("../dist/limitretry.js");
const { WallSlice } = await import("../dist/sessions/wall.js");
const { LIMIT_RESET_BUFFER_MS } = await import("../dist/sessions/knobs.js");

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NOW = 1_700_000_000_000;

const input = (over = {}) => ({
  attempts: 1, resetAt: null, blockedSince: NOW - 5 * MIN, now: NOW,
  buffer: 2 * MIN, maxAttempts: 64, giveUpMs: 8 * DAY, daily: true, ...over,
});

test("daily: the next occurrence is waited for — no ladder underneath it", () => {
  // 20 h out is far past the 6 h horizon: without `daily` the ladder would run
  // under the wait (a check-in a minute later); with it, the attempt sits it out.
  const r = nextLimitAttempt(input({ attempts: 1, resetAt: NOW + 20 * HOUR }));
  assert.deepEqual(r, { kind: "at", at: NOW + 20 * HOUR + 2 * MIN, why: "reset" });
  assert.equal(nextLimitAttempt(input({ attempts: 1, resetAt: NOW + 20 * HOUR, daily: false })).why, "backoff");
});

test("daily: attempt 0 keeps its one probe when the reset is beyond the horizon", () => {
  assert.deepEqual(nextLimitAttempt(input({ attempts: 0, resetAt: NOW + 20 * HOUR })),
    { kind: "at", at: NOW + LADDER_MS[0], why: "probe" });
  // …and no probe when the reset is near: the reset IS the answer.
  assert.equal(nextLimitAttempt(input({ attempts: 0, resetAt: NOW + HOUR })).why, "reset");
});

test("daily: a reset already past rolls forward a whole day, never fires at once", () => {
  // The attempt fired at 7pm + buffer and came back blocked a few seconds later.
  const reset = NOW - 2 * MIN - 10_000;
  const r = nextLimitAttempt(input({ attempts: 3, resetAt: reset }));
  assert.equal(r.why, "reset");
  assert.equal(r.at, reset + 2 * MIN + DAY);
  assert.ok(r.at - NOW >= 23 * HOUR, "re-armed about a day later, not now");
  // Several days stale still lands on the NEXT occurrence, within one day.
  const old = nextLimitAttempt(input({ attempts: 3, resetAt: NOW - 3 * DAY + HOUR }));
  assert.ok(old.at > NOW && old.at - NOW <= DAY);
});

test("daily: the patience clock, the attempts cap and the hold-off still bound it", () => {
  assert.equal(nextLimitAttempt(input({ resetAt: NOW + HOUR, blockedSince: NOW - 9 * DAY })).kind, "giveup");
  assert.equal(nextLimitAttempt(input({ resetAt: NOW + HOUR, attempts: 64 })).kind, "giveup");
  assert.equal(nextLimitAttempt(input({ resetAt: NOW + HOUR, holdUntil: NOW + 3 * HOUR })).at, NOW + 3 * HOUR);
});

// ── WallSlice on a fake core ────────────────────────────────────────────────

function rig() {
  const state = { resuming: false, released: [] };
  const core = {
    root: mkdtempSync(join(tmpdir(), "wp-weeklybare-")),
    sessions: new Map(),
    noteFor() {}, setResumeProven() {}, emit() {}, publishQueue() {}, pumpResume() {},
    isResuming: () => state.resuming,
    resumeQueue: () => [],
    resumeHoldUntil: () => 0,
    releaseResume: (id, why) => { state.released.push(why); state.resuming = false; },
    dropResumeFirst() {},
  };
  const wall = new WallSlice(core);
  const s = {
    info: { id: "s1", title: "t", running: true, limit: wall.newLimitState() },
    limitTimer: null, gaveUp: {},
  };
  core.sessions.set("s1", s);
  const done = () => { wall.clearLimitTimer(s); rmSync(core.root, { recursive: true, force: true }); };
  return { wall, s, state, done };
}

test("an undated weekly bare time is KEPT as resetAt (its next occurrence)", () => {
  const { wall, s, done } = rig();
  try {
    const at = Date.now() + 3 * HOUR;   // what the detector resolved "<bare time>" to
    wall.markLimitBlocked(s, at, true, undefined, false);
    assert.equal(s.info.limit.blocked, true);
    assert.equal(s.info.limit.resetAt, at);
    assert.equal(s.limitResetKind, "daily");
    assert.equal(s.info.limit.nextAttemptAt, at + LIMIT_RESET_BUFFER_MS);
  } finally { done(); }
});

test("a log-dated instant wins over a later bare time for the rest of the block", () => {
  const { wall, s, done } = rig();
  try {
    const dated = Date.now() + 2 * DAY;
    wall.markLimitBlocked(s, dated, true, undefined, true);
    assert.equal(s.limitResetKind, "dated");
    // The log goes quiet; the screen's bare time resolves to tonight.
    wall.markLimitBlocked(s, Date.now() + 3 * HOUR, true, undefined, false);
    assert.equal(s.info.limit.resetAt, dated);
    assert.equal(s.limitResetKind, "dated");
    // …and the other order: a dated instant arriving later replaces the bare one.
    const b = rig();
    try {
      b.wall.markLimitBlocked(b.s, Date.now() + 3 * HOUR, true, undefined, false);
      b.wall.markLimitBlocked(b.s, dated, true, undefined, true);
      assert.equal(b.s.info.limit.resetAt, dated);
      assert.equal(b.s.limitResetKind, "dated");
    } finally { b.done(); }
  } finally { done(); }
});

test("still blocked after the attempt at the bare time ⇒ re-armed about a day later", () => {
  const { wall, s, state, done } = rig();
  try {
    // The block began earlier; its bare time has just passed and the attempt
    // at it (one `continue`) has been typed.
    const reset = Date.now() - LIMIT_RESET_BUFFER_MS - 5_000;
    wall.markLimitBlocked(s, reset, true, undefined, false);
    wall.clearLimitTimer(s);
    s.info.limit.attempts = 1;
    state.resuming = true;
    // The notice comes back below our echo: the same bare time, same instant.
    wall.markLimitBlocked(s, reset, true, undefined, false);
    assert.deepEqual(state.released, ["blocked"]);
    const wait = s.info.limit.nextAttemptAt - Date.now();
    assert.ok(wait >= 23 * HOUR, `re-armed ${Math.round(wait / MIN)} min out — must be about a day, not now`);
    assert.ok(wait <= DAY);
    assert.ok(s.limitTimer, "a timer is armed, not a give-up");
  } finally { done(); }
});
