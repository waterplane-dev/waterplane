/**
 * When a limit-blocked session is tried again — and when the waiting stops.
 *
 * The failure this pins is the one no screen could show and no e2e could sit
 * through: a WEEKLY wall was scheduled as *now + 5 s, then every ten minutes*,
 * capped at 24 attempts. That is under four hours of patience against a window
 * that resets DAYS later, so every weekly wall gave up the same afternoon,
 * emitted `gaveup`, and left the conversation shut — while the phone had been
 * told it would come back at the reset.
 *
 * So the properties worth asserting are arithmetic, not wording:
 *
 *  - the cap must span a WEEK, because that is what it is now bounding;
 *  - a reset somebody DATED is waited for, weekly or not (the old code threw
 *    the CLI log's instant away together with the screen's bare-time guess);
 *  - one early probe survives, because an upgraded plan and a stale banner both
 *    answer immediately and cost one attempt to find out;
 *  - and the give-up is a CLOCK, so a wall that never lifts still ends.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

const { LADDER_MS, adoptCarriedBlock, nextLimitAttempt } = await import("../dist/limitretry.js");

const NOW = 1_700_000_000_000;
const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const input = (over = {}) => ({
  attempts: 1,
  resetAt: null,
  blockedSince: NOW - 5 * MIN,
  now: NOW,
  buffer: 2 * MIN,
  maxAttempts: 64,
  giveUpMs: 8 * DAY,
  ...over,
});

test("the first attempt is a prompt probe, whatever the wall says", () => {
  // An upgraded plan serves immediately, and a banner in the scrollback of a
  // session that has sat idle for hours may describe a wall that is already
  // over. Both answer in one cheap attempt.
  const weekly = nextLimitAttempt(input({ attempts: 0, resetAt: null }));
  assert.deepEqual(weekly, { kind: "at", at: NOW + 5_000, why: "probe" });
  // …with a reset DAYS out: finding out costs one attempt and the rungs below
  // stop it becoming a loop.
  assert.equal(nextLimitAttempt(input({ attempts: 0, resetAt: NOW + 5 * DAY })).why, "probe");
  // …but NOT against a reset this desktop can simply sit out: an instant a few
  // seconds away is the answer already, and probing at a wall somebody has told
  // us the end of spends an attempt, a queue slot and the hold-off behind it.
  assert.deepEqual(nextLimitAttempt(input({ attempts: 0, resetAt: NOW + 5_000 })),
    { kind: "at", at: NOW + 5_000 + 2 * MIN, why: "reset" });
  assert.equal(nextLimitAttempt(input({ attempts: 0, resetAt: NOW + 3 * HOUR })).why, "reset");
});

test("a reset somebody DATED is landed on exactly — weekly included", () => {
  // Once the ladder's rung is longer than the wait, the instant wins: the
  // attempt is at the reset plus the buffer, not hours after it.
  const v = nextLimitAttempt(input({ attempts: 5, resetAt: NOW + 2 * HOUR }));
  assert.deepEqual(v, { kind: "at", at: NOW + 2 * HOUR + 2 * MIN, why: "reset" });
  // A reset already behind us is not an instant to wait for: the probe has been
  // spent on it, so it falls through to the backoff instead of firing in a loop.
  assert.equal(nextLimitAttempt(input({ attempts: 1, resetAt: NOW - HOUR })).why, "backoff");
});

test("…but a reset days away is still checked in on, so an early lift is noticed", () => {
  // Waiting ONLY for the instant means an upgraded plan, or a reset parsed a
  // day late, is never discovered — the session sits shut through a wall that
  // is already down. So the ladder keeps running underneath it, and the answer
  // is whichever comes first.
  const far = input({ attempts: 5, resetAt: NOW + 5 * DAY });
  assert.deepEqual(nextLimitAttempt(far), { kind: "at", at: NOW + 6 * HOUR, why: "backoff" });
  // The horizon is the slowest rung: inside it the instant is simply waited
  // for, outside it the ladder keeps checking in.
  assert.equal(nextLimitAttempt(input({ attempts: 5, resetAt: NOW + 5 * HOUR })).why, "reset");
  assert.equal(nextLimitAttempt(input({ attempts: 5, resetAt: NOW + 7 * HOUR })).why, "backoff");
  // …and no attempt is ever scheduled LATER than the reset it is waiting for.
  for (const attempts of [0, 1, 2, 3, 4, 5, 20]) {
    const v = nextLimitAttempt(input({ attempts, resetAt: NOW + 3 * HOUR }));
    assert.ok(v.at <= NOW + 3 * HOUR + 2 * MIN, `attempt ${attempts} must not overshoot the reset`);
  }
});

test("with nobody dating the reset, the delay WIDENS instead of hammering a cadence", () => {
  const delayAt = (attempts) => nextLimitAttempt(input({ attempts })).at - NOW;
  assert.deepEqual(
    [1, 2, 3, 4, 5].map(delayAt),
    [MIN, 5 * MIN, 30 * MIN, 2 * HOUR, 6 * HOUR],
  );
  // …and it caps rather than growing for ever: a wall that lifts is then missed
  // by at most one rung.
  assert.equal(delayAt(40), 6 * HOUR);
  assert.equal(LADDER_MS[LADDER_MS.length - 1], 6 * HOUR);
});

test("the attempt cap spans a WEEK — the number the old cadence got wrong", () => {
  // Walk the ladder the way the scheduler does, one attempt at a time, and add
  // up how long 64 attempts actually buy. The old flat ten-minute cadence
  // bought 4 hours, which is why a weekly wall could never be waited out.
  let span = 0;
  for (let attempts = 0; attempts < 64; attempts++) {
    const v = nextLimitAttempt(input({ attempts, now: NOW, blockedSince: NOW }));
    assert.equal(v.kind, "at", `attempt ${attempts} must still have a next try`);
    span += v.at - NOW;
  }
  assert.ok(span > 7 * DAY, `64 attempts must outlast a weekly window — got ${(span / DAY).toFixed(1)}d`);
});

test("patience is a clock: a block that outlasts the bound ends, whatever the count", () => {
  const v = nextLimitAttempt(input({ attempts: 2, blockedSince: NOW - 9 * DAY }));
  assert.equal(v.kind, "giveup");
  assert.match(v.why, /216h/, "it says how long it waited, in the unit the sentence is read in");
  // Just inside the bound is still a wait — the edge is the bound, not "about a
  // week".
  assert.equal(nextLimitAttempt(input({ attempts: 2, blockedSince: NOW - 7 * DAY })).kind, "at");
  // A block with no start recorded is not a block that started at the epoch:
  // `blockedSince` 0 must not read as eight days of patience already spent.
  assert.equal(nextLimitAttempt(input({ attempts: 2, blockedSince: 0 })).kind, "at");
});

test("the count still guards churn, and says which bound stopped it", () => {
  const v = nextLimitAttempt(input({ attempts: 64 }));
  assert.equal(v.kind, "giveup");
  assert.match(v.why, /64 attempts/);
});

test("nothing is ever scheduled before the host-wide hold-off", () => {
  // A resume that came back still blocked is evidence about the ACCOUNT, so
  // every session's next attempt is known-futile until it lifts.
  const hold = NOW + 30 * MIN;
  assert.equal(nextLimitAttempt(input({ attempts: 0, holdUntil: hold })).at, hold);
  assert.equal(nextLimitAttempt(input({ attempts: 1, resetAt: NOW + MIN, holdUntil: hold })).at, hold);
  // …and it only ever pushes an attempt later, never earlier.
  assert.equal(nextLimitAttempt(input({ attempts: 5, resetAt: null, holdUntil: hold })).at, NOW + 6 * HOUR);
});

// ── The block a reopened conversation is born into ──────────────────────────

/**
 * The rule that silently defeated every bound above it.
 *
 * `doResurrect` reopens a limit-exited conversation; it re-hits the same wall
 * seconds later and marks itself blocked — and "a block beginning" zeroed the
 * attempt count and stamped `blockedSince` now. So across a resurrection the
 * backoff restarted at its shortest rung and the patience clock restarted at
 * zero, EVERY TIME: a weekly wall reopened the conversation for days, hundreds
 * of processes deep, and neither bound was ever more than one reopen old.
 */
test("a conversation reopened into the same wall carries that block, not a new one", () => {
  const carried = { attempts: 7, blockedSince: NOW - 2 * DAY, at: NOW - 3_000 };
  assert.deepEqual(adoptCarriedBlock(carried, NOW, 5 * MIN),
    { attempts: 7, blockedSince: NOW - 2 * DAY, carried: true });
  // …and the backoff it lands on is therefore a slow rung, not the 5 s probe
  // that made the reopen loop.
  const v = nextLimitAttempt(input({ attempts: 7, blockedSince: NOW - 2 * DAY, resetAt: null }));
  assert.equal(v.at - NOW, 6 * HOUR);
});

test("a carry that is not about this wall is dropped rather than trusted", () => {
  // Came back, worked for a week, met a NEW wall: adopting the old clock would
  // give up on arrival.
  const stale = { attempts: 7, blockedSince: NOW - 8 * DAY, at: NOW - 7 * DAY };
  assert.deepEqual(adoptCarriedBlock(stale, NOW, 5 * MIN), { attempts: 0, blockedSince: NOW, carried: false });
  // Nothing carried at all is the ordinary case: a first wall, counted from now.
  assert.deepEqual(adoptCarriedBlock(undefined, NOW, 5 * MIN), { attempts: 0, blockedSince: NOW, carried: false });
  // A carry with no start recorded is not a block that began at the epoch.
  assert.deepEqual(adoptCarriedBlock({ attempts: 3, blockedSince: 0, at: NOW }, NOW, 5 * MIN),
    { attempts: 0, blockedSince: NOW, carried: false });
});

test("the probe knob moves the FIRST rung and nothing else", () => {
  // An e2e cannot sit out a five-second probe, let alone the rungs behind it —
  // but a shortened probe must not turn the backoff back into the flat cadence
  // this module replaced.
  assert.equal(nextLimitAttempt(input({ attempts: 0, probeMs: 1_200 })).at, NOW + 1_200);
  assert.equal(nextLimitAttempt(input({ attempts: 1, probeMs: 1_200 })).at, NOW + MIN);
  assert.equal(nextLimitAttempt(input({ attempts: 9, probeMs: 1_200 })).at, NOW + 6 * HOUR);
});

test("a caller's own ladder replaces the whole thing, horizon included", () => {
  const ladder = [1_200, 1_200, 1_200];
  assert.equal(nextLimitAttempt(input({ attempts: 0, ladder })).at, NOW + 1_200);
  assert.equal(nextLimitAttempt(input({ attempts: 2, ladder })).at, NOW + 1_200);
  assert.equal(nextLimitAttempt(input({ attempts: 9, ladder })).at, NOW + 1_200, "past the end it caps on the last rung");
  // The horizon is that ladder's last rung too, so "a reset we can sit out" does
  // not quietly keep production's six hours under a test's cadence.
  assert.equal(nextLimitAttempt(input({ attempts: 2, ladder, buffer: 0, resetAt: NOW + HOUR })).why, "backoff");
  assert.equal(nextLimitAttempt(input({ attempts: 2, ladder, buffer: 0, resetAt: NOW + 600 })).why, "reset");
});
