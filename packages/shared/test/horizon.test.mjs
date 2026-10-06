/**
 * "How much is coming, and how soon" — the badge on the launcher.
 *
 * Every rule here is one somebody reads at a glance and acts on, and the
 * failure modes are all quiet: a count that means two different things to two
 * readers, a "later" bucket hiding something that is already due, a badge
 * saying nothing when everything is stuck.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { HORIZON_LABEL, horizonBucket, horizonLead, horizonWords, isStandingSchedule, scheduleHorizon } from "../dist/schedule.js";

const NOW = 1_700_000_000_000;
const H = 3_600_000;
const at = (hours) => ({ nextAt: NOW + hours * H });

test("buckets are DISJOINT — a row is counted once, in its nearest bucket", () => {
  const h = scheduleHorizon([at(0.5), at(5), at(30), at(100), at(400)], NOW);
  assert.deepEqual(
    { soon: h.soon, day: h.day, twoDay: h.twoDay, week: h.week, later: h.later },
    { soon: 1, day: 1, twoDay: 1, week: 1, later: 1 },
  );
  assert.equal(h.total, 5);
});

test("an instant already BEHIND us is due now, not 'later'", () => {
  // A missed occurrence inside its grace is the most urgent row in the list.
  // Bucketing by raw distance would file it beyond a week, on the wrong side
  // of zero — the one arithmetic slip that turns the most urgent thing into
  // the least visible.
  const h = scheduleHorizon([{ nextAt: NOW - 10 * H }], NOW);
  assert.equal(h.soon, 1);
  assert.equal(h.later, 0);
});

test("nothing armed is its own count, never folded into 'later'", () => {
  const h = scheduleHorizon([{ nextAt: null }, { nextAt: undefined }, at(3)], NOW);
  // "Not coming at all" and "coming in a fortnight" are opposite situations,
  // and the first is the one a person can do something about.
  assert.equal(h.unarmed, 2);
  assert.equal(h.later, 0);
  assert.equal(h.total, 3);
});

test("the sentence names the two nearest buckets and marks them disjoint", () => {
  const h = scheduleHorizon([at(3), at(5), at(30), at(31), at(32), at(33), at(34)], NOW);
  const said = horizonWords(h);
  assert.equal(said, "2 in 24h · 5 more in 2d");
  // `more` is what stops one reader totalling this as 5 and the next as 7.
  assert.match(said, /more/);
});

test("one bucket says one thing — no dangling separator", () => {
  assert.equal(horizonWords(scheduleHorizon([at(2), at(4)], NOW)), "2 in 24h");
});

test("the third bucket is dropped — it never changes a decision at a glance", () => {
  const h = scheduleHorizon([at(0.5), at(3), at(30), at(100)], NOW);
  assert.equal(horizonWords(h), "1 within the hour · 1 more in 24h");
});

test("nothing armed at all still gets a word — silence would read as 'nothing scheduled'", () => {
  const h = scheduleHorizon([{ nextAt: null }, { nextAt: null }], NOW);
  // The truth is "everything scheduled is stuck", which is the opposite of
  // "there is nothing scheduled" and is the state worth surfacing.
  assert.equal(horizonWords(h), "2 not armed");
});

test("an empty list says NOTHING — a '0 scheduled' badge trains people to ignore badges", () => {
  assert.equal(horizonWords(scheduleHorizon([], NOW)), null);
});

test("armed rows outrank unarmed ones in the sentence", () => {
  const h = scheduleHorizon([{ nextAt: null }, at(2)], NOW);
  assert.equal(horizonWords(h), "1 in 24h");
  assert.equal(h.unarmed, 1); // still counted, just not the headline
});

test("the boundaries are inclusive on the near side, so nothing falls between buckets", () => {
  assert.equal(scheduleHorizon([at(1)], NOW).soon, 1);
  assert.equal(scheduleHorizon([at(24)], NOW).day, 1);
  assert.equal(scheduleHorizon([at(48)], NOW).twoDay, 1);
  assert.equal(scheduleHorizon([at(24 * 7)], NOW).week, 1);
});

/**
 * The chip is a FILTER, so the number on it and the list it opens must be the
 * same arithmetic. These pin the two halves together: the bucket the chip
 * leads with, the rows that belong to it, and the words used for both.
 */
test("the lead bucket is the one the chip's first number counts", () => {
  assert.equal(horizonLead(scheduleHorizon([at(0.5), at(5), at(30)], NOW)), "soon");
  assert.equal(horizonLead(scheduleHorizon([at(5), at(30)], NOW)), "day");
  // Nothing armed: the only bucket left is the one worth acting on.
  assert.equal(horizonLead(scheduleHorizon([{ nextAt: null }], NOW)), "unarmed");
  // Says nothing ⇒ filters to nothing: a tap can never open an empty list.
  assert.equal(horizonLead(scheduleHorizon([], NOW)), null);
  assert.equal(horizonWords(scheduleHorizon([], NOW)), null);
});

test("the lead bucket's count is exactly the rows horizonBucket puts in it", () => {
  const rows = [at(-2), at(0.5), at(5), at(30), at(100), at(400), { nextAt: null }];
  const h = scheduleHorizon(rows, NOW);
  const lead = horizonLead(h);
  const kept = rows.filter((r) => horizonBucket(r.nextAt, NOW) === lead);
  // "2 within the hour" that opens a list of three is the bug this pins.
  assert.equal(kept.length, h[lead]);
  assert.equal(h.soon, 2); // the overdue one and the half-hour one
});

test("the chip and the filtered list use ONE spelling of each bucket", () => {
  const h = scheduleHorizon([at(0.5), at(5)], NOW);
  assert.equal(horizonWords(h), `1 ${HORIZON_LABEL.soon} · 1 more ${HORIZON_LABEL.day}`);
  assert.equal(horizonWords(scheduleHorizon([{ nextAt: null }], NOW)), `1 ${HORIZON_LABEL.unarmed}`);
});


/**
 * A one-off that has been and gone is HISTORY, not a schedule.
 *
 * It cannot be armed — `nextFireAt` answers null for ever — so counting it as
 * "not armed" described a state with no way out, and counting it into `total`
 * put "10 armed rules" on a launcher whose desktop was holding none. The same
 * function cuts the sheet's list, so the badge and the list cannot disagree.
 */
const spent = { nextAt: null, rule: { kind: "once", at: NOW - 5 * H } };
const offOnce = { nextAt: null, rule: { kind: "once", at: NOW + 5 * H } };

test("a spent one-off is not counted at all — not even as 'not armed'", () => {
  const h = scheduleHorizon([spent, spent, at(3)], NOW);
  assert.equal(h.unarmed, 0);
  assert.equal(h.total, 1);
  assert.equal(horizonWords(h), "1 in 24h");
  // Ten of them and nothing else says NOTHING, rather than "10 not armed".
  assert.equal(horizonWords(scheduleHorizon([spent, spent], NOW)), null);
  assert.equal(horizonLead(scheduleHorizon([spent], NOW)), null);
});

test("a one-off in the FUTURE with nothing armed is switched off, and still counts", () => {
  // The switch really can undo this one, which is the whole reason `unarmed`
  // exists: it is the bucket a person can act on.
  const h = scheduleHorizon([offOnce], NOW);
  assert.equal(h.unarmed, 1);
  assert.equal(h.total, 1);
  assert.equal(isStandingSchedule(offOnce, NOW), true);
  assert.equal(isStandingSchedule(spent, NOW), false);
});

test("a row carrying no rule is never assumed to be over", () => {
  // The absence of a rule is not evidence: callers that pass only an instant
  // (the older shape) must keep counting exactly as they did.
  assert.equal(isStandingSchedule({ nextAt: null }, NOW), true);
  assert.equal(scheduleHorizon([{ nextAt: null }, at(2)], NOW).total, 2);
});

/**
 * A `weekly`/`window` rule marked `oneShot` is over the same way a `once` is —
 * but `nextFireAt` cannot tell it apart (it always finds a future weekly slot,
 * and a `window` rule has no clock to be behind at all). `lastOccurrence` is
 * the only honest signal, and it must not be read as "unfired" before then.
 */
test("an unfired one-shot WINDOW rule is standing — armed or waiting to be, never spent", () => {
  const armed = { nextAt: NOW + 3 * H, rule: { kind: "window", window: "session", edge: "before", offsetMin: -60, oneShot: true } };
  const unread = { nextAt: null, rule: { kind: "window", window: "session", edge: "before", offsetMin: -60, oneShot: true } };
  assert.equal(isStandingSchedule(armed, NOW), true);
  assert.equal(isStandingSchedule(unread, NOW), true);
});

test("a FIRED one-shot window rule is spent — nextAt cleared, lastOccurrence set", () => {
  const fired = {
    nextAt: null, lastOccurrence: NOW - H,
    rule: { kind: "window", window: "session", edge: "before", offsetMin: -60, oneShot: true },
  };
  assert.equal(isStandingSchedule(fired, NOW), false);
});

test("a RECURRING window rule with nothing armed is never spent, fired or not", () => {
  const neverFired = { nextAt: null, rule: { kind: "window", window: "session", edge: "after" } };
  const firedOnceAndPaused = { nextAt: null, lastOccurrence: NOW - H, rule: { kind: "window", window: "session", edge: "after" } };
  assert.equal(isStandingSchedule(neverFired, NOW), true);
  assert.equal(isStandingSchedule(firedOnceAndPaused, NOW), true);
});

test("a fired one-shot WEEKLY rule is spent, even though nextFireAt always finds a future slot", () => {
  // The trap this pins: `nextFireAt` ignores `oneShot` entirely (it is a
  // recurrence question, not an anchor one), so a naive spent-check calling it
  // on a `weekly` rule would find next week's slot and call the row standing
  // for ever.
  const rule = { kind: "weekly", days: [4], hour: 18, minute: 0, tz: "UTC", oneShot: true };
  const fired = { nextAt: null, lastOccurrence: NOW - H, rule };
  const unfired = { nextAt: NOW + 3 * H, rule };
  assert.equal(isStandingSchedule(fired, NOW), false);
  assert.equal(isStandingSchedule(unfired, NOW), true);
});
