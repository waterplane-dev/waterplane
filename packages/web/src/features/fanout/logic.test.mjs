import test from "node:test";
import assert from "node:assert/strict";

import { FANOUT_LANE, fanoutToast, followUpLane, followUpToast } from "./logic.ts";

test("every sweep shares one lane; each run's follow-ups have their own", () => {
  assert.equal(FANOUT_LANE, "fanout");
  assert.equal(followUpLane("r1"), "fu:r1");
});

test("the sweep receipt counts repos, or says it waits for the link", () => {
  assert.equal(fanoutToast(false, 1), "fanning out to 1 repo");
  assert.equal(fanoutToast(false, 3), "fanning out to 3 repos");
  assert.equal(fanoutToast(true, 3), "queued — the sweep runs when the link is back");
});

test("the follow-up receipt counts sessions, or says it waits for the link", () => {
  assert.equal(followUpToast(false, 1), "following up in 1 session");
  assert.equal(followUpToast(false, 2), "following up in 2 sessions");
  assert.equal(followUpToast(true, 2), "queued — the follow-up goes out when the link is back");
});
