/**
 * The phone's stall recorder (`link/stallRecorder.ts`), over a fake clock.
 *
 *     node --test packages/web/src/link/stallRecorder.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { NET_STALL_MS } from "@waterplane/shared";
import { StallRecorder } from "./stallRecorder.ts";

function rig(ctx = {}) {
  let now = 1_000_000;
  const timers = [];
  let changes = 0;
  const rec = new StallRecorder({
    now: () => now,
    context: () => ctx,
    setTimer: (fn, ms) => { const t = { fn, due: now + ms, live: true }; timers.push(t); return t; },
    clearTimer: (t) => { t.live = false; },
    changed: () => { changes++; },
  }, "pg");
  const advance = (ms) => {
    now += ms;
    for (const t of timers) if (t.live && t.due <= now) { t.live = false; t.fn(); }
  };
  return { rec, advance, changes: () => changes };
}

test("a fast request records nothing", () => {
  const { rec, advance, changes } = rig();
  const h = rec.begin("loading", "get", "fetch");
  advance(300);
  h.end({ answered: true });
  assert.equal(rec.ring.length, 0);
  assert.equal(changes(), 0);
  assert.equal(rec.inflight(), 0);
});

test("a late answer is recorded with the in-flight picture AT the stall", () => {
  const ws = { open: true, pongAgeMs: 4000, rttMs: 30 };
  const { rec, advance } = rig({ ws, visible: true, visForMs: 2000, online: true });
  const slow = [];
  for (let i = 0; i < 5; i++) slow.push(rec.begin("reading git status", "GET", "fetch"));
  advance(1000);
  const h = rec.begin("loading files", "GET", "fetch");
  advance(NET_STALL_MS);           // onset: 6 in flight
  for (const s of slow) s.end({ answered: true }); // ends late too
  advance(30_000);
  h.end({ answered: true });
  const e = rec.ring.find((x) => x.label === "loading files");
  assert.equal(e.outcome, "late");
  assert.equal(e.inflight, 6);
  assert.equal(e.peers.length, 5);
  assert.equal(e.peers[0].label, "reading git status");
  assert.deepEqual(e.ws, ws);
  assert.equal(e.visForMs, 2000);
  assert.equal(e.ageMs, NET_STALL_MS + 30_000);
  assert.equal(rec.ring.length, 6);
});

test("a fuse is a timeout; an upload says how many bytes left", () => {
  const { rec, advance } = rig();
  const h = rec.begin("uploading", "POST", "xhr");
  h.progress(0, 138_000);
  advance(29_000);
  h.end({ answered: false, fuseMs: 25_000 });
  const [e] = rec.ring;
  assert.equal(e.outcome, "timeout");
  assert.equal(e.fuseMs, 25_000);
  assert.equal(e.sent, 0);
  assert.equal(e.total, 138_000);
  assert.equal(e.via, "xhr");
});

test("unknown context is absent, never zero", () => {
  const { rec, advance } = rig({});
  const h = rec.begin("loading", "GET", "fetch");
  advance(NET_STALL_MS + 1);
  h.end({ answered: false });
  const [e] = rec.ring;
  assert.equal(e.outcome, "failed");
  for (const k of ["ws", "visible", "visForMs", "online", "sent", "peers", "fuseMs"]) assert.equal(k in e, false, k);
});

test("open stalls are reported without entering the ring; end is idempotent", () => {
  const { rec, advance } = rig();
  const h = rec.begin("pulling", "GET", "fetch");
  advance(5000);
  assert.equal(rec.openStalls().length, 0);
  advance(NET_STALL_MS);
  const r = rec.report();
  assert.equal(r.events.length, 0);
  assert.equal(r.open.length, 1);
  assert.equal(r.open[0].outcome, "open");
  h.end({ answered: true });
  h.end({ answered: true });
  assert.equal(rec.ring.length, 1);
  assert.equal(rec.report().open.length, 0);
});

test("a body timeout is its own event", () => {
  const { rec } = rig();
  rec.bodyTimeout("loading files", "GET", 20_000);
  const [e] = rec.ring;
  assert.equal(e.phase, "body");
  assert.equal(e.outcome, "timeout");
  assert.equal(e.ageMs, 20_000);
  assert.match(e.k, /^pg\.b/);
});
