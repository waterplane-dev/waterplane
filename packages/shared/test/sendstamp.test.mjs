// `shared/src/sendstamp.ts`: when a durable send was FIRST put on the wire, and
// the rule a host that lost its ack ledger judges it by.
import test from "node:test";
import assert from "node:assert/strict";
import {
  LOST_LEDGER_MARGIN_MS, LOST_LEDGER_RAW_MARGIN_MS, LOST_LEDGER_REFUSAL,
  firstSentOnHostClock, preLossRefusal, retargetEntry, withFirstSentAt, withSentAt,
} from "../dist/index.js";

const LOST = { at: 1_000_000_000, until: 1_000_000_000 + 45 * 60_000 };
const AFTER = LOST.at + 30_000; // receipt time, host clock

test("no lost ledger, past the window, or no firstSentAt ⇒ never refused", () => {
  const old = { firstSentAt: 1, sentAt: AFTER };
  assert.equal(preLossRefusal(null, old, AFTER), null);
  assert.equal(preLossRefusal(undefined, old, AFTER), null);
  assert.equal(preLossRefusal(LOST, old, LOST.until + 1), null);
  assert.equal(preLossRefusal(LOST, undefined, AFTER), null);
  assert.equal(preLossRefusal(LOST, {}, AFTER), null);
  assert.equal(preLossRefusal(LOST, { sentAt: AFTER }, AFTER), null, "sentAt alone says nothing");
  assert.equal(preLossRefusal(LOST, { firstSentAt: Number.NaN, sentAt: AFTER }, AFTER), null);
});

test("first sent before the loss ⇒ refused in the one sentence; after it ⇒ runs", () => {
  // The phone's clock is two hours AHEAD of the desktop's: only the age counts.
  const skew = 2 * 3_600_000;
  const pre = { firstSentAt: AFTER + skew - 5 * 60_000, sentAt: AFTER + skew };
  const fresh = { firstSentAt: AFTER + skew - 1_000, sentAt: AFTER + skew };
  assert.equal(preLossRefusal(LOST, pre, AFTER), LOST_LEDGER_REFUSAL);
  assert.equal(preLossRefusal(LOST, fresh, AFTER), null);
  assert.match(LOST_LEDGER_REFUSAL, /lost its delivery record/);
  assert.match(LOST_LEDGER_REFUSAL, /may already have run/);
});

test("the margin errs closed: a first send just after the loss, inside the transit allowance, is refused", () => {
  const recv = LOST.at + LOST_LEDGER_MARGIN_MS + 10_000;
  const age = (ms) => ({ firstSentAt: 50 - ms, sentAt: 50 }); // any phone clock
  // Placed at recv - age on the host clock.
  assert.equal(preLossRefusal(LOST, age(recv - LOST.at - 1_000), recv), LOST_LEDGER_REFUSAL, "1 s after the loss");
  assert.equal(preLossRefusal(LOST, age(recv - LOST.at - LOST_LEDGER_MARGIN_MS - 1), recv), null, "past the margin");
});

test("without sentAt the raw stamp is compared across clocks, with the wide margin", () => {
  const f = firstSentOnHostClock({ firstSentAt: LOST.at + 60_000 }, AFTER);
  assert.deepEqual(f, { at: LOST.at + 60_000, margin: LOST_LEDGER_RAW_MARGIN_MS });
  assert.equal(preLossRefusal(LOST, { firstSentAt: LOST.at + 60_000 }, AFTER), LOST_LEDGER_REFUSAL);
  assert.equal(preLossRefusal(LOST, { firstSentAt: LOST.at + LOST_LEDGER_RAW_MARGIN_MS + 1 }, AFTER), null);
  // A sentAt earlier than firstSentAt is not an age: fall back to the raw rule.
  assert.equal(firstSentOnHostClock({ firstSentAt: 10, sentAt: 5 }, AFTER).margin, LOST_LEDGER_RAW_MARGIN_MS);
});

test("withFirstSentAt stamps only ackId frames and never moves an existing stamp", () => {
  const op = { t: "intent.run", id: "i1", ackId: "a1" };
  assert.deepEqual(withFirstSentAt(op, 5), { ...op, firstSentAt: 5 });
  assert.deepEqual(op, { t: "intent.run", id: "i1", ackId: "a1" }, "the stored payload is not mutated");
  const stamped = withFirstSentAt(op, 5);
  assert.equal(withFirstSentAt(stamped, 99).firstSentAt, 5, "a retry keeps the first send");
  const ping = { t: "ping" };
  assert.equal(withFirstSentAt(ping, 5), ping);
});

test("withSentAt restamps every write of a stamped frame and leaves the rest alone", () => {
  const f = { t: "session.input", id: "s", data: "x", ackId: "a", firstSentAt: 5 };
  assert.deepEqual(withSentAt(f, 7), { ...f, sentAt: 7 });
  assert.equal(withSentAt(withSentAt(f, 7), 9).sentAt, 9);
  assert.equal(withSentAt(f, 9).firstSentAt, 5);
  const hello = { t: "hello", protocol: 2 };
  assert.equal(withSentAt(hello, 7), hello);
});

test("retargetEntry drops firstTryAt with the old ackId", () => {
  const rows = [{ ackId: "old", sessionId: "s1", cwd: "/r", text: "hi", ts: 1, status: "queued", mode: "input", firstTryAt: 100, attempts: 3 }];
  const [next] = retargetEntry(rows, "old", { sessionId: "s2", cwd: "/r", ackId: "new" });
  assert.equal(next.ackId, "new");
  assert.equal(next.firstTryAt, undefined, "a fresh id must not carry the old first send");
  assert.equal(rows[0].firstTryAt, 100, "the input is untouched");
});
