/**
 * A durable op this host no longer has (`capture.run`, removed with verified capture) is answered
 * with a refusal `op.ack`, so an older phone's queued row settles instead of re-sending for ever.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

const { dispatch } = await import("../dist/routes/index.js");

test("a retired durable op with an ackId is refused in an op.ack and nothing else happens", () => {
  const sent = [];
  const c = { send: (_ws, m) => sent.push(m) };
  dispatch(c, {}, { t: "capture.run", repoDir: "/x", targetId: "t", ackId: "a1" });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].t, "op.ack");
  assert.equal(sent[0].ackId, "a1");
  assert.equal(sent[0].ok, false);
});

test("without an ackId, or for any other unknown t, dispatch stays a silent no-op", () => {
  const sent = [];
  const c = { send: (_ws, m) => sent.push(m) };
  dispatch(c, {}, { t: "capture.run", repoDir: "/x", targetId: "t" });
  dispatch(c, {}, { t: "capture.list", repoDir: "/x" });
  assert.deepEqual(sent, []);
});
