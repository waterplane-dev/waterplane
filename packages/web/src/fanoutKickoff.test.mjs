import test from "node:test";
import assert from "node:assert/strict";

import { kickoff, kickoffSent, targetSubline } from "./fanoutKickoff.ts";

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

test("a target's second line follows its status, not only its session id", () => {
  assert.equal(targetSubline({ status: "done", sessionId: "s1" }), "tap to open the session");
  // a finished target whose session closed has no id — it is not "starting"
  assert.equal(targetSubline({ status: "done" }), "its session has closed");
  assert.equal(targetSubline({ status: "failed", error: "no session" }), "no session");
  assert.equal(targetSubline({ status: "pending" }), "waiting to start");
  assert.equal(targetSubline({ status: "starting" }), "starting…");
});

// design review 2026-10-30 W2: the strip before the run is listed reads the
// fire's FATE (core/queue/fireFate.ts), never "the first run id not known".
import { readFileSync } from "node:fs";
import { fanoutFireLine, fanoutMine } from "./fanoutKickoff.ts";

test("a fan-out whose queue row failed or was dismissed stops spinning and says it was not sent", () => {
  assert.deepEqual(fanoutFireLine({ kind: "pending" }, false, 3), { spin: true, line: kickoffSent(false, 3) });
  assert.deepEqual(fanoutFireLine({ kind: "pending" }, true, 1), { spin: true, line: kickoffSent(true, 1) });
  const failed = fanoutFireLine({ kind: "dropped", reason: "queue full" }, false, 3);
  assert.equal(failed.spin, false);
  assert.equal(failed.line, "The sweep was not sent — queue full. Run it again when you want it.");
  const gone = fanoutFireLine({ kind: "dropped" }, false, 3);
  assert.equal(gone.spin, false);
  assert.match(gone.line, /not sent — its queue row is gone/);
  const refused = fanoutFireLine({ kind: "refused", reason: "no known repos selected" }, false, 3);
  assert.equal(refused.spin, false);
  assert.match(refused.line, /refused the sweep — no known repos selected/);
  // acked, its run not listed yet: still waiting on the desktop's list
  assert.deepEqual(fanoutFireLine({ kind: "acked", runId: "r1" }, false, 2), { spin: true, line: kickoffSent(false, 2) });
  // acked naming no run (an older host): no spinner for ever, no guess either
  assert.equal(fanoutFireLine({ kind: "acked" }, false, 2).spin, false);
  // the Runs list sits ABOVE the strip: the words must not say "below"
  assert.doesNotMatch(fanoutFireLine({ kind: "acked" }, false, 2).line, /below/);
  assert.match(fanoutFireLine({ kind: "acked" }, false, 2).line, /Runs list above/);
});

test("a run another device started is never taken as this tap's", () => {
  const runs = [{ id: "foreign" }, { id: "older" }];
  assert.equal(fanoutMine(runs, { kind: "pending" }), undefined);
  assert.equal(fanoutMine(runs, { kind: "dropped" }), undefined);
  assert.equal(fanoutMine([{ id: "mine" }, ...runs], { kind: "acked", runId: "mine" })?.id, "mine");
  assert.equal(fanoutMine(runs, { kind: "acked", runId: "mine" }), undefined);   // named but not listed yet
});

test("the fan-out sheet and its action use the tracked fire, not a Set of known run ids", () => {
  const sheet = readFileSync(new URL("./FanoutSheet.tsx", import.meta.url), "utf8");
  assert.match(sheet, /useFireFate\(/);
  assert.doesNotMatch(sheet, /\bknown\b/);
  const act = readFileSync(new URL("./features/fanout/actions.ts", import.meta.url), "utf8");
  assert.match(act, /track: true/);
  assert.match(act, /return ackId/);
});
