/** Which session an ask button started last time. node --test packages/web/src/lastAskLogic.test.mjs */
import "../../../scripts/lib-tsload.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { LAST_ASK_CAP, adoptAsks, askPlace, recordAsk, resolveAsk } from "./lastAskLogic.ts";

const live = [{ id: "s1", title: "fix storage" }];
const closed = [{ id: "s0", title: "old one" }];
const never = () => false;

test("a record moves to the front and the map is capped", () => {
  let m = {};
  for (let i = 0; i < LAST_ASK_CAP + 5; i++) m = recordAsk(m, `k${i}`, { sid: `s${i}`, cwd: "/r", at: i });
  assert.equal(Object.keys(m).length, LAST_ASK_CAP);
  m = recordAsk(m, "k10", { sid: "new", cwd: "/r", at: 999 });
  assert.equal(Object.keys(m)[0], "k10");
  assert.equal(m.k10.sid, "new");
});

test("a new session is known by its create's ack until the adoption names it", () => {
  const a = { ack: "A1", cwd: "/r", at: 1 };
  assert.equal(resolveAsk(a, {}), null);
  assert.equal(resolveAsk(a, { A1: { sid: "s1", at: 2 } }), "s1");
  const m = adoptAsks({ k: a, j: { ack: "B", cwd: "/r", at: 1 } }, "A1", "s1");
  assert.equal(m.k.sid, "s1");
  assert.equal(m.j.sid, undefined);
  const same = { k: { sid: "s1", cwd: "/r", at: 1 } };
  assert.equal(adoptAsks(same, "A1", "s9"), same, "nothing waits: the same object, no write");
});

test("where the answer is: live jumps, closed is a sentence, starting waits, unknown is absent", () => {
  assert.deepEqual(askPlace({ sid: "s1", cwd: "/r", at: 5 }, {}, live, closed, never), { kind: "live", sid: "s1", title: "fix storage", at: 5 });
  assert.equal(askPlace({ sid: "s0", cwd: "/r", at: 5 }, {}, live, closed, never)?.kind, "closed");
  assert.equal(askPlace({ ack: "A", cwd: "/r", at: 5 }, {}, live, closed, (a) => a === "A")?.kind, "starting");
  assert.equal(askPlace({ ack: "A", cwd: "/r", at: 5 }, {}, live, closed, never), null);
  assert.equal(askPlace({ sid: "gone", cwd: "/r", at: 5 }, {}, live, closed, never), null);
  assert.equal(askPlace(undefined, {}, live, closed, never), null);
});
