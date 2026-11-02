/**
 * "No 5-hour window on this plan" is read off the kept history, never off one
 * reading: a null session figure is also "just reset" and "row did not parse".
 */
import test from "node:test";
import assert from "node:assert/strict";
import { sessionWindowGoneSince, SESSION_GONE_MIN_MS } from "../dist/index.js";

const T = 1_800_000_000_000;
const M = 60_000;
const gone = (t) => ({ t, s: null, w: 18, sr: null, wr: T + 86_400_000 });
const live = (t) => ({ t, s: 10, w: 18, sr: T + 3 * 3600_000, wr: T + 86_400_000 });

test("a run of week-only readings past the span is a plan with no 5-hour window", () => {
  assert.equal(sessionWindowGoneSince([live(T), gone(T + M), gone(T + 30 * M)]), T + M);
});

test("one torn reading never collapses it", () => {
  assert.equal(sessionWindowGoneSince([live(T), gone(T + M)]), null);
  assert.equal(sessionWindowGoneSince([gone(T), gone(T + SESSION_GONE_MIN_MS - 1)]), null);
});

test("a session figure in the newest reading brings the window back", () => {
  assert.equal(sessionWindowGoneSince([gone(T), gone(T + 30 * M), live(T + 40 * M)]), null);
});

test("a window that just reset still carried its reset instant: not 'gone'", () => {
  const reset = (t) => ({ t, s: null, w: 18, sr: T + 5 * 3600_000, wr: null });
  assert.equal(sessionWindowGoneSince([reset(T), reset(T + 30 * M)]), null);
});

test("no week figure either is a failed screen, never 'no 5-hour window'", () => {
  const blank = (t) => ({ t, s: null, w: null, sr: null, wr: null });
  assert.equal(sessionWindowGoneSince([blank(T), blank(T + 30 * M)]), null);
  assert.equal(sessionWindowGoneSince([]), null);
});
