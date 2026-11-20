/** The `pending:` id module: made, recognised and parsed in one place. node --test packages/web/src/core/queue/pendingId.test.mjs */
import "../../../../../scripts/lib-tsload.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { isLaterId, isPendingId, laterId, makePendingId, parseLaterId, parsePendingId } from "./pendingId.ts";
import { pendingLaneId } from "./logic.ts";

test("a create's id round-trips", () => {
  const id = makePendingId("ack1");
  assert.equal(id, "pending:ack1");
  assert.equal(pendingLaneId("ack1"), id);
  assert.ok(isPendingId(id));
  assert.equal(parsePendingId(id), "ack1");
  assert.equal(parseLaterId(id), null);
});

test("`+ later` is a pending id but has no create behind it", () => {
  const id = laterId("/r/x");
  assert.equal(id, "pending:later:/r/x");
  assert.ok(isPendingId(id) && isLaterId(id));
  assert.equal(parsePendingId(id), null);
  assert.equal(parseLaterId(id), "/r/x");
});

test("a real session id or nothing is neither", () => {
  for (const id of ["s1", "", null, undefined, "pending", "xpending:a"]) {
    assert.ok(!isPendingId(id));
    assert.equal(parsePendingId(id), null);
  }
  assert.equal(parsePendingId("pending:"), null);
});
