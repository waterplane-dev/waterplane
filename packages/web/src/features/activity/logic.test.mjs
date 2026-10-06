/**
 * The activity feature's pure half — the lane and the receipts App carried
 * inline in `handleActivityAction`/`handleActivityBulk`.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { BL_OFFLINE, HELD_OFFLINE, refireSummary, runLane, runNowToast } from "./logic.ts";

test("run it now takes the lane its kind already had", () => {
  const i = { id: "i1", cwd: "/r/a" };
  assert.equal(runLane("build", i), "build:/r/a");
  assert.equal(runLane("capture", i), "capture:/r/a");
  assert.equal(runLane("schedule", i), "fanout");
  assert.equal(runLane("work", i), "intent:i1");
  assert.equal(runLane("launch", i), "intent:i1");
});

test("the receipt says queued offline, and what starts online", () => {
  assert.equal(runNowToast("build", true), "queued — it runs when the link is back");
  assert.equal(runNowToast("launch", false), "opening it now, without the files it was waiting for");
  assert.equal(runNowToast("build", false), "starting the build…");
  assert.equal(runNowToast("capture", false), "taking the capture…");
  assert.equal(runNowToast("work", false), "firing it into the session…");
});

test("a bulk re-send is one sentence with the misses in it", () => {
  assert.equal(refireSummary(1, 1, false), "1 message back as backlog items · their rows are filed under “dismissed”");
  assert.equal(refireSummary(5, 7, true),
    "5 messages back as backlog items — added when the link is back · 2 could not go · their rows are filed under “dismissed”");
});

test("the offline refusals keep App's words", () => {
  assert.match(BL_OFFLINE, /^no connection — the backlog lives on the desktop/);
  assert.match(HELD_OFFLINE, /^no connection — the desktop is holding this one/);
});
