/**
 * The follow-up flag (`followup.ts`): a flag that cannot say who set it is
 * dropped whole, never rounded to "you"; reason and item stay on their own kind.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FOLLOWUP_REASON_CAP, cleanFollowUp, clipFollowUpText, followUpPushText, followUpText, cleanIntentRow,
} from "../dist/index.js";

test("an unknown or missing author drops the flag, never rounds it to hand", () => {
  assert.equal(cleanFollowUp({ by: "bot", at: 5 }), null);
  assert.equal(cleanFollowUp({ at: 5 }), null);
  assert.equal(cleanFollowUp({ by: "hand" }), null);
  assert.equal(cleanFollowUp({ by: "hand", at: Number.NaN }), null);
  assert.equal(cleanFollowUp(null), null);
});

test("reason survives only on an agent flag, item only on a launch flag", () => {
  assert.deepEqual(cleanFollowUp({ by: "agent", at: 1, reason: "  tests\nstill red ", item: "x" }), { by: "agent", at: 1, reason: "tests still red" });
  assert.deepEqual(cleanFollowUp({ by: "launch", at: 1, reason: "r", item: "nightly sweep" }), { by: "launch", at: 1, item: "nightly sweep" });
  assert.deepEqual(cleanFollowUp({ by: "hand", at: 1, reason: "r", item: "i" }), { by: "hand", at: 1 });
});

test("text is clipped to one line under the cap", () => {
  const long = "a".repeat(FOLLOWUP_REASON_CAP + 40);
  const c = clipFollowUpText(long);
  assert.ok(c.length <= FOLLOWUP_REASON_CAP && c.endsWith("…"));
  assert.equal(clipFollowUpText("   "), undefined);
});

test("one sentence per author", () => {
  assert.equal(followUpText({ by: "hand", at: 1 }), "flagged by you");
  assert.equal(followUpText({ by: "agent", at: 1, reason: "migration needs your call" }), "flagged by the session: migration needs your call");
  assert.equal(followUpText({ by: "launch", at: 1, item: "fix flaky test" }), "flagged when done, as you asked (fix flaky test)");
});

test("a hand flag pushes nothing; the others name the session", () => {
  assert.equal(followUpPushText({ by: "hand", at: 1 }, "s"), null);
  assert.equal(followUpPushText({ by: "agent", at: 1, reason: "read me" }, "myapp").body, "read me");
  assert.equal(followUpPushText({ by: "launch", at: 1 }, "myapp").title, "Follow up: myapp");
});

test("an intent row keeps flagWhenDone only as true", () => {
  const base = { id: "i1", cwd: "/r", createdAt: 1, state: "waiting", trigger: { kind: "now" }, gate: "auto", target: { kind: "repo", fresh: true }, payload: { kind: "prompt", steps: ["x"] } };
  const on = cleanIntentRow({ ...base, flagWhenDone: true });
  const off = cleanIntentRow({ ...base, flagWhenDone: "yes" });
  assert.equal(on.flagWhenDone, true);
  assert.equal(off.flagWhenDone, undefined);
});
