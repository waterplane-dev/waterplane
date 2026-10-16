/**
 * `session.followup` in the demo (`demo/host/followup.ts`): toggled for real on
 * a live session (answered by `session.updated`) and cleared on a closed row by
 * its conversation id (answered by `closed.list`), with no receipt.
 *
 *     node --test packages/web/src/demo/host/followup.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { PROTOCOL_VERSION } from "@waterplane/shared";
import { createDemoHost } from "./index.ts";

function harness(model) {
  const sc = { meta: { id: "t", protocol: PROTOCOL_VERSION, stamp: "s1" }, clock: { start: 1_000 }, state: { bootId: "b", model }, script: [] };
  const host = createDemoHost(sc, { now: () => 1_000 });
  const outs = [];
  const conn = host.connect((o) => outs.push(o));
  conn.receive({ t: "hello" });
  return { conn, frames: () => outs.filter((o) => o.kind === "frame").map((o) => o.msg) };
}

test("a live session's flag is set as the person's and cleared whoever set it", () => {
  const h = harness({ sessions: [{ id: "s1", cwd: "/r", title: "r", running: true, followUp: { by: "agent", at: 5, reason: "read it" } }] });
  h.conn.receive({ t: "session.followup", id: "s1", on: false });
  assert.equal(h.frames().filter((m) => m.t === "session.updated").at(-1).session.followUp, undefined);
  h.conn.receive({ t: "session.followup", id: "s1", on: true });
  assert.equal(h.frames().filter((m) => m.t === "session.updated").at(-1).session.followUp.by, "hand");
  assert.equal(h.frames().filter((m) => m.t === "op.ack" || m.t === "toast").length, 0, "fire-and-forget, never refused");
});

test("a closed row's flag clears by its conversation id", () => {
  const h = harness({ sessions: [], closed: [{ id: "old", cwd: "/r", title: "r", closedAt: 1, claudeSessionId: "c-1", followUp: { by: "launch", at: 2 } }] });
  h.conn.receive({ t: "session.followup", id: "c-1", on: false });
  assert.equal(h.frames().filter((m) => m.t === "closed.list").at(-1).closed[0].followUp, undefined);
});
