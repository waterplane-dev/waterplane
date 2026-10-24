/**
 * The send queue's pure half (`core/queue/logic.ts`).
 *
 *     node --test packages/web/src/core/queue/logic.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  ACK_TIMEOUT_MS, OP_ACK_TIMEOUT_MS, SUBMIT_ACK_TIMEOUT_MS, PENDING_PREFIX, ackWindow, goneLanesOf, isLaterId, isPendingId, laterId,
  budgetHeldLaneSet, budgetReleased, entryFrame, laneFor, laneLabelOf, markAttempt, pendingLaneId, requeue, sendingLabel, serialStates, unpark, whichWords,
} from "./logic.ts";

const row = (o = {}) => ({ ackId: "a", sessionId: "s1", cwd: "/r/myapp", text: "hello", ts: 1000, status: "queued", ...o });

test("the pending id is the create's own ackId behind one prefix", () => {
  assert.equal(pendingLaneId("abc"), `${PENDING_PREFIX}abc`);
  assert.equal(isPendingId(pendingLaneId("abc")), true);
  assert.equal(isPendingId("s1"), false);
  assert.equal(isPendingId(null), false);
  assert.equal(isPendingId(undefined), false);
});

test("a `+ later` screen is a pending id per repo, so every host guard keeps it off the wire", () => {
  const id = laterId("~/dev/myapp");
  assert.equal(isPendingId(id), true);
  assert.equal(isLaterId(id), true);
  assert.equal(laterId("~/dev/myapp"), id); // per repo, so its draft is found again
  // A create's own pending screen is never a later one.
  assert.equal(isLaterId(pendingLaneId("abc")), false);
  assert.equal(isLaterId("s1"), false);
  assert.equal(isLaterId(null), false);
});

test("a pending screen's lane is its create's, a real session's is its id", () => {
  assert.equal(laneFor("pending:abc", "/r/myapp"), "create:/r/myapp");
  assert.equal(laneFor("s1", "/r/myapp"), "s1");
  // No cwd to name the create's lane by: the id is all there is.
  assert.equal(laneFor("pending:abc", ""), "pending:abc");
});

test("a receipt window: submit is flat, ops size off the p95 ping, both widen per attempt", () => {
  assert.equal(ackWindow(row({ mode: "input" }), null), SUBMIT_ACK_TIMEOUT_MS);
  assert.equal(ackWindow(row({ mode: "input", attempts: 5 }), 99999), SUBMIT_ACK_TIMEOUT_MS);
  assert.equal(ackWindow(row({ mode: "op" }), null), OP_ACK_TIMEOUT_MS);
  assert.equal(ackWindow(row({ mode: "op", attempts: 1 }), null), OP_ACK_TIMEOUT_MS * 2);
  // A slow relay: six p95s, capped at two minutes, never under the floor.
  assert.equal(ackWindow(row({ mode: "op" }), 5000), 30000);
  assert.equal(ackWindow(row({ mode: "op" }), 100000), 120000);
  assert.equal(ackWindow(row({ mode: "op" }), 10), OP_ACK_TIMEOUT_MS);
  assert.equal(ackWindow(row({ mode: "backlog", attempts: 9 }), null), ACK_TIMEOUT_MS * 4); // flat past 4×
  assert.equal(ackWindow(row({ mode: "upload" }), null), ACK_TIMEOUT_MS);
});

test("requeue: a wasted attempt is rolled back, tries only ever grow, and a backoff is set", () => {
  const r = requeue(row({ status: "pending", attempts: 3, tries: 2 }), true, 5000);
  assert.equal(r.status, "queued");
  assert.equal(r.attempts, 2);
  assert.equal(r.tries, 3);
  assert.ok(r.retryAt > 5000);
  const kept = requeue(row({ status: "pending", attempts: 3 }), false, 5000);
  assert.equal(kept.attempts, 3);
  assert.equal(kept.tries, 1);
  assert.equal(requeue(row({ status: "pending" }), true, 0).attempts, 0); // never below zero
});

test("serialStates lifts the two nested facts laneBusy needs", () => {
  const [s] = serialStates([{ id: "s1", cwd: "/r", running: true, limit: { blocked: true }, prompt: { kind: "choice" }, awaitingInput: true }]);
  assert.equal(s.limitBlocked, true);
  assert.equal(s.promptKind, "choice");
  assert.equal(s.awaitingInput, true);
});

test("an explicit send drops the park — except a chained prompt still waiting for its create", () => {
  assert.equal(unpark({ holdUntilIdle: true }), undefined);
  assert.equal(unpark({ pendingCreate: true, holdUntilIdle: true }), true);
  assert.equal(unpark({ pendingCreate: true }), undefined);
});

test("gone lanes: only queued input rows, never a chained prompt, and an exit beats the list", () => {
  const q = [
    row({ ackId: "1", sessionId: "dead" }),
    row({ ackId: "2", sessionId: "live" }),
    row({ ackId: "3", sessionId: "exited" }),
    row({ ackId: "4", sessionId: "create:/r", pendingCreate: true }),
    row({ ackId: "5", sessionId: "fanout", mode: "op" }),
    row({ ackId: "6", sessionId: "dead2", status: "pending" }),
  ];
  assert.deepEqual(goneLanesOf(q, new Set(["live", "exited"]), new Set(["exited"])).sort(), ["dead", "exited"]);
});

test("a lane is named for what it will DO", () => {
  const sessions = [{ id: "s1", title: "myapp · fix", cwd: "/r/myapp" }];
  assert.equal(laneLabelOf(row({ mode: "op", op: { t: "schedule.run", id: "x" }, sessionId: "fanout" }), sessions), "Scheduled run, by hand");
  assert.equal(laneLabelOf(row({ mode: "op", sessionId: "fanout" }), sessions), "Fan-out");
  assert.equal(laneLabelOf(row({ mode: "op", sessionId: "fu:r1" }), sessions), "Fan-out follow-up");
  assert.equal(laneLabelOf(row({ mode: "op", sessionId: "build:/r/myapp" }), sessions), "myapp · builds");
  assert.equal(laneLabelOf(row({ mode: "op", sessionId: "create:/r/myapp" }), sessions), "myapp · new session");
  assert.equal(laneLabelOf(row({ mode: "backlog" }), sessions), "myapp · fix · backlog");
  assert.equal(laneLabelOf(row({ sessionId: "gone" }), sessions), "myapp · session gone");
});

test("sendingLabel: an elapsed clock while on the wire, a countdown while backing off", () => {
  assert.equal(sendingLabel([row({ status: "pending", sentAt: 1000 })], 4000), "Sending… 3s");
  assert.equal(sendingLabel([row({ status: "pending", sentAt: 0 }), row({ status: "pending", mode: "upload", sentAt: 0 })], 1000), "Uploading (2)… 1s");
  assert.match(sendingLabel([row({ status: "pending", sentAt: 0 })], OP_ACK_TIMEOUT_MS), /no receipt yet, will retry$/);
  assert.equal(sendingLabel([row({ retryAt: 31000, waitReason: "the desktop hasn't answered yet" })], 1000),
    "Sending… — the desktop hasn't answered yet; retrying in 30s");
  assert.equal(sendingLabel([row({ retryAt: 5 * 60_000 })], 0), "Sending… retrying in 5 min");
});

test("whichWords: the prose, squeezed and clipped; an op's prompt rather than its lane label", () => {
  assert.equal(whichWords(row({ text: "  two\n\nlines  " })), "two lines");
  assert.equal(whichWords(row({ text: "x".repeat(70) })), `${"x".repeat(64)}…`);
  assert.equal(whichWords(row({ mode: "op", text: "open myapp", op: { t: "session.create", prompt: "run the tests" } })), "run the tests");
  assert.equal(whichWords(row({ mode: "upload", text: "" })), "a file");
  assert.equal(whichWords(row({ mode: "op", text: "" })), "an action");
});

const sess = (id, state) => ({ id, budget: state ? { cfg: { unit: "usd", max: 1, interrupt: true }, verdict: { state, unit: "usd", max: 1, spent: 1 } } : undefined });

test("only an OVER verdict holds a lane — unknown and ok and none hold nothing", () => {
  const held = budgetHeldLaneSet([sess("a", "over"), sess("b", "ok"), sess("c", "unknown"), sess("d")]);
  assert.deepEqual([...held], ["a"]);
});

test("a release is a lane that WAS held and is not now; a new hold is not a release", () => {
  assert.equal(budgetReleased(new Set(["a"]), new Set()), true);
  assert.equal(budgetReleased(new Set(["a"]), new Set(["a"])), false);
  assert.equal(budgetReleased(new Set(), new Set(["a"])), false);
});

// ── The first-send stamp (`firstSentAt`, `shared/sendstamp.ts`) ──
test("a retry keeps firstSentAt: stamped on the first attempt, never moved by a requeue or a second attempt", () => {
  const first = markAttempt(row(), 5_000);
  assert.equal(first.firstTryAt, 5_000);
  assert.equal(entryFrame(first).firstSentAt, 5_000);
  const again = markAttempt(requeue(first, false, 6_000), 9_000);
  assert.equal(again.attempts, 2);
  assert.equal(again.sentAt, 9_000, "the send bar's clock moves");
  assert.equal(again.firstTryAt, 5_000, "the first send does not");
  assert.equal(entryFrame(again).firstSentAt, 5_000);
});

test("every socket mode carries firstSentAt; an upload writes no frame", () => {
  const at = (o) => entryFrame(markAttempt(row(o), 7));
  const input = at({});
  assert.equal(input.t, "session.input");
  assert.equal(input.submit, true);
  assert.equal(input.firstSentAt, 7);
  const answer = at({ answer: { fingerprint: "fp", label: "Yes", question: "q?" } });
  assert.equal(answer.expectPrompt, "fp");
  assert.equal(answer.submit, undefined);
  assert.equal(answer.firstSentAt, 7);
  const backlog = at({ mode: "backlog" });
  assert.equal(backlog.t, "backlog.add");
  assert.equal(backlog.firstSentAt, 7);
  const payload = { t: "session.create", cwd: "/r/repo", ackId: "a" };
  const op = at({ mode: "op", op: payload });
  assert.deepEqual(op, { ...payload, firstSentAt: 7 });
  assert.deepEqual(payload, { t: "session.create", cwd: "/r/repo", ackId: "a" }, "the frozen payload is not mutated");
  assert.equal(at({ mode: "upload" }), null);
  assert.equal(at({ mode: "op" }), null);
});

test("a typed answer rides the answer's own frame as promptText — one entry, one ackId, never `submit`", () => {
  const at = (o) => entryFrame(markAttempt(row(o), 7));
  const typed = at({ text: "", answer: { fingerprint: "fp", label: "“blue”", question: "colour?", text: "blue" } });
  assert.equal(typed.t, "session.input");
  assert.equal(typed.promptText, "blue");
  assert.equal(typed.promptChoice, undefined, "words alone name no option");
  assert.equal(typed.expectPrompt, "fp");
  assert.equal(typed.submit, undefined, "an answer, never the composer's delivery");
  const reason = at({ text: "", answer: { fingerprint: "fp", label: "No", question: "run it?", choice: 3, text: "use the other file" } });
  assert.equal(reason.promptChoice, 3);
  assert.equal(reason.promptText, "use the other file");
  const plain = at({ answer: { fingerprint: "fp", label: "Yes", question: "q?" } });
  assert.equal("promptText" in plain, false, "absent when nobody typed — an older host never sees the field");
});
