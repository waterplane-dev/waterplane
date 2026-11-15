import test from "node:test";
import assert from "node:assert/strict";
import {
  OWN_BACKFILL_COMMITS, ownBackfillDone, ownBackfillExhausted, ownBackfillLabel, ownBackfillOffered, ownBackfillResultWords, ownBackfillRunningWords,
} from "./repoHealthOwnBackfill.ts";

const series = (...vs) => ({ points: vs.map((v, i) => ({ day: `2026-01-0${i + 1}`, sha7: "a", v })) });

test("offered while any own series has fewer than two readings, and not after a run said nothing is left", () => {
  assert.equal(ownBackfillOffered({ series: [series(null, 3)] }), true, "one reading: no curve yet");
  assert.equal(ownBackfillOffered({ series: [series(2, 3), series(null, null)] }), true);
  assert.equal(ownBackfillOffered({ series: [series(2, 3)] }), false, "a curve already");
  assert.equal(ownBackfillOffered({ series: [] }), false, "nothing declared: no tiles, no button");
  assert.equal(ownBackfillOffered(undefined), false);
  assert.equal(ownBackfillOffered({ series: [series(null, 3)] }, true), false);
  assert.equal(ownBackfillLabel(), `read back ${OWN_BACKFILL_COMMITS} commits`);
});

test("the plot's unread count decides, so the button does not come back after every older day was read", () => {
  const thin = [series(null, 3)];
  assert.equal(ownBackfillOffered({ series: thin, unread: 4 }), true);
  assert.equal(ownBackfillOffered({ series: thin, unread: 0 }), false, "all read back: no button on a reload either");
  assert.equal(ownBackfillDone({ series: thin, unread: 0 }), true, "the sentence stands in its place");
  assert.equal(ownBackfillDone({ series: [series(2, 3)], unread: 0 }), false, "a curve: nothing to explain");
  assert.equal(ownBackfillDone({ series: thin }, true), true, "older engine: a run here said none left");
  assert.equal(ownBackfillDone({ series: thin }), false);
});

test("the result is one sentence; a refusal is the host's own words; counts not sent are not 0", () => {
  assert.equal(ownBackfillResultWords({ ok: false, refused: "approve them first." }), "approve them first.");
  assert.equal(ownBackfillResultWords({ ok: false, error: "killed." }), "killed.");
  assert.equal(ownBackfillResultWords({ ok: true, summary: { read: 3, values: 4, absent: 2, left: 0, stopped: null } }),
    "Read back 3 days: 4 readings, 2 absent (each tile says why).");
  assert.equal(ownBackfillResultWords({ ok: true, summary: { read: 1, values: 1, left: 5, stopped: "budget" } }),
    "Read back 1 day: 1 reading · stopped at the desktop's time budget · 5 older days still without them — tap again to go further.");
  // Nothing left: no result line; OWN_BACKFILL_DONE stands where the button was.
  assert.equal(ownBackfillResultWords({ ok: true, summary: { read: 0, left: 0 } }), null);
  assert.equal(ownBackfillResultWords({ ok: true, summary: { read: 2 } }), "Read back 2 days.", "no values count sent: none printed");
  assert.equal(ownBackfillResultWords(null), null);
});

test("exhausted only on an ok answer that says nothing is left", () => {
  assert.equal(ownBackfillExhausted({ ok: true, summary: { read: 2, left: 0 } }), true);
  assert.equal(ownBackfillExhausted({ ok: true, summary: { read: 2, left: 3 } }), false);
  assert.equal(ownBackfillExhausted({ ok: true, summary: { read: 2 } }), false, "absent left is not 0");
  assert.equal(ownBackfillExhausted({ ok: false, refused: "x" }), false);
});

test("progress quotes the desktop's line where it sent one", () => {
  assert.equal(ownBackfillRunningWords("reading back own readings: 3/20 commits", 12.4), "reading back own readings: 3/20 commits · 12s");
  assert.equal(ownBackfillRunningWords(null, 2), "reading back on the desktop… 2s");
});
