/**
 * The burn-rate push: when it speaks, when it stays quiet, and what it says.
 *
 *     node --test packages/host/test/burnwatch.test.mjs
 *
 * The rule itself (stretch, rate, verdict, words) is pinned in shared's
 * `burn.test.mjs`; this is the plumbing around it — the threshold gate, one push
 * per cooldown, a state file that survives a restart, a push that still goes
 * when the ledger cannot be read, and no timers of its own.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zeroCost, zeroTotals } from "@waterplane/shared";
import { createBurnWatch } from "../dist/burnwatch.js";

const MIN = 60_000;
const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "burnwatch-")); dirs.push(d); return d; };

const T0 = Date.UTC(2026, 9, 9, 8, 0, 0);
/** A weekly figure climbing `perReading` points every 10 minutes for 90 minutes. */
const series = (perReading) => Array.from({ length: 10 }, (_, i) => ({ t: T0 + i * 10 * MIN, s: 5, w: 10 + i * perReading, sr: null, wr: T0 + 5 * 24 * 60 * MIN }));
const NOW = T0 + 91 * MIN;
const ok = { ok: true, weeklyPct: 40 };

const cost = (total) => ({ ...zeroCost(), total });
const convo = (id, usd, launch) => ({
  id, repo: `/r/${id}`, label: id, title: `title ${id}`, launch,
  totals: zeroTotals(), cost: cost(usd), agentTotals: zeroTotals(), agentCost: cost(0), firstAt: T0, lastAt: NOW,
});
const doc = () => ({
  from: T0, to: NOW, fromHour: T0, hours: [], totals: zeroTotals(), cost: cost(30), agentTotals: zeroTotals(), agentCost: cost(0),
  unpriced: zeroTotals(), pricesAsOf: "x", scannedAt: NOW,
  convos: [
    convo("a1", 10, { kind: "fanout", runId: "run-7", label: "architect review" }),
    convo("a2", 10, { kind: "fanout", runId: "run-7", label: "architect review" }),
    convo("b1", 4, undefined),
  ],
});

function make(over = {}) {
  const sent = [];
  const stateDir = over.stateDir ?? tmp();
  const w = createBurnWatch({
    usageLog: { read: () => ({ samples: over.samples ?? series(1), keptFrom: T0, cap: 1, retainMs: 1, everyMs: 0 }) },
    costWindow: over.costWindow ?? (async () => doc()),
    notify: (kind, p) => sent.push({ kind, ...p }),
    stateDir, now: () => NOW,
    thresholdPtsPerHour: over.threshold ?? 4, cooldownMs: over.cooldownMs ?? 3 * 60 * MIN,
  });
  return { w, sent, stateDir };
}

test("a climb under the threshold says nothing", async () => {
  const { w, sent } = make({ samples: series(0.2) });
  assert.equal(await w.observe(ok), false);
  assert.deepEqual(sent, []);
});

test("a climb over it pushes once, kind burn, naming the launch and ending in words only", async () => {
  const { w, sent } = make();
  assert.equal(await w.observe(ok), true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].kind, "burn");
  assert.equal(sent[0].tag, "burn");
  assert.match(sent[0].body, /architect review · 2 repos/);
  assert.match(sent[0].body, /Nothing was paused\.$/);
});

test("a second reading inside the cooldown says nothing, and the state file survives a restart", async () => {
  const a = make();
  assert.equal(await a.w.observe(ok), true);
  assert.equal(await a.w.observe(ok), false);
  const file = join(a.stateDir, "burnwatch.json");
  assert.ok(existsSync(file));
  const saved = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(saved.lastAt, NOW);
  assert.equal(typeof saved.lastFrom, "number");
  // A new watcher over the same dir (a restart) still holds the cooldown.
  const b = make({ stateDir: a.stateDir });
  assert.equal(await b.w.observe(ok), false);
  assert.deepEqual(b.sent, []);
});

test("the same stretch is never told twice, even after the cooldown", async () => {
  const a = make();
  await a.w.observe(ok);
  const b = make({ stateDir: a.stateDir, cooldownMs: 1 });
  assert.equal(await b.w.observe(ok), false);
});

test("a ledger that cannot be read costs the push its top line, never the push", async () => {
  const { w, sent } = make({ costWindow: async () => { throw new Error("no ledger"); } });
  assert.equal(await w.observe(ok), true);
  assert.equal(sent.length, 1);
  assert.doesNotMatch(sent[0].body, /Dearest in it/);
  assert.match(sent[0].body, /Nothing was paused\.$/);
});

test("threshold 0 is off", async () => {
  const { w, sent } = make({ threshold: 0 });
  assert.equal(await w.observe(ok), false);
  assert.deepEqual(sent, []);
});

test("armed() is what keeps /usage polled: true with a threshold, false at 0", () => {
  assert.equal(make().w.armed(), true);
  assert.equal(make({ threshold: 0 }).w.armed(), false);
});

test("a run whose sessions the cap folded is still the dearest launch it was", async () => {
  const d = doc();
  d.convos.push(convo("c1", 1, { kind: "fanout", runId: "run-9", label: "lint sweep" }));
  d.rest = [{
    repo: "/r/z", label: "z", launch: { kind: "fanout", runId: "run-9", label: "lint sweep" }, count: 40, agents: 0,
    totals: zeroTotals(), cost: cost(50), agentTotals: zeroTotals(), agentCost: cost(0), byModel: [], firstAt: T0, lastAt: NOW,
  }];
  d.cost = cost(75);
  const { w, sent } = make({ costWindow: async () => d });
  assert.equal(await w.observe(ok), true);
  assert.match(sent[0].body, /lint sweep · 2 repos/);
});

test("an unreadable usage reading is not evidence", async () => {
  const { w, sent } = make();
  assert.equal(await w.observe({ ok: false, weeklyPct: null }), false);
  assert.equal(await w.observe({ ok: true, weeklyPct: null }), false);
  assert.deepEqual(sent, []);
});

test("one observation at a time: a second call while the first is in flight returns false", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const { w, sent } = make({ costWindow: async () => { await gate; return doc(); } });
  const first = w.observe(ok);
  assert.equal(await w.observe(ok), false);
  release();
  assert.equal(await first, true);
  assert.equal(sent.length, 1);
});

test("a ledger holding undated records costs the push its top line, never the push (design round 4)", async () => {
  const { w, sent } = make({ costWindow: async () => ({ ...doc(), undated: 1 }) });
  assert.equal(await w.observe(ok), true);
  assert.doesNotMatch(sent[0].body, /Dearest in it/);
  assert.match(sent[0].body, /Nothing was paused\.$/);
});
