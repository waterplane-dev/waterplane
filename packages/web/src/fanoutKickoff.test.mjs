import test from "node:test";
import assert from "node:assert/strict";

import { kickoff, kickoffSent } from "./fanoutKickoff.ts";

test("kickoff counts what the host wrote and leaves zero buckets unsaid", () => {
  const t = (status, sessionId) => ({ status, sessionId });
  const mid = kickoff([t("pending"), t("starting"), t("running", "a"), t("done", "b"), t("failed")]);
  assert.equal(mid.kicked, 3);
  assert.equal(mid.line, "Kicking off: 3 of 5 started — 1 starting · 1 waiting · 1 working · 1 finished · 1 failed");
  assert.equal(kickoff([t("running", "a"), t("done", "b")]).line, "All 2 started — 1 working · 1 finished");
  assert.equal(kickoff([t("done", "a"), t("failed")]).line, "Sweep over — 1 finished · 1 failed");
  assert.equal(kickoff([]).line, "Sweep over");
});

test("before the run exists the strip says sent or queued", () => {
  assert.equal(kickoffSent(false, 19), "Sent — waiting for the desktop to start 19 sessions");
  assert.equal(kickoffSent(true, 1), "Queued — the sweep starts 1 session when the link is back");
});
