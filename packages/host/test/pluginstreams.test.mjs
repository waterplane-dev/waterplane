/**
 * Plugin streams, the host half (`plugins/pluginstreams.ts`, plugin API 1.4): the registry of
 * names, the per-socket ids, every refusal in words, and the backpressure state machine —
 * droppable frames skipped past the backlog line, the keyframe ask (and the recovery key) after the drain, once per drain, the
 * PTY first. Over a fake socket whose `bufferedAmount` the test sets. No daemon.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { PluginStreams, streamFrameAction, streamMayAskKey, backlogLimitFor, STREAM_KEY_OVERSHOOT } = await import("../dist/plugins/pluginstreams.js");
const { ptyHoldsStreams } = await import("../dist/server/liveness.js");
const { PluginRegistry } = await import("../dist/plugins/pluginregistry.js");
const { AuthManager } = await import("../dist/auth.js");
const { createPeerStore } = await import("../dist/peers/store.js");
const {
  decodeStreamFrame, PLUGIN_API_VERSION, PLUGIN_MANIFEST, STREAM_BACKLOG_DEFAULT, STREAM_FLAG_DROPPABLE, STREAM_FLAG_KEY,
  STREAM_INPUT_MAX, STREAM_MAX_PER_SOCKET, STREAM_PARAMS_MAX, STREAM_PAYLOAD_MAX, STREAM_STATUS_MAX,
} = await import("@waterplane/shared");

const tick = () => new Promise((r) => setImmediate(r));

function fakeWs() {
  return {
    bufferedAmount: 0, readyState: 1, frames: [], json: [],
    send(d, o) { this.frames.push({ d, o }); },
  };
}

/** A core over fake deps, plus a recording plugin. */
function rig({ refusal = null, openMs } = {}) {
  const failures = [];
  const logs = [];
  const held = new Set();
  const plugins = { p: { name: "Pee", refusal } };
  const streams = new PluginStreams({
    plugin: (id) => plugins[id] ?? null,
    failed: (id, what, err) => failures.push({ id, what, msg: String(err?.message ?? err) }),
    sink: () => ({ sendJson: (ws, m) => ws.json.push(m), ptyHeld: (ws) => held.has(ws) }),
    log: (l) => logs.push(l),
    now: () => 1234,
    openMs,
  });
  return { streams, failures, logs, held, plugins };
}

function recorder(over = {}) {
  const ev = { opens: [], params: [], inputs: [], keyframes: 0, acks: 0, closes: [], subs: [] };
  const handlers = {
    open: (sub, params) => { ev.opens.push(params); ev.subs.push(sub); },
    params: (_s, p) => ev.params.push(p),
    input: (_s, e) => ev.inputs.push(e),
    keyframe: () => { ev.keyframes++; },
    ack: () => { ev.acks++; },
    close: (_s, cause) => ev.closes.push(cause),
    ...over,
  };
  return { ev, handlers };
}

async function opened(streams, ws, name = "cam", params, reqId = "r1") {
  await streams.open(ws, { reqId, plugin: "p", name, params });
  const m = ws.json.at(-1);
  assert.equal(m?.t, "stream.opened", `opened (got ${JSON.stringify(m)})`);
  return m.streamId;
}

// ── pure policy ────────────────────────────────────────────────────────────

test("streamFrameAction: PTY first, then needs-key, then the droppable backlog line", () => {
  const f = (o) => streamFrameAction({ key: false, droppable: false, needsKey: false, ptyHeld: false, buffered: 0, limit: 100, ...o });
  assert.equal(f({}), "send");
  assert.equal(f({ ptyHeld: true, key: true }), "skip", "a key frame waits for the PTY too");
  assert.equal(f({ needsKey: true }), "skip");
  assert.equal(f({ needsKey: true, key: true }), "send", "a key ends the episode");
  assert.equal(f({ droppable: true, buffered: 101 }), "skip");
  assert.equal(f({ droppable: true, buffered: 100 }), "send", "at the line is not past it");
  assert.equal(f({ key: true, buffered: 150 }), "send", "a mid-run key may overshoot the line");
  assert.equal(f({ key: true, buffered: 200 }), "send", "up to STREAM_KEY_OVERSHOOT × the line");
  assert.equal(f({ key: true, buffered: 201 }), "skip", "but not far past it");
  assert.equal(f({ key: true, needsKey: true, buffered: 101 }), "skip", "a recovery key waits for the drain");
  assert.equal(f({ key: true, needsKey: true, buffered: 100 }), "send", "drained: the recovery key goes");
  assert.equal(f({ key: true, droppable: true, buffered: 101 }), "skip", "a replaceable still is droppable first");
  assert.equal(f({ buffered: 10_000 }), "send", "a non-droppable non-key frame ignores the backlog line");
  assert.equal(STREAM_KEY_OVERSHOOT, 2);
});

test("streamMayAskKey: never while the PTY is held, never past the line", () => {
  assert.equal(streamMayAskKey({ ptyHeld: false, buffered: 100, limit: 100 }), true);
  assert.equal(streamMayAskKey({ ptyHeld: false, buffered: 101, limit: 100 }), false, "a key asked into the backlog is the storm");
  assert.equal(streamMayAskKey({ ptyHeld: true, buffered: 0, limit: 100 }), false);
});

test("backlogLimitFor: bitrateKbps when a positive number, else the default", () => {
  assert.equal(backlogLimitFor(null), STREAM_BACKLOG_DEFAULT);
  assert.equal(backlogLimitFor({ bitrateKbps: "800" }), STREAM_BACKLOG_DEFAULT);
  assert.equal(backlogLimitFor({ bitrateKbps: -1 }), STREAM_BACKLOG_DEFAULT);
  assert.equal(backlogLimitFor([1]), STREAM_BACKLOG_DEFAULT);
  assert.equal(backlogLimitFor({ bitrateKbps: 8000 }), 400_000, "0.4 s of 8 Mbps");
  assert.equal(backlogLimitFor({ bitrateKbps: 100 }), 64 * 1024, "clamped low");
});

test("ptyHoldsStreams: past the PTY's line, or a torn terminal with bytes still queued", () => {
  assert.equal(ptyHoldsStreams(0, 1000, false), false);
  assert.equal(ptyHoldsStreams(1001, 1000, false), true);
  assert.equal(ptyHoldsStreams(1, 1000, true), true, "a starved terminal's replay goes first");
  assert.equal(ptyHoldsStreams(0, 1000, true), false, "drained: video may go, the replay is not blocked by it");
  assert.equal(ptyHoldsStreams(5000, 0, false), false, "threshold 0 turns the line off");
});

// ── the registry of names ───────────────────────────────────────────────────

test("serve: a bad name and a taken one throw a sentence; unregister ends its subs (cause plugin)", async () => {
  const { streams } = rig();
  assert.throws(() => streams.serve("p", "Pee", "Bad Name", recorder().handlers), /"Bad Name" is not a stream name/);
  assert.throws(() => streams.serve("p", "Pee", "cam", {}), /needs an open handler/);
  const { ev, handlers } = recorder();
  const off = streams.serve("p", "Pee", "cam", handlers);
  assert.throws(() => streams.serve("p", "Pee", "cam", handlers), /Pee already serves a stream named "cam"/);
  streams.serve("q", "Queue", "cam", handlers); // another plugin may use the same name
  const ws = fakeWs();
  const id = await opened(streams, ws);
  off();
  assert.deepEqual(ws.json.at(-1), { t: "stream.ended", streamId: id, cause: "plugin", reason: 'Pee stopped serving "cam"' });
  assert.deepEqual(ev.closes, ["plugin"]);
  assert.equal(ev.subs[0].send(new Uint8Array(1), { kind: 1 }), "ended");
  off(); // twice is a no-op
  assert.deepEqual(streams.names("p"), []);
});

test("dropPlugin: every name and every sub of that plugin, told in words", async () => {
  const { streams } = rig();
  const a = recorder(), b = recorder();
  streams.serve("p", "Pee", "cam", a.handlers);
  streams.serve("p", "Pee", "mic", b.handlers);
  const ws = fakeWs();
  await opened(streams, ws, "cam", null, "r1");
  await opened(streams, ws, "mic", null, "r2");
  streams.dropPlugin("p", "Pee is no longer running");
  assert.deepEqual(ws.json.slice(-2).map((m) => [m.t, m.cause, m.reason]), [["stream.ended", "plugin", "Pee is no longer running"], ["stream.ended", "plugin", "Pee is no longer running"]]);
  assert.deepEqual([a.ev.closes, b.ev.closes], [["plugin"], ["plugin"]]);
  assert.equal(streams.openOn(ws), 0);
});

// ── open ────────────────────────────────────────────────────────────────────

test("open: every refusal is a sentence and nothing is sent", async () => {
  const { streams, plugins } = rig();
  const { ev, handlers } = recorder({ open: (_s, p) => (p?.no ? "Screen Recording is not granted" : p?.boom ? (() => { throw new Error("helper missing"); })() : undefined) });
  streams.serve("p", "Pee", "cam", handlers);
  const ws = fakeWs();
  const refused = async (m) => { await streams.open(ws, { reqId: "x", plugin: "p", name: "cam", ...m }); const r = ws.json.at(-1); assert.equal(r.t, "stream.refused"); assert.equal(r.reqId, "x"); return r.reason; };
  assert.equal(await refused({ plugin: "nope" }), 'no plugin "nope" is installed');
  assert.equal(await refused({ name: "mic" }), 'Pee serves no stream "mic"');
  assert.equal(await refused({ name: "../x" }), 'Pee serves no stream "../x"');
  assert.match(await refused({ params: { blob: "x".repeat(STREAM_PARAMS_MAX) } }), /settings are 8203 bytes, over the 8192 bytes they may carry/);
  assert.equal(await refused({ params: { no: true } }), "Screen Recording is not granted", "the plugin's own sentence");
  assert.equal(await refused({ params: { boom: true } }), "helper missing", "a throw refuses with its message");
  plugins.p.refusal = "Pee is turned off";
  assert.equal(await refused({}), "Pee is turned off");
  plugins.p.refusal = null;
  assert.equal(ws.frames.length, 0, "no binary frame on any refusal");
  assert.equal(streams.openOn(ws), 0, "a refused open holds no slot");
  assert.deepEqual(ev.closes, [], "a refused open is never closed");
  await streams.open(ws, { reqId: 7, plugin: "p", name: "cam" });
  assert.equal(ws.json.at(-1).reason, "Pee is turned off", "a reqId that is not a string gets no answer at all");
});

test("open: ids are minted per socket, non-zero; the per-socket cap refuses in words", async () => {
  const { streams } = rig();
  const { ev, handlers } = recorder();
  streams.serve("p", "Pee", "cam", handlers);
  const a = fakeWs(), b = fakeWs();
  const ids = [];
  for (let i = 0; i < STREAM_MAX_PER_SOCKET; i++) ids.push(await opened(streams, a, "cam", { n: i }, `a${i}`));
  assert.deepEqual(ids, [1, 2]);
  assert.equal(await opened(streams, b, "cam", null, "b0"), 1, "another socket starts at 1 too");
  await streams.open(a, { reqId: "a9", plugin: "p", name: "cam" });
  assert.deepEqual(a.json.at(-1), { t: "stream.refused", reqId: "a9", reason: `this connection already has ${STREAM_MAX_PER_SOCKET} streams open; close one first` });
  assert.deepEqual(ev.opens, [{ n: 0 }, { n: 1 }, null]);
  streams.close(a, 1);
  assert.equal(await opened(streams, a, "cam", null, "a10"), 3, "a freed id is not reused at once");
});

test("open: the socket dies while the plugin is still opening ⇒ no opened, close('socket') once it says yes", async () => {
  const { streams } = rig();
  let release;
  const { ev, handlers } = recorder({ open: () => new Promise((r) => { release = r; }) });
  streams.serve("p", "Pee", "cam", handlers);
  const ws = fakeWs();
  const p = streams.open(ws, { reqId: "r", plugin: "p", name: "cam" });
  await tick();
  streams.socketGone(ws);
  assert.deepEqual(ev.closes, [], "close is owed only once open said yes");
  release();
  await p;
  assert.deepEqual(ws.json, [], "nothing sent to a dead socket");
  assert.deepEqual(ev.closes, ["socket"]);
});

test("open: a plugin that never answers is refused; its late yes is closed with cause error", async () => {
  const { streams } = rig({ openMs: 20 });
  let release;
  const { ev, handlers } = recorder({ open: () => new Promise((r) => { release = r; }) });
  streams.serve("p", "Pee", "cam", handlers);
  const ws = fakeWs();
  await streams.open(ws, { reqId: "r", plugin: "p", name: "cam" });
  assert.deepEqual(ws.json.at(-1), { t: "stream.refused", reqId: "r", reason: 'Pee did not open "cam" within 1 s' });
  release();
  await tick(); await tick();
  assert.deepEqual(ev.closes, ["error"]);
});

// ── send, and the state machine ─────────────────────────────────────────────

test("send: one binary frame to THAT socket, header decodes, seq increases, sentBytes counts payload", async () => {
  const { streams } = rig();
  const { ev, handlers } = recorder();
  streams.serve("p", "Pee", "cam", handlers);
  const ws = fakeWs(), other = fakeWs();
  const id = await opened(streams, ws);
  const sub = ev.subs[0];
  assert.equal(sub.send(new Uint8Array([1, 2, 3]), { kind: 7, key: true }), "sent");
  assert.equal(sub.send(new Uint8Array([4]), { kind: 7, droppable: true }), "sent");
  assert.equal(ws.frames.length, 2);
  assert.deepEqual(ws.frames[0].o, { binary: true, compress: false });
  const [f0, f1] = ws.frames.map((f) => decodeStreamFrame(f.d));
  assert.equal(f0.streamId, id);
  assert.equal(f0.kind, 7);
  assert.equal(f0.flags, STREAM_FLAG_KEY);
  assert.equal(f1.flags, STREAM_FLAG_DROPPABLE);
  assert.equal(f1.seq, f0.seq + 1);
  assert.deepEqual([...f0.payload], [1, 2, 3]);
  assert.equal(sub.sentBytes, 4);
  assert.equal(other.frames.length, 0, "a socket that never opened a stream receives no binary frame");
  assert.throws(() => sub.send(new Uint8Array(STREAM_PAYLOAD_MAX + 1), { kind: 1 }), /a frame of 4194305 bytes is over the 4194304 bytes one frame may carry/);
  assert.throws(() => sub.send(new Uint8Array(1), { kind: 300 }), /kind out of range/);
  sub.end("done here");
  assert.deepEqual(ws.json.at(-1), { t: "stream.ended", streamId: id, cause: "plugin", reason: "done here" });
  assert.deepEqual(ev.closes, ["plugin"]);
  assert.equal(sub.send(new Uint8Array(1), { kind: 1 }), "ended");
});

test("backpressure: droppable frames skip past the line, the key ask waits for the drain, ONE ask per drain", async () => {
  const { streams } = rig();
  const { ev, handlers } = recorder();
  streams.serve("p", "Pee", "cam", handlers);
  const ws = fakeWs();
  const id = await opened(streams, ws);
  const sub = ev.subs[0];
  const p = new Uint8Array(10);
  const L = STREAM_BACKLOG_DEFAULT;
  ws.bufferedAmount = L + 1;
  assert.equal(sub.backlogBytes, L + 1);
  assert.equal(sub.send(p, { kind: 1, droppable: true }), "skipped");
  assert.equal(sub.send(p, { kind: 1, droppable: true }), "skipped");
  assert.equal(ev.keyframes, 0, "no key is asked for INTO the backlog");
  streams.ack(ws, id, 1, 0);
  assert.equal(ev.keyframes, 0, "an ack past the line asks nothing either");
  assert.equal(sub.send(p, { kind: 1, key: true }), "skipped", "a recovery key waits for the drain");
  ws.bufferedAmount = 0;
  assert.equal(sub.send(p, { kind: 1, droppable: true }), "skipped", "drained, but the decoder still needs a key");
  assert.equal(ev.keyframes, 1, "asked on the first frame offered after the drain");
  assert.equal(sub.send(p, { kind: 1 }), "skipped", "every non-key frame waits for the key");
  streams.ack(ws, id, 2, 0);
  assert.equal(ev.keyframes, 1, "once per drain, not per frame or per ack");
  assert.equal(sub.send(p, { kind: 1, key: true }), "sent", "drained: the key ends the episode");
  ws.bufferedAmount = L + L / 2;
  assert.equal(sub.send(p, { kind: 1 }), "sent", "a non-droppable non-key frame ignores the line");
  assert.equal(sub.send(p, { kind: 1, key: true }), "sent", "a mid-run key may overshoot the line");
  ws.bufferedAmount = L * STREAM_KEY_OVERSHOOT + 1;
  assert.equal(sub.send(p, { kind: 1, key: true }), "skipped", "but not far past it");
  assert.equal(ev.keyframes, 1, "still past the line: nothing asked");
  ws.bufferedAmount = 0;
  streams.ack(ws, id, 3, 0);
  assert.equal(ev.keyframes, 2, "the ack after the drain asks again");
  assert.equal(ws.frames.length, 3);
  const seqs = ws.frames.map((f) => decodeStreamFrame(f.d).seq);
  assert.deepEqual(seqs, [seqs[0], seqs[0] + 1, seqs[0] + 2], "seq counts sent frames only");
});

test("backpressure: on a link slower than the bitrate, keys follow the drain and the buffer stays near the line", async () => {
  // R-desktop-007. A producer at 30 fps, 8 KB P-frames (~2 Mbit/s), a 40 KB IDR on the frame after
  // every ask; a link that drains 60 KB/s; acks every 250 ms. Before the fix this was an IDR every
  // other frame into a socket already over its line, and the buffer grew without bound.
  const { streams } = rig();
  let askPending = false;
  const { ev, handlers } = recorder({ keyframe: () => { ev.keyframes++; askPending = true; } });
  streams.serve("p", "Pee", "cam", handlers);
  const ws = fakeWs();
  ws.send = function (d) { this.frames.push(d.byteLength); this.bufferedAmount += d.byteLength; };
  const params = { bitrateKbps: 2000 };
  const id = await opened(streams, ws, "cam", params);
  const sub = ev.subs[0];
  const L = backlogLimitFor(params);
  const FPS = 30, P = 8_000, IDR = 40_000, DRAIN = 60_000, SECONDS = 20;
  let keysSent = 0, maxBuffered = 0, drained = 0, ackSeq = 0;
  askPending = true; // the open asked for the first key
  for (let i = 0; i < FPS * SECONDS; i++) {
    const out = Math.min(ws.bufferedAmount, DRAIN / FPS);
    ws.bufferedAmount -= out; drained += out;
    const key = askPending;
    askPending = false;
    const r = sub.send(new Uint8Array(key ? IDR : P), { kind: 1, key, droppable: !key });
    if (key && r === "sent") keysSent++;
    maxBuffered = Math.max(maxBuffered, ws.bufferedAmount);
    if (i % (FPS / 4) === 0) streams.ack(ws, id, ++ackSeq, 0);
  }
  assert.ok(keysSent >= 5, `the picture keeps coming (${keysSent} keys in ${SECONDS} s)`);
  assert.ok(keysSent * IDR <= drained + L + IDR, `keys never outrun the drain (${keysSent} × ${IDR} B vs ${Math.round(drained)} B drained)`);
  assert.ok(ev.keyframes <= keysSent + 2, `one ask per key that went out (${ev.keyframes} asks, ${keysSent} keys)`);
  assert.ok(maxBuffered <= L + IDR, `the buffer stays near the line (${maxBuffered} B, line ${L} B)`);
  assert.ok(keysSent < (FPS * SECONDS) / 10, `nowhere near an IDR every other frame (${keysSent})`);
});

test("backpressure: the line follows the params' bitrate, re-steered or not", async () => {
  const { streams } = rig();
  const { ev, handlers } = recorder();
  streams.serve("p", "Pee", "cam", handlers);
  const ws = fakeWs();
  const id = await opened(streams, ws, "cam", { bitrateKbps: 8000 });
  const sub = ev.subs[0];
  ws.bufferedAmount = 300_000;
  assert.equal(sub.send(new Uint8Array(1), { kind: 1, droppable: true }), "sent", "300 KB is under 0.4 s of 8 Mbps");
  streams.params(ws, id, { bitrateKbps: 1000 });
  assert.deepEqual(ev.params, [{ bitrateKbps: 1000 }]);
  assert.deepEqual(sub.params, { bitrateKbps: 1000 });
  assert.equal(sub.send(new Uint8Array(1), { kind: 1, droppable: true }), "skipped", "64 KB at 1 Mbps");
  streams.params(ws, id, { blob: "x".repeat(STREAM_PARAMS_MAX) });
  assert.equal(ev.params.length, 1, "oversized params are dropped");
});

test("PTY first: every frame waits while the PTY is held, the key ask is deferred to the next ack", async () => {
  const { streams, held } = rig();
  const { ev, handlers } = recorder();
  streams.serve("p", "Pee", "cam", handlers);
  const ws = fakeWs();
  const id = await opened(streams, ws);
  const sub = ev.subs[0];
  held.add(ws);
  assert.equal(sub.send(new Uint8Array(1), { kind: 1, key: true }), "skipped", "even a key frame");
  assert.equal(sub.send(new Uint8Array(1), { kind: 1 }), "skipped");
  assert.equal(ev.keyframes, 0, "no producer work while the PTY is held");
  streams.ack(ws, id, 3, 100);
  assert.equal(ev.keyframes, 0);
  held.delete(ws);
  streams.ack(ws, id, 4, 200);
  assert.equal(ev.keyframes, 1, "asked once the PTY let go");
  streams.ack(ws, id, 5, 300);
  assert.equal(ev.keyframes, 1);
  assert.equal(ev.acks, 3);
  assert.deepEqual(sub.lastAck, { seq: 5, rxBytes: 300, at: 1234 });
  assert.equal(sub.send(new Uint8Array(1), { kind: 1 }), "skipped", "still needs its key");
  assert.equal(sub.send(new Uint8Array(1), { kind: 1, key: true }), "sent");
  assert.equal(sub.send(new Uint8Array(1), { kind: 1 }), "sent");
});

test("frames sent while opening are skipped; a key is asked for the moment it opens", async () => {
  const { streams } = rig();
  const { ev, handlers } = recorder({ open: (sub) => { assert.equal(sub.send(new Uint8Array(1), { kind: 1, key: true }), "skipped"); assert.equal(sub.status({}), "the stream is not open yet"); } });
  streams.serve("p", "Pee", "cam", handlers);
  const ws = fakeWs();
  await opened(streams, ws);
  assert.equal(ev.keyframes, 1);
  assert.equal(ws.frames.length, 0);
});

test("sub.end(reason, 'replaced'): the phone hears cause replaced; any other cause is plugin", async () => {
  const { streams } = rig();
  const { ev, handlers } = recorder();
  streams.serve("p", "Pee", "cam", handlers);
  const ws = fakeWs();
  const a = await opened(streams, ws, "cam", null, "ra");
  const b = await opened(streams, ws, "cam", null, "rb");
  ev.subs[0].end("Opened on another screen.", "replaced");
  assert.deepEqual(ws.json.at(-1), { t: "stream.ended", streamId: a, cause: "replaced", reason: "Opened on another screen." });
  ev.subs[1].end("bye", "socket");
  assert.deepEqual(ws.json.at(-1), { t: "stream.ended", streamId: b, cause: "plugin", reason: "bye" }, "a plugin cannot claim any other cause");
  assert.deepEqual(ev.closes, ["replaced", "plugin"]);
});

// ── upstream, status, close ─────────────────────────────────────────────────

test("input reaches the plugin once; oversized or unknown ids are dropped in silence", async () => {
  const { streams, logs } = rig();
  const { ev, handlers } = recorder();
  streams.serve("p", "Pee", "cam", handlers);
  const ws = fakeWs();
  const id = await opened(streams, ws);
  streams.input(ws, id, { k: "a" });
  streams.input(ws, id, { k: "x".repeat(STREAM_INPUT_MAX) });
  streams.input(ws, 99, { k: "b" });
  streams.input(fakeWs(), id, { k: "c" });
  assert.deepEqual(ev.inputs, [{ k: "a" }]);
  assert.ok(logs.some((l) => /input dropped plugin=p name=cam id=1/.test(l)), "the drop is a log line");
  streams.keyframe(ws, id);
  assert.equal(ev.keyframes, 1);
  for (const f of ["params", "keyframe", "close"]) streams[f](ws, 42, {}); // stale ids: nothing, no throw
  streams.ack(ws, id, "x", 1);
  assert.equal(ev.acks, 0, "a malformed ack is ignored");
});

test("status: JSON to that socket only, over the cap a sentence", async () => {
  const { streams } = rig();
  const { ev, handlers } = recorder();
  streams.serve("p", "Pee", "cam", handlers);
  const ws = fakeWs();
  const id = await opened(streams, ws);
  const sub = ev.subs[0];
  assert.equal(sub.status({ preset: "auto" }), null);
  assert.deepEqual(ws.json.at(-1), { t: "stream.status", streamId: id, data: { preset: "auto" } });
  assert.match(sub.status({ x: "y".repeat(STREAM_STATUS_MAX) }), /over the 8192 bytes one may carry/);
});

test("close and socket death end the sub: close('closed') / close('socket'), nothing sent, one log line each", async () => {
  const { streams, logs } = rig();
  const { ev, handlers } = recorder();
  streams.serve("p", "Pee", "cam", handlers);
  const ws = fakeWs();
  const a = await opened(streams, ws, "cam", null, "r1");
  await opened(streams, ws, "cam", null, "r2");
  const sent = ws.json.length;
  streams.close(ws, a);
  streams.close(ws, a); // a repeat is a stale id
  streams.socketGone(ws);
  assert.deepEqual(ev.closes, ["closed", "socket"]);
  assert.equal(ws.json.length, sent, "neither is told to the phone");
  assert.equal(logs.filter((l) => / open plugin=p name=cam id=\d/.test(l)).length, 2);
  assert.ok(logs.some((l) => /close plugin=p name=cam id=1 cause=closed/.test(l)));
  assert.ok(logs.some((l) => /close plugin=p name=cam id=2 cause=socket/.test(l)));
  assert.equal(ev.subs[1].send(new Uint8Array(1), { kind: 1 }), "ended");
});

test("a throwing handler is the plugin's status line, never the caller's problem", async () => {
  const { streams, failures } = rig();
  const { ev, handlers } = recorder({ input: () => { throw new Error("bad event"); }, close: () => { throw new Error("bad close"); } });
  streams.serve("p", "Pee", "cam", handlers);
  const ws = fakeWs();
  const id = await opened(streams, ws);
  assert.doesNotThrow(() => streams.input(ws, id, {}));
  assert.doesNotThrow(() => streams.socketGone(ws));
  assert.deepEqual(failures.map((f) => [f.what, f.msg]), [['stream "cam" input', "bad event"], ['stream "cam" close', "bad close"]]);
  assert.equal(ev.subs.length, 1);
});

// ── through the registry: api.stream and switching a plugin off ─────────────

test("api.stream: served while the plugin runs; switched off ⇒ its streams end with cause plugin", async () => {
  const cfg = mkdtempSync(join(tmpdir(), "waterplane-streamcfg-"));
  const root = mkdtempSync(join(tmpdir(), "waterplane-streamroot-"));
  after(() => { for (const d of [cfg, root]) rmSync(d, { recursive: true, force: true }); });
  const mk = (id, host) => {
    const dir = join(cfg, "plugins", id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, PLUGIN_MANIFEST), JSON.stringify({ id, name: id.toUpperCase(), version: "1", apiVersion: PLUGIN_API_VERSION }));
    writeFileSync(join(dir, "host.mjs"), host);
  };
  mk("cam", `export function activate(api) { api.stream("live", { open() {}, close(_s, c) { globalThis.__camCloses = [...(globalThis.__camCloses ?? []), c]; } }); }`);
  mk("twice", `export function activate(api) { api.stream("a", { open() {} }); api.stream("a", { open() {} }); }`);
  const reg = new PluginRegistry({
    root, configDir: cfg, sessions: { list: () => [], get: () => null, setPluginBadge: () => {} },
    decision: () => {}, meter: () => {}, notify: () => {}, usage: () => ({ ok: false }), changed: () => {},
    streamSink: () => ({ sendJson: (ws, m) => ws.json.push(m), ptyHeld: () => false }),
  });
  after(() => reg.shutdownAll());
  await reg.loadAll();
  const byId = (id) => reg.entries.find((e) => e.manifest.id === id);
  assert.equal(byId("cam").state, "active");
  assert.equal(byId("twice").state, "error");
  assert.match(byId("twice").error, /TWICE already serves a stream named "a"/);
  const ws = fakeWs();
  await reg.streams.open(ws, { reqId: "r", plugin: "cam", name: "live" });
  assert.equal(ws.json.at(-1).t, "stream.opened");
  assert.equal(await reg.setEnabled("cam", false), null);
  assert.deepEqual(ws.json.at(-1), { t: "stream.ended", streamId: 1, cause: "plugin", reason: "CAM is no longer running" });
  assert.deepEqual(globalThis.__camCloses, ["plugin"]);
  await reg.streams.open(ws, { reqId: "r2", plugin: "cam", name: "live" });
  assert.deepEqual(ws.json.at(-1), { t: "stream.refused", reqId: "r2", reason: "CAM is turned off" });
  assert.deepEqual(ws.frames, []);
});

// ── the socket gate: a peer token never opens a socket ──────────────────────

test("a peer token is not a device token: the WS gate (`deviceFor`) refuses it wherever a token is needed", () => {
  const root = mkdtempSync(join(tmpdir(), "waterplane-streampeer-"));
  after(() => rmSync(root, { recursive: true, force: true }));
  const auth = new AuthManager(root);
  auth.setPassword("correct horse battery");
  const peers = createPeerStore(root);
  const TOK = "inbound-peer-token-0123456789abcdef";
  assert.equal(peers.upsert({ name: "pc", addr: "100.64.1.2:8770", inboundToken: TOK }).ok, true);
  assert.equal(peers.authenticate(TOK)?.name, "pc", "it IS a valid peer token");
  assert.equal(auth.needsToken("lan"), true);
  assert.equal(auth.deviceFor(TOK, "lan"), null, "…and opens no device socket, so no stream");
});
