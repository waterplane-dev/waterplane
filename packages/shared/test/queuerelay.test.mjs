// `relayPlan` — which queued frames the background relay (APK service, PWA service worker) may
// send while the app is hidden: per lane, the leading run the page itself would send unasked.
// Plan: .claude/outbox/bg-link-send/PLAN.md (WP1). The relay never mints an ackId and never
// edits a row; its frames are `entryFrame`'s.
import test from "node:test";
import assert from "node:assert/strict";
import { RELAY_OPS, answerInsertAt, entryFrame, relayPlan, relayPlanKey, relayRefusal } from "../dist/index.js";

const row = (ackId, o = {}) => ({
  ackId, sessionId: "s1", cwd: "/r/app", text: `words ${ackId}`, ts: 1, status: "queued",
  mode: "input", attempts: 0, armed: true, ...o,
});
const facts = (o = {}) => ({
  hostId: "h1", now: 1_000_000, autoSend: true, confirmQueue: true, holdQueue: false,
  running: ["s1", "s2"], ...o,
});
const ids = (plan, lane = "s1") => (plan.lanes.find((l) => l.lane === lane)?.items ?? []).map((i) => i.ackId);

test("a lane of plain queued prompts is relayed whole, in queue order", () => {
  const plan = relayPlan([row("a"), row("b"), row("c", { sessionId: "s2" })], facts());
  assert.deepEqual(plan.lanes.map((l) => l.lane), ["s1", "s2"]);
  assert.deepEqual(ids(plan), ["a", "b"]);
  assert.equal(plan.hostId, "h1");
  assert.equal(plan.v, 1);
  assert.equal(plan.issuedAt, 1_000_000);
  assert.equal(plan.depth, 3);
});

test("the lane stops at an upload — nothing behind it overtakes the bytes", () => {
  const up = row("u", { mode: "upload", upload: { relPath: ".claude/inbox/x.jpg" }, text: "" });
  assert.deepEqual(ids(relayPlan([row("a"), up, row("b")], facts())), ["a"]);
});

test("the lane stops at a prompt naming an upload still in the queue (any lane)", () => {
  const up = row("u", { sessionId: "other", mode: "upload", upload: { relPath: ".claude/inbox/x.jpg" }, text: "" });
  const plan = relayPlan([up, row("a"), row("b", { text: "look at .claude/inbox/x.jpg" }), row("c")], facts());
  assert.deepEqual(ids(plan), ["a"]);
  assert.equal(plan.lanes.some((l) => l.lane === "other"), false);
});

for (const [name, o] of [
  ["pendingCreate", { pendingCreate: true }],
  ["holdUntilIdle", { holdUntilIdle: true }],
  ["serial", { serial: "/r/app" }],
  ["backoff (retryAt in the future)", { retryAt: 1_000_001 }],
]) {
  test(`the lane stops at ${name}`, () => {
    assert.deepEqual(ids(relayPlan([row("a"), row("b", o), row("c")], facts())), ["a"]);
  });
}

test("a retryAt already past does not stop the lane", () => {
  assert.deepEqual(ids(relayPlan([row("a", { retryAt: 999_999 })], facts())), ["a"]);
});

test("budget: an unarmed prompt stops the lane; armed rows and answers are exempt", () => {
  const ans = row("q", { armed: false, answer: { fingerprint: "fp", question: "Q", label: "Yes" }, text: "1" });
  const plan = relayPlan([row("a"), ans, row("b", { armed: false }), row("c")], facts({ budgetBlocked: true }));
  assert.deepEqual(ids(plan), ["a", "q"]);
  const held = relayPlan([row("b", { armed: false })], facts({ budgetHeldLanes: ["s1"] }));
  assert.deepEqual(held.lanes, []);
});

test("an input lane that is gone, or not on the running list, is the page's", () => {
  assert.deepEqual(relayPlan([row("a")], facts({ goneLanes: ["s1"] })).lanes, []);
  assert.deepEqual(relayPlan([row("a")], facts({ running: [] })).lanes, []);
  // A backlog row is not addressed to a session: the running list is not its business.
  const bl = row("w", { sessionId: "backlog:/r/app", mode: "backlog" });
  assert.deepEqual(ids(relayPlan([bl], facts({ running: [] })), "backlog:/r/app"), ["w"]);
});

test("ops: only RELAY_OPS travel", () => {
  const create = row("o1", { sessionId: "create:/r/app", mode: "op", op: { t: "session.create", ackId: "o1", cwd: "/r/app" } });
  const update = row("o2", { sessionId: "sys", mode: "op", op: { t: "updates.apply", ackId: "o2" } });
  const plan = relayPlan([create, update], facts());
  assert.deepEqual(ids(plan, "create:/r/app"), ["o1"]);
  assert.equal(plan.lanes.some((l) => l.lane === "sys"), false);
  assert.ok(RELAY_OPS.has("session.create"));
  assert.ok(!RELAY_OPS.has("updates.apply"));
});

test("past the attempts bound (and the minimum try) is the page's next round", () => {
  const spent = row("a", { status: "pending", attempts: 8, firstTryAt: 1 });
  assert.deepEqual(relayPlan([spent], facts({ maxAttempts: 8, minTryMs: 60_000 })).lanes, []);
  const young = row("a", { status: "pending", attempts: 8, firstTryAt: 999_000 });
  assert.deepEqual(ids(relayPlan([young], facts({ maxAttempts: 8, minTryMs: 60_000 }))), ["a"]);
});

test("failed rows are skipped and do not stop the lane; pending rows are re-sent under their ackId", () => {
  const plan = relayPlan([row("f", { status: "failed" }), row("p", { status: "pending", attempts: 1, firstTryAt: 5 }), row("b")], facts());
  assert.deepEqual(ids(plan), ["p", "b"]);
  assert.equal(plan.depth, 2);
});

test("confirmQueue on: an offline-typed row needs a release; rows behind it are still listed", () => {
  const plan = relayPlan([row("a", { offline: true, armed: false }), row("b")], facts());
  const items = plan.lanes[0].items;
  assert.deepEqual(items.map((i) => [i.ackId, i.needsRelease ?? false]), [["a", true], ["b", false]]);
  // With the question off, the same row goes as the page would send it.
  const off = relayPlan([row("a", { offline: true, armed: false })], facts({ confirmQueue: false }));
  assert.equal(off.lanes[0].items[0].needsRelease, undefined);
});

test("the page's own Hold stops every unarmed row", () => {
  const plan = relayPlan([row("a", { armed: false }), row("b")], facts({ holdQueue: true }));
  assert.deepEqual(plan.lanes, []);
});

test("autoSend off: nothing but armed rows (and retries)", () => {
  const plan = relayPlan([
    row("a"), row("b", { sessionId: "s2", armed: false, offline: true }),
  ], facts({ autoSend: false }));
  assert.deepEqual(ids(plan), ["a"]);
  assert.equal(plan.lanes.some((l) => l.lane === "s2"), false);
  const retry = relayPlan([row("r", { armed: false, attempts: 1, status: "pending", firstTryAt: 5 })], facts({ autoSend: false }));
  assert.deepEqual(ids(retry), ["r"]);
});

test("an answer jumps its lane (answerInsertAt) and is relayed first", () => {
  const queue = [row("a"), row("b")];
  const ans = row("q", { answer: { fingerprint: "fp", question: "Q", label: "Yes" }, text: "1" });
  queue.splice(answerInsertAt(queue, "s1"), 0, ans);
  const plan = relayPlan(queue, facts());
  assert.deepEqual(ids(plan), ["q", "a", "b"]);
  assert.equal(plan.lanes[0].items[0].frame.expectPrompt, "fp");
});

test("the frame is entryFrame's, with no firstSentAt when never attempted", () => {
  for (const r of [
    row("a"),
    row("w", { sessionId: "backlog:/r/app", mode: "backlog", label: "L" }),
    row("q", { answer: { fingerprint: "fp", question: "Q", label: "Yes" }, text: "1" }),
    row("o", { sessionId: "create:/r/app", mode: "op", op: { t: "session.create", ackId: "o", cwd: "/r/app" } }),
  ]) {
    const item = relayPlan([r], facts()).lanes[0].items[0];
    assert.equal("firstSentAt" in item.frame, false, r.ackId);
    const { firstSentAt: _f, ...want } = entryFrame(r);
    assert.deepEqual(item.frame, want, r.ackId);
  }
  // Attempted before: the stamp is the first attempt's, exactly as entryFrame writes it.
  const p = row("p", { status: "pending", attempts: 2, firstTryAt: 42 });
  const item = relayPlan([p], facts()).lanes[0].items[0];
  assert.deepEqual(item.frame, entryFrame(p));
  assert.equal(item.frame.firstSentAt, 42);
});

test("relayPlanKey ignores issuedAt and changes with the content", () => {
  const a = relayPlan([row("a")], facts());
  const b = relayPlan([row("a")], facts({ now: 2_000_000 }));
  assert.equal(relayPlanKey(a), relayPlanKey(b));
  assert.notEqual(relayPlanKey(a), relayPlanKey(relayPlan([row("a"), row("b")], facts())));
});

test("relayRefusal: the one accept rule both ends ask", () => {
  assert.equal(relayRefusal({ t: "session.input", id: "s", data: "x", ackId: "a", submit: true }), null);
  assert.equal(relayRefusal({ t: "session.input", id: "s", data: "1", ackId: "a", expectPrompt: "fp" }), null);
  assert.equal(relayRefusal({ t: "backlog.add", text: "x", repoDir: "/r", ackId: "a" }), null);
  assert.equal(relayRefusal({ t: "intent.post", ackId: "a" }), null);
  assert.match(relayRefusal({ t: "session.input", id: "s", data: "\x1b", ackId: "a" }), /raw keys/);
  assert.match(relayRefusal({ t: "session.input", id: "s", data: "x", submit: true }), /without an ackId/);
  assert.match(relayRefusal({ t: "updates.apply", ackId: "a" }), /not something/);
  assert.equal(relayRefusal(null), "not a frame");
  assert.equal(relayRefusal([]), "not a frame");
});
