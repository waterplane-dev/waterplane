/**
 * The reader's turn stamps: "posted" under a prompt and "finished · took" at
 * the foot of a turn. A bare clock stopped saying which day once the reader was
 * scrolled back past midnight, so the stamp carries the date.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { stamp, took } from "./turnWhen.ts";

test("stamp carries the date and the time", () => {
  const ts = new Date(2026, 8, 29, 15, 8).getTime();
  const s = stamp(ts, new Date(2026, 8, 30).getTime());
  assert.match(s, /29/);
  assert.match(s, /15:08|3:08/);
  assert.doesNotMatch(s, /2026/);
});

test("stamp names the year only when it is not this one", () => {
  const ts = new Date(2025, 11, 31, 9, 0).getTime();
  assert.match(stamp(ts, new Date(2026, 0, 2).getTime()), /2025/);
});

test("stamp of nothing is nothing", () => {
  assert.equal(stamp(undefined), "");
});

test("took reads seconds, minutes, hours — and absent when it cannot know", () => {
  assert.equal(took(1000, 41_000), "40s");
  assert.equal(took(0, 23 * 60_000), "");
  assert.equal(took(1, 1 + 23 * 60_000), "23m");
  assert.equal(took(1, 1 + 65 * 60_000), "1h 5m");
  assert.equal(took(5000, 1000), "");
  assert.equal(took(1000, undefined), "");
});
