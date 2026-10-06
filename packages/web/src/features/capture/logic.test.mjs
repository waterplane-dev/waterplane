/**
 * The capture feature's words — the verdict toast and the queued-run receipt
 * App carried inline.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { captureLane, captureNameIn, captureQueueTitle, captureQueuedToast, captureRunToast } from "./logic.ts";

test("a settled run carries the host's verdict verbatim, or says only that it finished", () => {
  assert.equal(captureRunToast({ status: "done", name: "home", verdict: "anchor found · 2 frames" }), "“home” — anchor found · 2 frames");
  assert.equal(captureRunToast({ status: "done", name: "home" }), "capture “home” done");
  assert.equal(captureRunToast({ status: "failed", name: "home", verdict: "blank frame" }), "“home” failed — blank frame");
  assert.equal(captureRunToast({ status: "failed", name: "home" }), "capture “home” failed");
  assert.equal(captureRunToast({ status: "running", name: "home" }), null);
});

test("a watch is named as one, in the queue and in the receipt", () => {
  assert.equal(captureQueueTitle("home", false), "capture “home”");
  assert.equal(captureQueueTitle("home", true), "watch “home”");
  assert.equal(captureQueuedToast(true, false, "home"), "queued — the capture runs when the link is back");
  assert.equal(captureQueuedToast(true, true, "home"), "queued — the watch starts when the link is back");
  assert.equal(captureQueuedToast(false, false, "home"), "capturing “home”…");
  assert.equal(captureQueuedToast(false, true, "home"), "watching “home” — a frame is kept each time the screen changes");
});

test("the lane is the repo's, and a missing target is named by its id", () => {
  assert.equal(captureLane("/r/a"), "capture:/r/a");
  const lists = new Map([["/r/a", [{ id: "t1", name: "home" }]]]);
  assert.equal(captureNameIn(lists, "/r/a", "t1"), "home");
  assert.equal(captureNameIn(lists, "/r/a", "t2"), "t2");
});
