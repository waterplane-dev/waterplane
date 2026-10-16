/**
 * The phone's stream router (`streams.ts`) over a fake socket and a fake clock: frames routed by
 * streamId, unknown and foreign ones dropped, the ack cadence, a reconnect reopening with the
 * LATEST params, input dropped (never queued) while not open, and the rolling kbps/fps.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { STREAM_ACK_EVERY_MS, STREAM_INPUT_MAX, encodeStreamFrame } from "@waterplane/shared";

import { STREAM_OPEN_TIMEOUT_MS, createStreams } from "./streams.ts";

function harness({ open = true } = {}) {
  let now = 1_000_000;
  let ids = 0;
  let timers = [];
  let tid = 0;
  const sent = [];
  const reports = [];
  const sock = { open };
  const s = createStreams({
    trySend: (f) => { if (!sock.open) return false; sent.push(f); return true; },
    mintId: () => `r${++ids}`,
    now: () => now,
    setTimer: (fn, ms) => { const t = { id: ++tid, at: now + ms, fn }; timers.push(t); return t; },
    clearTimer: (t) => { timers = timers.filter((x) => x !== t); },
    report: (what, e) => reports.push([what, String(e)]),
  });
  const advance = (ms) => {
    const end = now + ms;
    for (;;) {
      const due = timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      timers = timers.filter((t) => t !== due);
      now = due.at;
      due.fn();
    }
    now = end;
  };
  const welcome = () => { sock.open = true; s.onText({ t: "welcome" }); };
  const drop = () => { sock.open = false; s.onText({ t: "error", message: "closed", context: "__status" }); };
  const frame = (streamId, seq, bytes, flags = 0) => encodeStreamFrame({ streamId, seq, kind: 1, flags }, new Uint8Array(bytes)).buffer;
  const of = (t) => sent.filter((f) => f.t === t);
  return { s, sent, of, reports, advance, welcome, drop, frame, sock, get now() { return now; } };
}

function recorder() {
  const log = { frames: [], status: [], ended: [], opened: [] };
  return {
    log,
    cb: {
      onFrame: (f) => log.frames.push(f),
      onStatus: (d) => log.status.push(d),
      onEnded: (c, r) => log.ended.push([c, r]),
      onOpened: (id) => log.opened.push(id),
    },
  };
}

test("open waits for a welcome, then sends stream.open and binds the streamId on stream.opened", () => {
  const h = harness();
  const { log, cb } = recorder();
  const st = h.s.open("desktop", "screen", { q: 1 }, cb);
  assert.equal(h.sent.length, 0, "no welcome yet: nothing goes out");
  assert.equal(st.stats().state, "opening");
  h.welcome();
  assert.deepEqual(h.of("stream.open"), [{ t: "stream.open", reqId: "r1", plugin: "desktop", name: "screen", params: { q: 1 } }]);
  h.s.onText({ t: "stream.opened", reqId: "r1", streamId: 7, plugin: "desktop", name: "screen" });
  assert.equal(st.stats().state, "open");
  assert.equal(st.stats().streamId, 7);
  assert.equal(st.stats().openedAt, h.now);
  assert.deepEqual(log.opened, [7]);
});

test("binary frames are routed by streamId; an unknown id or a foreign frame is dropped in silence", () => {
  const h = harness();
  h.welcome();
  const a = recorder();
  const b = recorder();
  h.s.open("p", "a", undefined, a.cb);
  h.s.open("p", "b", undefined, b.cb);
  h.s.onText({ t: "stream.opened", reqId: "r1", streamId: 1, plugin: "p", name: "a" });
  h.s.onText({ t: "stream.opened", reqId: "r2", streamId: 2, plugin: "p", name: "b" });
  h.s.onBinary(h.frame(2, 5, 10));
  h.s.onBinary(h.frame(1, 9, 3));
  h.s.onBinary(h.frame(99, 1, 4)); // nobody opened 99
  h.s.onBinary(new Uint8Array([1, 2, 3]).buffer); // not ours at all
  h.s.onBinary(new Uint8Array(20).buffer); // wrong magic
  assert.deepEqual(a.log.frames.map((f) => [f.streamId, f.seq, f.payload.byteLength]), [[1, 9, 3]]);
  assert.deepEqual(b.log.frames.map((f) => [f.streamId, f.seq, f.payload.byteLength]), [[2, 5, 10]]);
  assert.deepEqual(h.reports, []);
});

test("a throwing onFrame is reported and never stops the routing", () => {
  const h = harness();
  h.welcome();
  let n = 0;
  h.s.open("p", "a", undefined, { onFrame: () => { n++; throw new Error("boom"); } });
  h.s.onText({ t: "stream.opened", reqId: "r1", streamId: 1, plugin: "p", name: "a" });
  h.s.onBinary(h.frame(1, 1, 1));
  h.s.onBinary(h.frame(1, 2, 1));
  assert.equal(n, 2);
  assert.equal(h.reports.length, 2);
});

test("stream.ack goes out every STREAM_ACK_EVERY_MS while frames arrive, and stops when they do", () => {
  const h = harness();
  h.welcome();
  const st = h.s.open("p", "a", undefined, { onFrame() {} });
  h.s.onText({ t: "stream.opened", reqId: "r1", streamId: 3, plugin: "p", name: "a" });
  h.s.onBinary(h.frame(3, 1, 100));
  h.advance(STREAM_ACK_EVERY_MS - 1);
  assert.equal(h.of("stream.ack").length, 0, "not before the cadence");
  h.s.onBinary(h.frame(3, 2, 50));
  h.advance(1);
  assert.deepEqual(h.of("stream.ack"), [{ t: "stream.ack", streamId: 3, seq: 2, rxBytes: 150 }]);
  h.s.onBinary(h.frame(3, 3, 25));
  h.advance(STREAM_ACK_EVERY_MS);
  assert.deepEqual(h.of("stream.ack").at(-1), { t: "stream.ack", streamId: 3, seq: 3, rxBytes: 175 });
  h.advance(STREAM_ACK_EVERY_MS * 10);
  assert.equal(h.of("stream.ack").length, 2, "no frames, no acks");
  assert.equal(st.stats().rxBytes, 175);
  assert.equal(st.stats().frames, 3);
});

test("a reconnect reopens with the LATEST params under a new streamId; the ack counts that id's bytes only", () => {
  const h = harness();
  h.welcome();
  const { log, cb } = recorder();
  const st = h.s.open("p", "a", { q: "low" }, cb);
  h.s.onText({ t: "stream.opened", reqId: "r1", streamId: 4, plugin: "p", name: "a" });
  h.s.onBinary(h.frame(4, 1, 1000));
  h.drop();
  assert.equal(st.stats().state, "opening");
  assert.equal(st.stats().streamId, null);
  h.s.onBinary(h.frame(4, 2, 1000)); // a straggler for the dead id
  assert.equal(log.frames.length, 1);
  assert.equal(st.setParams({ q: "high" }), true, "remembered while down");
  assert.equal(h.of("stream.params").length, 0, "nothing goes out with the socket down");
  h.welcome();
  assert.deepEqual(h.of("stream.open").at(-1), { t: "stream.open", reqId: "r2", plugin: "p", name: "a", params: { q: "high" } });
  h.s.onText({ t: "stream.opened", reqId: "r2", streamId: 9, plugin: "p", name: "a" });
  assert.deepEqual(log.opened, [4, 9]);
  assert.equal(h.of("stream.params").length, 0, "the open carried them already");
  h.s.onBinary(h.frame(9, 1, 10));
  h.advance(STREAM_ACK_EVERY_MS);
  assert.deepEqual(h.of("stream.ack").at(-1), { t: "stream.ack", streamId: 9, seq: 1, rxBytes: 10 });
  assert.equal(st.stats().rxBytes, 1010, "the handle's total spans both ids");
});

test("params changed while an open is in flight are sent the moment it binds", () => {
  const h = harness();
  h.welcome();
  const st = h.s.open("p", "a", { q: 1 }, { onFrame() {} });
  st.setParams({ q: 2 });
  h.s.onText({ t: "stream.opened", reqId: "r1", streamId: 5, plugin: "p", name: "a" });
  assert.deepEqual(h.of("stream.params"), [{ t: "stream.params", streamId: 5, params: { q: 2 } }]);
  st.setParams({ q: 3 });
  assert.deepEqual(h.of("stream.params").at(-1), { t: "stream.params", streamId: 5, params: { q: 3 } });
});

test("input is dropped — never queued — unless open on a live socket", () => {
  const h = harness();
  const st = h.s.open("p", "a", undefined, { onFrame() {} });
  assert.equal(st.input({ x: 1 }), false, "opening");
  h.welcome();
  assert.equal(st.input({ x: 1 }), false, "open sent, not answered");
  h.s.onText({ t: "stream.opened", reqId: "r1", streamId: 6, plugin: "p", name: "a" });
  assert.equal(st.input({ x: 2 }), true);
  h.drop();
  assert.equal(st.input({ x: 3 }), false, "socket down");
  h.welcome();
  h.s.onText({ t: "stream.opened", reqId: "r2", streamId: 8, plugin: "p", name: "a" });
  assert.deepEqual(h.of("stream.input"), [{ t: "stream.input", streamId: 6, ev: { x: 2 } }], "the dropped ones never arrive later");
  assert.equal(st.input({ big: "x".repeat(STREAM_INPUT_MAX) }), false, "past the cap");
  st.close();
  assert.equal(st.input({ x: 4 }), false, "closed");
});

test("close sends stream.close; a close before the answer closes whatever the answer binds", () => {
  const h = harness();
  h.welcome();
  const st = h.s.open("p", "a", undefined, { onFrame() {} });
  h.s.onText({ t: "stream.opened", reqId: "r1", streamId: 2, plugin: "p", name: "a" });
  st.close();
  st.close();
  assert.deepEqual(h.of("stream.close"), [{ t: "stream.close", streamId: 2 }]);
  assert.equal(st.stats().state, "ended");
  const early = h.s.open("p", "b", undefined, { onFrame() {} });
  early.close();
  h.s.onText({ t: "stream.opened", reqId: "r2", streamId: 3, plugin: "p", name: "b" });
  assert.deepEqual(h.of("stream.close").at(-1), { t: "stream.close", streamId: 3 });
  h.s.onText({ t: "stream.opened", reqId: "nobody", streamId: 4, plugin: "p", name: "c" });
  assert.deepEqual(h.of("stream.close").at(-1), { t: "stream.close", streamId: 4 }, "an answer nobody waits for is closed");
  h.drop();
  h.welcome();
  assert.equal(h.of("stream.open").length, 2, "a closed handle is never reopened");
  assert.equal(h.s.count(), 0);
});

test("refused, ended and status reach the callbacks; an ended stream is not reopened", () => {
  const h = harness();
  h.welcome();
  const a = recorder();
  const sa = h.s.open("p", "a", undefined, a.cb);
  h.s.onText({ t: "stream.refused", reqId: "r1", reason: "Screen Recording is not granted" });
  assert.deepEqual(a.log.ended, [["refused", "Screen Recording is not granted"]]);
  assert.equal(sa.stats().state, "refused");
  assert.equal(sa.stats().reason, "Screen Recording is not granted");
  const b = recorder();
  const sb = h.s.open("p", "b", undefined, b.cb);
  h.s.onText({ t: "stream.opened", reqId: "r2", streamId: 1, plugin: "p", name: "b" });
  h.s.onText({ t: "stream.status", streamId: 1, data: { preset: "auto" } });
  h.s.onText({ t: "stream.status", streamId: 2, data: "not mine" });
  assert.deepEqual(b.log.status, [{ preset: "auto" }]);
  h.s.onText({ t: "stream.ended", streamId: 1, cause: "plugin", reason: "the helper exited" });
  assert.deepEqual(b.log.ended, [["plugin", "the helper exited"]]);
  assert.equal(sb.stats().state, "ended");
  h.s.onBinary(h.frame(1, 1, 1));
  assert.equal(b.log.frames.length, 0);
  h.drop();
  h.welcome();
  assert.equal(h.of("stream.open").length, 2);
});

test("an open nobody answers is refused in words after STREAM_OPEN_TIMEOUT_MS", () => {
  const h = harness();
  h.welcome();
  const { log, cb } = recorder();
  const st = h.s.open("p", "a", undefined, cb);
  h.advance(STREAM_OPEN_TIMEOUT_MS);
  assert.equal(st.stats().state, "refused");
  assert.match(log.ended[0][1], /did not answer/);
});

test("an open that cannot be written waits for the next welcome rather than queueing", () => {
  const h = harness();
  h.welcome();
  h.sock.open = false; // the socket died before the status edge arrived
  const st = h.s.open("p", "a", undefined, { onFrame() {} });
  assert.equal(h.of("stream.open").length, 0);
  h.welcome();
  assert.equal(h.of("stream.open").length, 1);
  assert.equal(st.stats().state, "opening");
});

test("stats: kbps and fps over a rolling 2 s window", () => {
  const h = harness();
  h.welcome();
  const st = h.s.open("p", "a", undefined, { onFrame() {} });
  h.s.onText({ t: "stream.opened", reqId: "r1", streamId: 1, plugin: "p", name: "a" });
  // 10 frames of 1000 bytes over 1 s, then 1 s of nothing.
  for (let i = 0; i < 10; i++) { h.advance(100); h.s.onBinary(h.frame(1, i, 1000)); }
  let s = st.stats();
  assert.equal(s.frames, 10);
  assert.equal(s.fps, 10, "10 frames in the 1 s since it opened");
  assert.equal(s.kbps, 80, "10 000 bytes in 1 s = 80 kbit/s");
  h.advance(1000);
  s = st.stats();
  assert.equal(s.fps, 5, "10 frames in the 2 s window");
  assert.equal(s.kbps, 40);
  h.advance(2000);
  s = st.stats();
  assert.equal(s.fps, 0, "the window rolled past every frame");
  assert.equal(s.kbps, 0);
  assert.equal(s.rxBytes, 10000, "the total does not roll");
});
