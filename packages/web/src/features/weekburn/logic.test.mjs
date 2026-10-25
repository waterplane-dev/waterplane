import { test } from "node:test";
import assert from "node:assert/strict";
import { lastWeekHere, runningWords, sameAsLastOffered, saveVerb, savedToast, stopChoices, toggleDir } from "./logic.ts";

const status = (over = {}) => ({
  prefs: { repos: [], weekOf: null, recurring: false, lastRepos: ["/a", "/b"], stopPct: 95 },
  available: true, weeklyPct: 40, weeklyResetAt: 1, plan: null, pickedThisWeek: false, running: [],
  ...over,
});

test("same as last week: only with no pick this week and repos that still exist", () => {
  assert.equal(sameAsLastOffered(status(), ["/a", "/c"]), true);
  assert.deepEqual(lastWeekHere(status(), ["/b", "/a"]), ["/a", "/b"]);
  assert.equal(sameAsLastOffered(status({ pickedThisWeek: true }), ["/a"]), false);
  assert.equal(sameAsLastOffered(status(), ["/z"]), false);
  assert.equal(sameAsLastOffered(status({ prefs: { ...status().prefs, lastRepos: [] } }), ["/a"]), false);
});

test("save verb: empty pick is Cancel only when there is something to cancel", () => {
  assert.equal(saveVerb(2, false).kind, "save");
  assert.match(saveVerb(2, true).label, /Update/);
  assert.deepEqual(saveVerb(0, true), { kind: "cancel", label: "Cancel this week" });
  const none = saveVerb(0, false);
  assert.equal(none.kind, "none");
  assert.match(none.why, /Tick a repo/);
});

test("toggle keeps pick order; stop choices include an odd saved value once", () => {
  assert.deepEqual(toggleDir(["/a"], "/b"), ["/a", "/b"]);
  assert.deepEqual(toggleDir(["/a", "/b"], "/a"), ["/b"]);
  assert.deepEqual(stopChoices(95), [80, 90, 95, 100]);
  assert.deepEqual(stopChoices(97), [80, 90, 95, 97, 100]);
});

test("receipts and running words", () => {
  assert.match(savedToast(1), /1 repo\./);
  assert.match(savedToast(3), /3 repos/);
  assert.match(savedToast(0), /Cancelled/);
  assert.equal(runningWords({ posted: 0, live: null }), "nothing posted yet");
  assert.equal(runningWords({ posted: 2, live: "x" }), "2 posted · one running now");
  assert.equal(runningWords({ posted: 6, live: null, stoppedText: "Stopped: 6 this week." }), "6 posted · Stopped: 6 this week.");
});
