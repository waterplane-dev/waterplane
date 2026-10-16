/**
 * The usage-source registry (`usagesources.ts`) over a fake clock, fake timers and fake logs:
 * claude adapted FIRST from `UsageChecker.get()`, a probe answering null is ABSENT, a throw keeps
 * the last reading until its reset passes, a reading the core cannot vouch for is vetted down, a
 * duplicate or core-owned source throws naming it, polling arms and disarms per probe, a fresh ask
 * respects the TTL, a boot re-offer is `remembered` only while a reset is ahead, and every change
 * reaches `onUpdate` — which is what `main.ts`'s one `usage.status` publisher hangs off.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

const { UsageSourceRegistry, vetReading, MIN_PROBE_EVERY_MS, DEFAULT_PROBE_EVERY_MS } = await import("../dist/usagesources.js");

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const T0 = Date.UTC(2026, 9, 15, 12);

const CLAUDE = { ok: true, sessionPct: 42, weeklyPct: 61, sessionResetAt: T0 + 3 * 60 * MIN, weeklyResetAt: T0 + 3 * DAY, checkedAt: T0 - MIN };
const copilot = (pct, resetAt = T0 + 17 * DAY, checkedAt) => ({
  source: "copilot", label: "Copilot", checkedAt: checkedAt ?? T0,
  windows: [{ id: "chat", unit: "mo", pct, used: 9, limit: 200, unitName: "credits", resetAt }],
});

function harness(over = {}) {
  let now = T0;
  const timers = new Map(); let nextId = 1;
  const updates = []; const logs = []; const notes = [];
  const fakeLog = { rows: [], note: (r) => notes.push(r), last: () => fakeLog.rows.at(-1) ?? null, read: () => ({ source: "copilot", samples: [], keptFrom: null, cap: 1, retainMs: 1 }), flush: () => { fakeLog.flushed = (fakeLog.flushed ?? 0) + 1; } };
  let claude = CLAUDE;
  const reg = new UsageSourceRegistry({
    claude: () => claude,
    onUpdate: (s, r) => updates.push([s, r]),
    openLog: over.openLog ?? (() => fakeLog),
    now: () => now,
    ttlMs: 8 * MIN, failTtlMs: MIN, timeoutMs: over.timeoutMs ?? 1000,
    log: (m) => logs.push(m),
    timers: { set: (fn, ms) => { const id = nextId++; timers.set(id, { fn, ms }); return id; }, clear: (id) => timers.delete(id) },
  });
  return {
    reg, updates, logs, notes, timers, fakeLog,
    tick: (ms) => { now += ms; }, at: () => now,
    setClaude: (c) => { claude = c; },
  };
}

/** A probe whose next answer the test sets; counts its calls. */
function scripted() {
  const p = { calls: 0, next: null, probe: async () => { p.calls++; const n = p.next; if (n instanceof Error) throw n; return typeof n === "function" ? n() : n; } };
  return p;
}

test("readings(): claude FIRST, adapted from UsageChecker.get(); no probe ⇒ exactly claude's", () => {
  const h = harness();
  assert.deepEqual(h.reg.readings(), [{ source: "claude", label: "Claude", backend: "claude", checkedAt: CLAUDE.checkedAt,
    windows: [{ id: "session", unit: "5h", pct: 42, resetAt: CLAUDE.sessionResetAt }, { id: "week", unit: "wk", pct: 61, resetAt: CLAUDE.weeklyResetAt }] }]);
  h.setClaude({ ok: false, sessionPct: null, weeklyPct: null, sessionResetAt: null, weeklyResetAt: null, checkedAt: 0 });
  assert.deepEqual(h.reg.readings(), [], "a claude reading that did not parse is absent, never pct:null");
});

test("a probe's reading follows claude's, and its change reaches onUpdate once", async () => {
  const h = harness(); const p = scripted();
  h.reg.register({ source: "copilot", label: "Copilot", probe: p.probe });
  p.next = copilot(5);
  await h.reg.refresh();
  assert.deepEqual(h.reg.readings().map((r) => r.source), ["claude", "copilot"]);
  assert.equal(h.reg.readings()[1].windows[0].pct, 5);
  assert.equal(h.updates.length, 1);
  assert.equal(h.notes.length, 1, "a fresh reading is offered to the source's log");
  p.next = copilot(5);
  await h.reg.refresh();
  assert.equal(h.updates.length, 1, "an identical reading publishes nothing");
});

test("null is ABSENT: the source draws nothing, and it says so once", async () => {
  const h = harness(); const p = scripted();
  h.reg.register({ source: "copilot", label: "Copilot", probe: p.probe });
  p.next = copilot(5); await h.reg.refresh();
  p.next = null; await h.reg.refresh();
  assert.deepEqual(h.reg.readings().map((r) => r.source), ["claude"]);
  assert.deepEqual(h.updates.at(-1), ["copilot", null]);
});

test("a throw keeps the last reading until its reset passes; logged once until it recovers", async () => {
  const h = harness(); const p = scripted();
  h.reg.register({ source: "copilot", label: "Copilot", probe: p.probe });
  p.next = copilot(5, T0 + 2 * DAY); await h.reg.refresh();
  p.next = new Error("network down");
  await h.reg.refresh(); await h.reg.refresh();
  assert.equal(h.reg.readings()[1].windows[0].pct, 5, "kept across the throw");
  assert.equal(h.logs.length, 1);
  assert.match(h.logs[0], /copilot.*network down/);
  h.tick(2 * DAY + 1);
  assert.deepEqual(h.reg.readings().map((r) => r.source), ["claude"], "past its reset the source is gone");
  assert.deepEqual(h.reg.readings()[0].windows.map((w) => w.id), ["week"], "claude.s 5-hour window rolled over too");
});

test("a kept window that names NO reset is dropped 24 h past its last good probe; a named reset still rules", async () => {
  const h = harness(); const p = scripted();
  h.reg.register({ source: "copilot", label: "Copilot", probe: p.probe });
  const both = { ...copilot(5, null), windows: [copilot(5, null).windows[0], { id: "premium", unit: "mo", pct: 30, resetAt: T0 + 3 * DAY }] };
  p.next = both; await h.reg.refresh();
  p.next = new Error("gh: not signed in");
  h.tick(DAY - MIN); await h.reg.refresh();
  assert.deepEqual(h.reg.readings()[1].windows.map((w) => w.id), ["chat", "premium"], "under 24 h both are kept");
  const before = h.updates.length;
  h.tick(2 * MIN); await h.reg.refresh();
  assert.deepEqual(h.reg.readings()[1].windows.map((w) => w.id), ["premium"], "the unnamed window is gone, the named one stays");
  assert.equal(h.updates.length, before + 1, "the drop is published, not left on the phone");
  assert.deepEqual(h.updates.at(-1)[1].windows.map((w) => w.id), ["premium"]);
});

test("a reading whose only window names no reset goes ABSENT after 24 h; claude's reading is not aged", async () => {
  const h = harness(); const p = scripted();
  h.reg.register({ source: "copilot", label: "Copilot", probe: p.probe });
  p.next = copilot(5, null); await h.reg.refresh();
  h.setClaude({ ...CLAUDE, checkedAt: T0 - 2 * DAY, sessionResetAt: null, weeklyResetAt: null });
  h.tick(DAY);
  assert.deepEqual(h.reg.readings().map((r) => r.source), ["claude"], "no copilot: absent beats a day-old figure");
  p.next = new Error("token revoked"); await h.reg.refresh();
  assert.equal(h.updates.at(-1)[0], "copilot");
  assert.equal(h.updates.at(-1)[1], null);
  const { readingAfterAge } = await import("../dist/usagesources.js");
  const r = copilot(5, null, T0);
  assert.equal(readingAfterAge(r, T0 + DAY - 1), r, "the same object while young");
});

test("a probe slower than the timeout counts as a throw", async () => {
  const h = harness({ timeoutMs: 20 });
  h.reg.register({ source: "slow", label: "Slow", probe: () => new Promise(() => {}) });
  await h.reg.refresh();
  assert.match(h.logs[0], /slow.*no answer within/);
});

test("vetting: identity is the definition's; bad windows dropped; nothing left is null", () => {
  const def = { source: "copilot", label: "Copilot", backend: "copilot", probe: async () => null };
  const r = vetReading(def, { source: "claude", label: "Fake", checkedAt: T0, windows: [
    { id: "chat", unit: "mo", pct: 5, resetAt: T0 + DAY },
    { id: "big", unit: "mo", pct: 4300, resetAt: null },
    { id: "nounit", pct: 5, resetAt: null },
    { id: "toolong", unit: "month", pct: 5, resetAt: null },
    { id: "count", unit: "mo", pct: null, used: 50, limit: 200, resetAt: null },
    { id: "nolimit", unit: "mo", pct: null, used: 50, resetAt: null },
  ] }, T0);
  assert.equal(r.source, "copilot"); assert.equal(r.label, "Copilot"); assert.equal(r.backend, "copilot");
  assert.deepEqual(r.windows.map((w) => w.id), ["chat", "count"]);
  assert.equal(vetReading(def, { windows: [{ id: "x", unit: "mo", pct: null, resetAt: null }] }, T0), null);
  assert.equal(vetReading(def, "nope", T0), null);
  assert.equal(vetReading(def, { checkedAt: T0 + DAY, windows: [{ id: "chat", unit: "mo", pct: 1, resetAt: null }] }, T0).checkedAt, T0, "a future instant is not believed");
});

test("register refuses in words: core's id, a duplicate, a malformed id, no label, no probe", () => {
  const h = harness();
  const probe = async () => null;
  assert.throws(() => h.reg.register({ source: "claude", label: "C", probe }), /"claude" is core's/);
  h.reg.register({ source: "copilot", label: "Copilot", probe });
  assert.throws(() => h.reg.register({ source: "copilot", label: "Copilot", probe }), /"copilot" is already registered/);
  assert.throws(() => h.reg.register({ source: "Bad Id", label: "B", probe }), /not short lowercase/);
  assert.throws(() => h.reg.register({ source: "nolabel", label: "", probe }), /needs a label/);
  assert.throws(() => h.reg.register({ source: "noprobe", label: "N" }), /needs a probe/);
});

test("unregister drops the source and publishes its absence; a late answer does not resurrect it", async () => {
  const h = harness(); let release;
  const p = scripted();
  const off = h.reg.register({ source: "copilot", label: "Copilot", probe: p.probe });
  p.next = copilot(5); await h.reg.refresh();
  p.next = () => new Promise((r) => { release = r; });
  const pending = h.reg.refresh();
  off();
  assert.deepEqual(h.updates.at(-1), ["copilot", null]);
  release(copilot(9)); await pending;
  assert.deepEqual(h.reg.readings().map((r) => r.source), ["claude"]);
  assert.deepEqual(h.reg.sources(), []);
});

test("one probe in flight per source: a second ask joins the first", async () => {
  const h = harness(); const p = scripted(); let release;
  h.reg.register({ source: "copilot", label: "Copilot", probe: p.probe });
  p.next = () => new Promise((r) => { release = r; });
  const a = h.reg.refresh(); const b = h.reg.refresh("copilot");
  release(copilot(5)); await Promise.all([a, b]);
  assert.equal(p.calls, 1);
});

test("a fresh ask answers from a reading younger than the TTL, and does not re-ask a failure within a minute", async () => {
  const h = harness(); const p = scripted();
  h.reg.register({ source: "copilot", label: "Copilot", probe: p.probe });
  p.next = copilot(5);
  await h.reg.refreshFresh(); assert.equal(p.calls, 1);
  h.tick(5 * MIN); await h.reg.refreshFresh(); assert.equal(p.calls, 1, "younger than the TTL");
  h.tick(4 * MIN); p.next = copilot(6, undefined, h.at()); await h.reg.refreshFresh(); assert.equal(p.calls, 2);
  p.next = null; h.tick(9 * MIN); await h.reg.refreshFresh(); assert.equal(p.calls, 3);
  h.tick(30_000); await h.reg.refreshFresh(); assert.equal(p.calls, 3, "an empty answer is not re-asked within a minute");
  h.tick(31_000); await h.reg.refreshFresh(); assert.equal(p.calls, 4);
  await h.reg.refresh(); assert.equal(p.calls, 5, "a plain refresh always asks");
});

test("setPolling arms one timer per probe at its period (floor 60 s), and disarms", async () => {
  const h = harness();
  h.reg.register({ source: "a", label: "A", everyMs: 5_000, probe: async () => null });
  h.reg.register({ source: "b", label: "B", probe: async () => null });
  assert.equal(h.timers.size, 0, "off by default");
  h.reg.setPolling(true);
  assert.deepEqual([...h.timers.values()].map((t) => t.ms).sort((x, y) => x - y), [MIN_PROBE_EVERY_MS, DEFAULT_PROBE_EVERY_MS]);
  h.reg.register({ source: "c", label: "C", everyMs: 2 * MIN, probe: async () => null });
  assert.equal(h.timers.size, 3, "a probe registered while polling is armed at once");
  h.reg.setPolling(false);
  assert.equal(h.timers.size, 0);
  assert.equal(h.reg.isPolling(), false);
});

test("a poll tick asks the probe", async () => {
  const h = harness(); const p = scripted();
  h.reg.register({ source: "copilot", label: "Copilot", probe: p.probe });
  p.next = copilot(5);
  h.reg.setPolling(true);
  await new Promise((r) => setImmediate(r));
  const before = p.calls;
  [...h.timers.values()][0].fn();
  await new Promise((r) => setImmediate(r));
  assert.equal(p.calls, before + 1);
});

test("boot re-offer: the last kept row is remembered while its reset is ahead, and then re-asked", async () => {
  const h = harness();
  h.fakeLog.rows.push({ t: T0 - 60 * MIN, w: [
    { id: "chat", pct: 5, resetAt: T0 + DAY, unit: "mo", used: 9, limit: 200, unitName: "credits" },
    { id: "premium", pct: 10, resetAt: T0 - MIN, unit: "mo" }, // reset passed: not claimed
    { id: "nodate", pct: 10, resetAt: null, unit: "mo" }, // no reset named: not claimed
  ] });
  const p = scripted();
  h.reg.register({ source: "copilot", label: "Copilot", probe: p.probe });
  const r = h.reg.readings()[1];
  assert.equal(r.remembered, true);
  assert.equal(r.checkedAt, T0 - 60 * MIN, "the row's own instant, never now");
  assert.deepEqual(r.windows.map((w) => w.id), ["chat"]);
  assert.equal(r.windows[0].used, 9);
  assert.deepEqual(h.updates.at(-1)[0], "copilot");
  p.next = copilot(6);
  await h.reg.refreshFresh();
  assert.equal(p.calls, 1, "a remembered reading is never fresh enough");
  assert.equal(h.reg.readings()[1].remembered, undefined);
});

test("history: claude and malformed ids are none; an unregistered source only if a log exists", () => {
  const opened = [];
  const h = harness({ openLog: (s, mustExist) => { opened.push([s, mustExist]); return mustExist ? null : { note() {}, last: () => null, read: () => ({ source: s, samples: [], keptFrom: null, cap: 1, retainMs: 1 }), flush() {} }; } });
  assert.equal(h.reg.history("claude"), null);
  assert.equal(h.reg.history("../x"), null);
  assert.equal(h.reg.history("gone"), null);
  assert.deepEqual(opened.at(-1), ["gone", true]);
  h.reg.register({ source: "copilot", label: "Copilot", probe: async () => null });
  assert.equal(h.reg.history("copilot").source, "copilot");
});

test("flush reaches every opened log", async () => {
  const h = harness(); const p = scripted();
  h.reg.register({ source: "copilot", label: "Copilot", probe: p.probe });
  h.reg.flush();
  assert.equal(h.fakeLog.flushed, 1);
});
