import { test } from "node:test";
import assert from "node:assert/strict";

import {
  NET_STALL_MS, STALL_RING_CAP, classifyStall, cleanStallEvent, mergeStalls, pushRing, stallStats,
  stallSummaryLines, wsHealthy,
} from "../dist/netstall.js";

const ev = (over = {}) => ({ k: "p.1", at: 1000, label: "loading", method: "GET", ageMs: 20000, outcome: "timeout", ...over });

test("classify: a fuse is a stall at any age; otherwise only past NET_STALL_MS", () => {
  assert.equal(classifyStall({ ageMs: 10_000, fuseFired: true, answered: false }), "timeout");
  assert.equal(classifyStall({ ageMs: NET_STALL_MS - 1, fuseFired: false, answered: true }), null);
  assert.equal(classifyStall({ ageMs: NET_STALL_MS, fuseFired: false, answered: true }), "late");
  assert.equal(classifyStall({ ageMs: 90_000, fuseFired: false, answered: false }), "failed");
  assert.equal(classifyStall({ ageMs: NaN, fuseFired: false, answered: false }), null);
});

test("wsHealthy: unknown without a pong, never guessed", () => {
  assert.equal(wsHealthy(undefined), null);
  assert.equal(wsHealthy({ open: true }), null);
  assert.equal(wsHealthy({ open: false }), false);
  assert.equal(wsHealthy({ open: true, pongAgeMs: 5000 }), true);
  assert.equal(wsHealthy({ open: true, pongAgeMs: 120_000 }), false);
});

test("pushRing keeps the newest cap", () => {
  const r = [];
  for (let i = 0; i < 60; i++) pushRing(r, i, 50);
  assert.equal(r.length, 50);
  assert.equal(r[0], 10);
  assert.equal(r[49], 59);
});

test("stats: shares are absent when no event carried the fact", () => {
  const st = stallStats([ev(), ev({ k: "p.2" })]);
  assert.equal(st.sampled, 2);
  assert.equal(st.ageP95Ms, 20000);
  for (const k of ["maxInflight", "poolFullShare", "wsHealthyShare", "afterWakeShare", "zeroBytesShare"]) {
    assert.equal(k in st, false, k);
  }
});

test("stats: pool, ws, wake and zero-byte shares over the events that know", () => {
  const st = stallStats([
    ev({ k: "a", inflight: 7, ws: { open: true, pongAgeMs: 3000 }, visible: true, visForMs: 4000, sent: 0, total: 9 }),
    ev({ k: "b", inflight: 2, ws: { open: true, pongAgeMs: 3000 }, visible: true, visForMs: 600_000, sent: 5, total: 9 }),
    ev({ k: "c", inflight: 6, ws: { open: true } }),              // ws unknown: not in the share
    ev({ k: "d", ws: { open: false }, visible: false, visForMs: 10 }), // hidden: not in the wake share
  ]);
  assert.equal(st.maxInflight, 7);
  assert.equal(st.poolFullShare, 0.667);
  assert.equal(st.wsHealthyShare, 0.667);
  assert.equal(st.afterWakeShare, 0.5);
  assert.equal(st.zeroBytesShare, 0.5);
});

test("clean: rebuilt from named fields, unknown ones dropped, unusable events refused", () => {
  const e = cleanStallEvent({ ...ev(), extra: "x".repeat(9999), peers: [{ label: "pulling", ageMs: 5, junk: 1 }, { nope: 1 }], ws: { open: true, pongAgeMs: -4 } });
  assert.equal("extra" in e, false);
  assert.deepEqual(e.peers, [{ label: "pulling", ageMs: 5 }]);
  assert.deepEqual(e.ws, { open: true, pongAgeMs: 0 });
  assert.equal(cleanStallEvent({ ...ev(), outcome: "weird" }), null);
  assert.equal(cleanStallEvent({ ...ev(), k: "" }), null);
  assert.equal(cleanStallEvent({ ...ev(), ageMs: "1" }), null);
  assert.equal(cleanStallEvent(null), null);
});

test("merge: idempotent on k, counts outlive the ring, open replaces", () => {
  const one = mergeStalls(undefined, { events: [ev(), ev({ k: "p.2", outcome: "late" })], open: [ev({ k: "p.9", outcome: "open" })] }, 5);
  assert.deepEqual(one.counts, { timeout: 1, late: 1 });
  assert.equal(one.openNow, 1);
  const again = mergeStalls(one, { events: [ev(), ev({ k: "p.2", outcome: "late" })], open: [] }, 6);
  assert.deepEqual(again.counts, { timeout: 1, late: 1 });
  assert.equal(again.events.length, 2);
  assert.equal(again.openNow, 0);
  // A reload empties the phone's ring; the host keeps what it had.
  const afterReload = mergeStalls(again, { events: [ev({ k: "q.1", at: 2000, outcome: "failed" })] }, 7);
  assert.equal(afterReload.events.length, 3);
  assert.deepEqual(afterReload.counts, { timeout: 1, late: 1, failed: 1 });
  // An `open` event in `events` is not a finished stall.
  assert.equal(mergeStalls(undefined, { events: [ev({ outcome: "open" })] }, 1).events.length, 0);
  // The ring is capped, the count is not.
  const many = Array.from({ length: 80 }, (_, i) => ev({ k: `m.${i}`, at: 10_000 + i }));
  const big = mergeStalls(afterReload, { events: many }, 8);
  assert.equal(big.events.length, STALL_RING_CAP);
  assert.equal(big.counts.timeout, 1 + 80);
  assert.equal(big.events.at(-1).k, "m.79");
});

test("summary lines print only what is known", () => {
  const st = mergeStalls(undefined, { events: [ev()] }, 1);
  const [head, tail] = stallSummaryLines("abc", st);
  assert.match(head, /^abc: timeout 1 · late 0 · failed 0 · open now 0$/);
  assert.match(tail, /age p95 20s/);
  assert.doesNotMatch(tail, /ws healthy/);
});
