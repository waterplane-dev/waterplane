/**
 * The orphan reconcile: pure, run on every queue write. node --test packages/web/src/core/queue/orphans.test.mjs
 * Shaped after a2e0fbf0 / 0a0c641f / a5df41bb (words under a create that never materialised are kept, never lost).
 */
import "../../../../../scripts/lib-tsload.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { bindPendingSession } from "@waterplane/shared";
import { ORPHAN_REASON, reconcileOrphans } from "./orphans.ts";

const create = (ackId, cwd = "/r") => ({ ackId, mode: "op", op: { t: "session.create" }, sessionId: `create:${cwd}`, cwd, status: "queued", text: "", ts: 1 });
const chain = (ackId, createAck, extra = {}) => ({ ackId, mode: "input", sessionId: "create:/r", cwd: "/r", status: "queued", text: `words ${ackId}`, pendingCreate: true, createAck, ts: 2, ...extra });
const NONE = new Set();

const cases = [
  { name: "create still queued: kept", rows: [create("c1"), chain("p1", "c1")], live: NONE, held: NONE, orphan: [] },
  { name: "create failed but present: kept (its own failure path fails the chain)", rows: [{ ...create("c1"), status: "failed" }, chain("p1", "c1")], live: NONE, held: NONE, orphan: [] },
  { name: "create gone (never materialised): orphaned", rows: [chain("p1", "c1")], live: NONE, held: NONE, orphan: ["p1"] },
  { name: "another create in the lane does not adopt it", rows: [create("c2"), chain("p1", "c1")], live: NONE, held: NONE, orphan: ["p1"] },
  { name: "create held as a launch on the desktop: kept", rows: [chain("p1", "c1")], live: NONE, held: new Set(["c1"]), orphan: [] },
  { name: "materialised: lane is a live session, kept", rows: [chain("p1", "c1", { sessionId: "s9" })], live: new Set(["s9"]), held: NONE, orphan: [] },
  { name: "old row with no createAck: lane's create present", rows: [create("c1"), chain("p1", undefined)], live: NONE, held: NONE, orphan: [] },
  { name: "old row with no createAck: lane's create gone", rows: [chain("p1", undefined)], live: NONE, held: NONE, orphan: ["p1"] },
  { name: "target closed: an ordinary row for a closed session is not this sweep's", rows: [{ ...chain("p1", undefined), pendingCreate: undefined, sessionId: "s-closed" }], live: NONE, held: NONE, orphan: [] },
];

for (const c of cases) {
  test(c.name, () => {
    const before = JSON.stringify(c.rows);
    const { keep, orphaned } = reconcileOrphans(c.rows, c.live, c.held, 99);
    assert.equal(JSON.stringify(c.rows), before, "pure: input untouched");
    assert.deepEqual(orphaned.map((e) => e.ackId), c.orphan);
    assert.equal(keep.length, c.rows.length, "never deletes a row");
    for (const o of orphaned) {
      const k = keep.find((e) => e.ackId === o.ackId);
      assert.equal(k.status, "failed");
      assert.equal(k.reason, ORPHAN_REASON);
      assert.equal(k.failedAt, 99);
      assert.equal(k.pendingCreate, undefined);
      assert.equal(k.text, c.rows.find((e) => e.ackId === o.ackId).text, "typed words kept");
    }
  });
}

test("a create evicted AFTER mount orphans its chain on the next write, not the next reload", () => {
  const first = reconcileOrphans([create("c1"), chain("p1", "c1")], NONE, NONE);
  assert.equal(first.orphaned.length, 0);
  const afterEvict = reconcileOrphans(first.keep.filter((e) => e.ackId !== "c1"), NONE, NONE);
  assert.deepEqual(afterEvict.orphaned.map((e) => e.ackId), ["p1"]);
});

test("a chained row already failed elsewhere (pendingCreate kept) keeps its own reason, never re-failed", () => {
  const row = chain("p1", "c1", { status: "failed", reason: "the session never opened - refused", failedAt: 5 });
  const r = reconcileOrphans([row], NONE, NONE, 99);
  assert.equal(r.orphaned.length, 0);
  assert.equal(r.keep[0].reason, "the session never opened - refused");
  assert.equal(r.keep[0].failedAt, 5);
});

test("idempotent: a failed orphan is not orphaned again", () => {
  const once = reconcileOrphans([chain("p1", "c1")], NONE, NONE);
  const twice = reconcileOrphans(once.keep, NONE, NONE);
  assert.equal(twice.orphaned.length, 0);
  assert.equal(twice.keep, once.keep);
});

test("op.ack with a sessionId: retire + bind in one write leaves the chain bound, never orphaned (wire.ts onOpAck)", () => {
  const rows = [create("c1"), chain("p1", "c1")];
  const retired = rows.filter((e) => e.ackId !== "c1");
  // the order the finding caught: reconcile on the retire alone fails the chain
  assert.deepEqual(reconcileOrphans(retired, new Set(["s-new"]), NONE).orphaned.map((e) => e.ackId), ["p1"]);
  // the order onOpAck now writes: bind first, one write
  const bound = bindPendingSession(retired, "create:/r", "s-new", 5, "c1");
  const { keep, orphaned } = reconcileOrphans(bound, new Set(["s-new"]), NONE);
  assert.equal(orphaned.length, 0);
  assert.equal(keep.find((e) => e.ackId === "p1").sessionId, "s-new");
  assert.equal(keep.find((e) => e.ackId === "p1").status, "queued");
});
