/**
 * The staged-build banner's snooze.
 *
 * `updateSnooze.ts` is pure, so `node --test` runs it straight over the
 * TypeScript and `npm run test:unit` discovers it:
 *
 *     node --test packages/web/src/updateSnooze.test.mjs
 *
 * The cases that matter are the two ways a hide-it button goes wrong: hiding
 * the NEXT build too, and hiding for ever.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_SNOOZE_MS, SNOOZE_CHOICES, parseSnooze, snoozeActive, snoozeFor, snoozeSentence,
} from "./updateSnooze.ts";

const NOW = 1_700_000_000_000;
const FIVE_MIN = 5 * 60 * 1000;

test("a snooze silences the build it was made for, for as long as was asked", () => {
  for (const c of SNOOZE_CHOICES) {
    const s = snoozeFor("build-a", NOW, c.ms);
    assert.equal(snoozeActive(s, "build-a", NOW), true, c.label);
    assert.equal(snoozeActive(s, "build-a", NOW + c.ms - 1), true, c.label);
    assert.equal(snoozeActive(s, "build-a", NOW + c.ms), false, c.label);
  }
});

test("five minutes is on offer and is the first thing under the thumb", () => {
  assert.equal(SNOOZE_CHOICES[0].ms, FIVE_MIN);
  // Shortest first, and every span distinct — a picker with two chips meaning
  // the same thing is a picker that has drifted.
  const spans = SNOOZE_CHOICES.map((c) => c.ms);
  assert.deepEqual(spans, spans.slice().sort((a, b) => a - b));
  assert.equal(new Set(spans).size, spans.length);
  assert.equal(new Set(SNOOZE_CHOICES.map((c) => c.label)).size, spans.length);
  assert.equal(MAX_SNOOZE_MS, Math.max(...spans));
});

test("a five-minute snooze is over in five minutes", () => {
  const s = snoozeFor("build-a", NOW, FIVE_MIN);
  assert.equal(snoozeActive(s, "build-a", NOW + 4 * 60 * 1000), true);
  assert.equal(snoozeActive(s, "build-a", NOW + 6 * 60 * 1000), false);
});

test("a newer build is a new question", () => {
  const s = snoozeFor("build-a", NOW, MAX_SNOOZE_MS);
  assert.equal(snoozeActive(s, "build-b", NOW), false);
});

test("even the longest one ends", () => {
  const s = snoozeFor("build-a", NOW, MAX_SNOOZE_MS);
  assert.equal(snoozeActive(s, "build-a", NOW + MAX_SNOOZE_MS), false);
  assert.equal(snoozeActive(s, "build-a", NOW + MAX_SNOOZE_MS + 60_000), false);
});

test("a clock that moved backwards does not silence it for ever", () => {
  const s = snoozeFor("build-a", NOW, MAX_SNOOZE_MS);
  // Phone corrects its clock / changes timezone backwards: `until` is now
  // further out than any snooze this picker can produce.
  assert.equal(snoozeActive(s, "build-a", NOW - 60 * 60 * 1000), false);
});

test("nothing staged, nothing silenced", () => {
  assert.equal(snoozeActive(snoozeFor("build-a", NOW, FIVE_MIN), null, NOW), false);
  assert.equal(snoozeActive(null, "build-a", NOW), false);
});

test("a junk key reads as not snoozed, never throws", () => {
  for (const raw of [null, "", "1", "{", "{}", '{"id":"a"}', '{"until":5}',
                     '{"id":"","until":5}', '{"id":"a","until":"soon"}',
                     '{"id":"a","until":null}', "[]", '"a"']) {
    assert.equal(parseSnooze(raw), null, `raw: ${raw}`);
  }
  assert.deepEqual(parseSnooze('{"id":"a","until":5}'), { id: "a", until: 5 });
  // Round-trips what it writes.
  const s = snoozeFor("build-a", NOW, FIVE_MIN);
  assert.deepEqual(parseSnooze(JSON.stringify(s)), s);
});

test("the sentence names the span in units a person reads", () => {
  assert.match(snoozeSentence(FIVE_MIN), /5 min/);
  assert.match(snoozeSentence(60 * 60 * 1000), /1 hours?/);
  assert.match(snoozeSentence(4 * 60 * 60 * 1000), /4 hours/);
  assert.match(snoozeSentence(24 * 60 * 60 * 1000), /1 day\b/);
  // Never a fraction of an hour for something measured in minutes.
  for (const c of SNOOZE_CHOICES) assert.doesNotMatch(snoozeSentence(c.ms), /\d\.\d/);
});
