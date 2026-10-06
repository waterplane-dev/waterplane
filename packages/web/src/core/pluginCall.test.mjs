/**
 * `plugin.call` from the phone (`pluginCall.ts`): a LIVE question. Over fakes — a socket that records
 * frames, a clock the test fires by hand.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createPluginCalls } from "./pluginCall.ts";

function rig(status = "open") {
  const sent = [];
  const timers = new Map();
  let n = 0, t = 0;
  const noQueue = { closing: false };
  const d = {
    status: () => status,
    trySend: (f) => { if (status !== "open" || noQueue.closing) return false; sent.push(f); return true; },
    mintId: () => `id${++n}`,
    setTimer: (fn) => { timers.set(++t, fn); return t; },
    clearTimer: (h) => timers.delete(h),
  };
  const calls = createPluginCalls(d, 100_000);
  return { calls, sent, timers, fire: () => { for (const [k, fn] of [...timers]) { timers.delete(k); fn(); } }, setStatus: (s) => { status = s; }, noQueue };
}
const reply = (ackId, o = {}) => ({ t: "plugin.reply", ackId, plugin: "req", method: "list", ok: true, result: 1, ...o });

test("offline: nothing is sent and the answer is a sentence", async () => {
  const r = rig("closed");
  assert.deepEqual(await r.calls.call("req", "list", {}, true), { ok: false, error: "no connection — the desktop can't be asked from here" });
  assert.equal(r.sent.length, 0);
  assert.equal(r.calls.pending(), 0);
});

test("a reply resolves by ackId; a duplicate, an unknown id and a mismatched plugin or method are ignored", async () => {
  const r = rig();
  const p = r.calls.call("req", "list", { a: 1 }, true);
  assert.deepEqual(r.sent, [{ t: "plugin.call", plugin: "req", method: "list", args: { a: 1 }, ackId: "id1" }]);
  r.calls.onFrame(reply("zzz"));
  r.calls.onFrame(reply("id1", { plugin: "other" }));
  r.calls.onFrame(reply("id1", { method: "other" }));
  assert.equal(r.calls.pending(), 1);
  r.calls.onFrame(reply("id1", { result: { rows: [] } }));
  assert.deepEqual(await p, { ok: true, result: { rows: [] } });
  r.calls.onFrame(reply("id1", { result: 2 }));
  assert.equal(r.calls.pending(), 0);
});

test("an ok:false reply is the host's sentence; no args means no args key", async () => {
  const r = rig();
  const p = r.calls.call("req", "list", undefined, false);
  assert.ok(!("args" in r.sent[0]));
  r.calls.onFrame(reply("id1", { ok: false, result: undefined, error: "Requirements has no method \"list\"" }));
  assert.deepEqual(await p, { ok: false, error: "Requirements has no method \"list\"" });
});

test("a call nobody answers says so at the timeout", async () => {
  const r = rig();
  const p = r.calls.call("req", "list", null, true);
  r.fire();
  assert.deepEqual(await p, { ok: false, error: "req did not answer within 100 s" });
  assert.equal(r.calls.pending(), 0);
});

test("a reconnect re-sends a READ with the identical frame and resolves a WRITE as maybe-ran", async () => {
  const r = rig();
  const read = r.calls.call("req", "list", { q: 1 }, true);
  const write = r.calls.call("req", "save", { q: 2 }, false);
  assert.equal(r.sent.length, 2);
  const first = structuredClone(r.sent[0]);
  r.calls.onFrame({ t: "welcome" });
  assert.equal(r.sent.length, 3, "only the read went again");
  assert.deepEqual(r.sent[2], first, "same frame, same ackId");
  assert.deepEqual(await write, { ok: false, error: "the link dropped before req answered — it may have run; look before trying again" });
  assert.equal(r.calls.pending(), 1);
  r.calls.onFrame(reply("id1"));
  assert.deepEqual(await read, { ok: true, result: 1 });
  assert.equal(r.calls.pending(), 0);
  assert.equal(r.timers.size, 0, "every timer is cleared");
});

test("a write issued while the socket is closing is refused in words, never queued for replay", async () => {
  const r = rig();
  r.noQueue.closing = true; // status still says open, readyState is not
  assert.deepEqual(await r.calls.call("req", "save", {}, false), { ok: false, error: "no connection — the desktop can't be asked from here" });
  assert.equal(r.sent.length, 0);
  assert.equal(r.calls.pending(), 0);
  assert.equal(r.timers.size, 0);
});

test("a read is re-asked only of the host it asked; after a host switch it settles as dropped", async () => {
  const r = rig();
  r.calls.onFrame({ t: "welcome", hostId: "A" });
  const same = r.calls.call("req", "list", {}, true);
  r.calls.onFrame({ t: "welcome", hostId: "A" });
  assert.equal(r.sent.length, 2, "same host: re-asked");
  r.calls.onFrame(reply("id1"));
  await same;
  const moved = r.calls.call("req", "list", {}, true);
  r.calls.onFrame({ t: "welcome", hostId: "B" });
  assert.equal(r.sent.length, 3, "a different host is not asked");
  assert.deepEqual(await moved, { ok: false, error: "the desktop changed before it answered — ask again" });
  assert.equal(r.calls.pending(), 0);
});
