/**
 * **Which sessions the launcher may mark as already answered, on a clock.**
 *
 * `scheduledReply.ts` is pure, so `node --test` runs it straight over the
 * TypeScript and `npm run test:unit` discovers it:
 *
 *     node --test packages/web/src/scheduledReply.test.mjs
 *
 * What is worth pinning is not the chip — it is what must NOT wear one. A mark
 * on a waiting row says *the answer is written and it goes at 07:00*, and every
 * wrong one of those is somebody not typing a reply that nobody is going to
 * send:
 *
 *  - a row that is DONE, failed, cancelled or set aside is not a reply anybody
 *    is waiting for;
 *  - a clock row aimed at the REPO opens a session of its own and never reaches
 *    the session that is waiting, so it may not mark one;
 *  - an untimed row aimed at the session (*now*, *when it's free*) is not a
 *    scheduled reply at all — it is one that has not gone yet, which the queue
 *    already says elsewhere;
 *  - and a session with two of them shows the SOONEST instant, not whichever
 *    the store happened to list first.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { anyScheduledReply, scheduledRepliesBySession } from "./scheduledReply.ts";

const NOW = 1_700_000_000_000;
const MIN = 60_000;

const row = (over = {}) => ({
  id: "i1",
  cwd: "/dev/myapp",
  payload: { kind: "prompt", steps: ["yes, carry on"] },
  target: { kind: "session", sessionId: "s1" },
  trigger: { kind: "at", rule: { kind: "once", at: NOW + 60 * MIN }, graceMin: 120 },
  state: "queued",
  createdAt: NOW - MIN,
  nextAt: NOW + 60 * MIN,
  ...over,
});

test("a clock row aimed at a session marks that session, with its ids and its instant", () => {
  const m = scheduledRepliesBySession([row()]);
  assert.deepEqual(m.get("s1"), { ids: ["i1"], nextAt: NOW + 60 * MIN });
  assert.equal(anyScheduledReply(["s1"], m), true);
  assert.equal(anyScheduledReply(["s2"], m), false);
});

test("two rows on one session: the ids are both, and the time is the SOONEST", () => {
  const m = scheduledRepliesBySession([
    row({ id: "late", nextAt: NOW + 120 * MIN }),
    row({ id: "soon", nextAt: NOW + 5 * MIN }),
  ]);
  assert.deepEqual(m.get("s1").ids, ["late", "soon"], "the tap opens both — a count is a filter");
  assert.equal(m.get("s1").nextAt, NOW + 5 * MIN);
});

test("a row the host has not armed yet says no time rather than a made-up one", () => {
  // A window rule with no usage reading resolves to `null`, which means *not
  // armed yet* and never *never*.
  const m = scheduledRepliesBySession([row({ nextAt: null })]);
  assert.deepEqual(m.get("s1"), { ids: ["i1"], nextAt: null });
});

test("nothing that will not reach that session marks it", () => {
  const none = [
    row({ id: "done", state: "done" }),
    row({ id: "failed", state: "failed" }),
    row({ id: "canceled", state: "canceled" }),
    row({ id: "archived", archived: true }),
    // Opens a session of its own: it never lands in the one that is waiting.
    row({ id: "repo", target: { kind: "repo", fresh: true } }),
    // Aimed at the session, but not on a clock — it is a send that has not gone
    // yet, which is a different sentence and a different control.
    row({ id: "idle", trigger: { kind: "idle" }, nextAt: null }),
    row({ id: "chained", trigger: { kind: "after", id: "i0" }, nextAt: null }),
  ];
  assert.equal(scheduledRepliesBySession(none).size, 0);
  // …and a row that IS waiting on a rung still counts: `blocked` is the state
  // every armed row sits in while the ladder holds it, and it is going to run.
  assert.equal(scheduledRepliesBySession([row({ state: "blocked" })]).size, 1);
  assert.equal(scheduledRepliesBySession([row({ state: "starting" })]).size, 1);
});
