/**
 * P3 (`docs/plans/backend-parity-v3.md` C3): a plugin backend's context, from its
 * `ContextSource`, as a WINDOW, a SERIES and its COMPACTIONS — over a fake source
 * installed through `livesources.ts`, with no server and no CLI.
 *
 *  - window: a sample's stated `window` makes the percentage present; absent, the
 *    backend's configured window for THAT model is used as before, else nothing —
 *    never claude's table, never another model's.
 *  - series: each newer sample is kept, bounded by `MAX_SAMPLES`, persisted under
 *    `<state dir>/ctxseries/<id>.json` and served by `getContextSeries` for the live
 *    session, after a restart, and once the session has closed.
 *  - compactions: marked as `compact` events the way claude's log marks them.
 *  - claude: untouched — no file written, its series still comes off the log.
 */
import "../../../scripts/lib-tmuxiso.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { setLiveSourceLookup } = await import("../dist/livesources.js");
const { CtxSlice } = await import("../dist/sessions/ctxseries.js");
const { claudeBackend, registerBackend, unregisterBackend, primeBackendModels } = await import("../dist/backends/index.js");
const { hostStateDir } = await import("../dist/branddirs.js");
const { MAX_SAMPLES } = await import("@waterplane/shared");

const UP = () => ({ state: "up", since: 0 });
const attach = async () => ({ close: async () => {}, health: UP });

function fakeBackend(id, extra = {}) {
  return {
    ...claudeBackend, id, label: id,
    facts: { turns: [{ source: true }], dialogs: [{ source: true }], transcript: [{ source: true }], context: [{ source: true }], delivery: [{ source: true }] },
    sources: { attach, turns: {}, dialogs: {}, transcript: {}, context: {}, delivery: {} },
    healthScope: false,
    ...extra,
  };
}

/** The live lookup answers for `s1` with whatever `context` slot the case hands it. */
function install(context) {
  setLiveSourceLookup((id) => (id === "s1" ? { session: { id, cwd: "/tmp/x", spawnedAt: 0 }, sources: { attach, context }, health: UP } : null));
}

function session(backend, model) {
  return { backend, scrollback: "", info: { id: "s1", cwd: "/tmp/x", running: true, model } };
}

/** A slice over a fresh state root, and the core members it reads. */
function harness(s, root = mkdtempSync(join(tmpdir(), "waterplane-ctxsrc-"))) {
  const emitted = [];
  const closed = new Map();
  const core = {
    sessions: new Map(s ? [[s.info.id, s]] : []),
    closedRow: (id) => closed.get(id),
    detectClaudeId: () => null,
    emit: (ev) => emitted.push(ev), judgeBudget: () => false, noteContextHealth: () => {},
  };
  return { slice: new CtxSlice(core, root), core, closed, emitted, root };
}

let backend;
test.before(async () => {
  backend = fakeBackend("ctxsrc", {
    models: async () => ({ aliases: [], ids: ["big", "zero"], contextWindow: { big: 200000, zero: 0 } }),
  });
  registerBackend(backend);
  await primeBackendModels();
});
test.after(() => { unregisterBackend("ctxsrc"); setLiveSourceLookup(null); });

// ── Window ───────────────────────────────────────────────────────────────

test("a stated window makes the percentage present, and wins over the configured one", () => {
  const { slice } = harness();
  const s = session(backend, "mystery");
  install({ sample: () => ({ at: 1, usedTok: 32000, window: 128000 }) });
  slice.checkContext(s);
  assert.equal(s.info.contextUsedTok, 32000);
  assert.equal(s.info.contextTotalTok, 128000, "the CLI's own statement");
  assert.equal(s.info.contextLeft, 75);

  const b = session(backend, "big");
  install({ sample: () => ({ at: 2, usedTok: 50000, window: 100000 }) });
  harness(b).slice.checkContext(b);
  assert.equal(b.info.contextTotalTok, 100000, "stated beats the configuration for the same model");
  assert.equal(b.info.contextLeft, 50);
});

test("no stated window keeps today's answer: the configured window for THAT model, else absent", () => {
  const s = session(backend, "big");
  install({ sample: () => ({ at: 1, usedTok: 50000 }) });
  harness(s).slice.checkContext(s);
  assert.equal(s.info.contextTotalTok, 200000);
  assert.equal(s.info.contextLeft, 75);

  const u = session(backend, "claude-opus-5");
  install({ sample: () => ({ at: 1, usedTok: 50000 }) });
  harness(u).slice.checkContext(u);
  assert.equal(u.info.contextUsedTok, 50000);
  assert.equal(u.info.contextTotalTok, undefined, "a claude-looking id on another backend is not claude's window");
  assert.equal(u.info.contextLeft, undefined, "no window, no percentage — never 0%");
});

test("a sample that fails its shape is dropped WHOLE — no half kept, no window guessed", () => {
  for (const bad of [{ at: 1, usedTok: 1000, window: 0 }, { at: 1, usedTok: 1000, window: 1.5 }, { usedTok: 1000 }, { at: 1, usedTok: -1 }]) {
    const s = session(backend, "big");
    const { slice, emitted, root } = harness(s);
    install({ sample: () => bad });
    slice.checkContext(s);
    assert.equal(s.info.contextUsedTok, undefined, JSON.stringify(bad));
    assert.equal(s.info.contextLeft, undefined, JSON.stringify(bad));
    assert.equal(emitted.length, 0);
    assert.equal(slice.getContextSeries("s1"), null, "nothing kept");
    assert.equal(existsSync(join(hostStateDir(root), "ctxseries")), false);
  }
});

// ── Series ───────────────────────────────────────────────────────────────

test("each newer sample is a point; a repeat or an older stamp is not", () => {
  const s = session(backend, "big");
  const { slice } = harness(s);
  let cur = { at: 1000, usedTok: 10000 };
  install({ sample: () => cur });
  slice.checkContext(s);
  slice.checkContext(s);
  cur = { at: 2000, usedTok: 30000 };
  slice.checkContext(s);
  cur = { at: 1500, usedTok: 99999 };
  slice.checkContext(s);
  cur = { at: 3000, usedTok: 20000, window: 150000, model: "big" };
  const doc = slice.getContextSeries("s1");
  assert.deepEqual(doc.samples, [{ t: 1000, tok: 10000 }, { t: 2000, tok: 30000 }, { t: 3000, tok: 20000 }],
    "the graph's own read takes the newest sample too");
  assert.equal(doc.windowTok, 150000);
  assert.equal(doc.windowFrom, "source");
  assert.equal(doc.model, "big");
  assert.deepEqual(doc.events, []);
  assert.equal(doc.autoCompactTok, null);
  assert.equal(doc.truncated, false);
  for (const k of ["split", "turns", "usageTok", "cost", "compaction", "coldStarts", "claudeSessionId"]) {
    assert.equal(k in doc, false, `${k} is absent — nothing here counted it`);
  }
  assert.equal(slice.getContextSeries("s1", doc.updatedAt), "unchanged", "the poll contract");
});

test("a sample stamped later but equal in tokens, model and window is the same reading, not a new point", () => {
  const s = session(backend, "big");
  const { slice } = harness(s);
  let at = 1000;
  install({ sample: () => ({ at: at++, usedTok: 7000, window: 150000, model: "big" }) });
  for (let i = 0; i < 5; i++) slice.checkContext(s);
  assert.equal(slice.getContextSeries("s1").samples.length, 1);
  install({ sample: () => ({ at: at++, usedTok: 7001, window: 150000, model: "big" }) });
  slice.checkContext(s);
  assert.equal(slice.getContextSeries("s1").samples.length, 2, "a moved figure is a point");
});

test("the configured window is attributed as config, and no window is none", () => {
  const s = session(backend, "big");
  const { slice } = harness(s);
  install({ sample: () => ({ at: 1, usedTok: 5 }) });
  let doc = slice.getContextSeries("s1");
  assert.equal(doc.windowTok, 200000);
  assert.equal(doc.windowFrom, "config");
  install({ sample: () => ({ at: 2, usedTok: 5, model: "zero" }) });
  doc = slice.getContextSeries("s1");
  assert.equal(doc.windowTok, null);
  assert.equal(doc.windowFrom, "none");
});

test("the series is bounded by MAX_SAMPLES and keeps the newest point", () => {
  // Seeded at the cap off a kept file (a restart), so the case pays 300 writes rather than 1,500.
  const root = mkdtempSync(join(tmpdir(), "waterplane-ctxsrc-"));
  const dir = join(hostStateDir(root), "ctxseries");
  mkdirSync(dir, { recursive: true });
  const seeded = Array.from({ length: MAX_SAMPLES }, (_, i) => ({ t: i + 1, tok: ((i + 1) % 7) * 1000 }));
  writeFileSync(join(dir, "s1.json"), JSON.stringify({ samples: seeded, windowTok: 200000, windowFrom: "config", model: "big", updatedAt: 1 }));
  const s = session(backend, "big");
  const { slice } = harness(s, root);
  let at = MAX_SAMPLES;
  install({ sample: () => ({ at, usedTok: (at % 7) * 1000 }) });
  for (at = MAX_SAMPLES + 1; at <= MAX_SAMPLES + 300; at++) slice.checkContext(s);
  at = MAX_SAMPLES + 300; // the graph's own read asks the same sample again: no new point
  const doc = slice.getContextSeries("s1");
  assert.ok(doc.samples.length <= MAX_SAMPLES, `${doc.samples.length} ≤ ${MAX_SAMPLES}`);
  assert.ok(doc.samples.length > MAX_SAMPLES / 2);
  for (let i = 1; i < doc.samples.length; i++) assert.ok(doc.samples[i].t > doc.samples[i - 1].t, "still oldest first");
  assert.equal(doc.samples.at(-1).t, MAX_SAMPLES + 300, "the newest reading is always the last point");
  assert.ok(doc.samples.some((p) => p.tok === 6000) && doc.samples.some((p) => p.tok === 0), "the envelope survives the cut");
});

test("the series survives a restart and a close, read back off the kept file", () => {
  const s = session(backend, "big");
  const h = harness(s);
  install({ sample: () => ({ at: 1000, usedTok: 40000 }), compactions: () => [{ at: 900, preTok: 150000, postTok: 20000, auto: true }] });
  h.slice.checkContext(s);
  const before = h.slice.getContextSeries("s1");
  const dir = join(hostStateDir(h.root), "ctxseries");
  assert.deepEqual(readdirSync(dir).filter((n) => !n.startsWith(".")), ["s1.json"]);

  // A restart: a new slice and a new session object for the same id, the source silent.
  setLiveSourceLookup(null);
  const again = session(backend, "big");
  const r = harness(again, h.root);
  assert.deepEqual(r.slice.getContextSeries("s1"), before, "the same document");

  // Closed: no live session, the row remembers the backend.
  const c = harness(null, h.root);
  c.closed.set("s1", { id: "s1", cwd: "/tmp/x", launch: { backend: "ctxsrc" } });
  assert.deepEqual(c.slice.getContextSeries("s1"), before);
  // …and one whose plugin has since gone still has this host's own record.
  c.closed.set("s1", { id: "s1", cwd: "/tmp/x", launch: { backend: "gone-plugin" } });
  assert.deepEqual(c.slice.getContextSeries("s1"), before);
  assert.equal(c.slice.getContextSeries("nope"), null);
});

test("an id that is not a bare store name never becomes a path", () => {
  const s = { ...session(backend, "big"), info: { id: "../evil", cwd: "/tmp/x", running: true, model: "big" } };
  const h = harness(s);
  setLiveSourceLookup((id) => (id === "../evil" ? { session: { id, cwd: "/tmp/x", spawnedAt: 0 }, sources: { attach, context: { sample: () => ({ at: 1, usedTok: 5 }) } }, health: UP } : null));
  h.slice.checkContext(s);
  assert.equal(s.info.contextUsedTok, 5, "the gauge still reads");
  assert.equal(existsSync(join(hostStateDir(h.root), "ctxseries")), false, "nothing written");
  assert.equal(h.slice.getContextSeries("../evil").samples.length, 1, "the live series answers from memory");
});

// ── Compactions ──────────────────────────────────────────────────────────

test("compactions are marked as claude's are; absent fields stay absent", () => {
  const s = session(backend, "big");
  const { slice } = harness(s);
  let comps = [
    { at: 500, preTok: 150000, postTok: 20000, auto: true },
    { at: 700, auto: false },
    { at: 800 },
    { at: 900, preTok: 160000, auto: true, extra: "dropped" },
  ];
  install({ sample: () => ({ at: 1000, usedTok: 30000 }), compactions: () => comps });
  let doc = slice.getContextSeries("s1");
  assert.deepEqual(doc.events, [
    { kind: "compact", t: 500, trigger: "auto", preTok: 150000, postTok: 20000 },
    { kind: "compact", t: 700, trigger: "manual" },
    { kind: "compact", t: 800 },
    { kind: "compact", t: 900, trigger: "auto", preTok: 160000 },
  ]);
  assert.equal(doc.autoCompactTok, 160000, "the newest auto compaction's own preTok");
  assert.equal("compaction" in doc, false, "no ledger: nothing priced them");

  // A failing answer is dropped whole and the last good one stands; null changes nothing.
  comps = [{ at: 950 }, { at: 940 }];
  doc = slice.getContextSeries("s1");
  assert.equal(doc.events.length, 4);
  comps = null;
  assert.equal(slice.getContextSeries("s1").events.length, 4);
  // [] is "none happened" — an answer.
  comps = [];
  doc = slice.getContextSeries("s1");
  assert.deepEqual(doc.events, []);
  assert.equal(doc.autoCompactTok, null);
});

test("a source with no compactions() slot keeps no events", () => {
  const s = session(backend, "big");
  install({ sample: () => ({ at: 1, usedTok: 5 }) });
  assert.deepEqual(harness(s).slice.getContextSeries("s1").events, []);
});

// ── Claude is untouched ──────────────────────────────────────────────────

test("claude: no source series is asked, no file is written", () => {
  let asked = 0;
  install({ sample: () => { asked++; return { at: 1, usedTok: 5 }; } });
  const s = session(claudeBackend, "claude-opus-5");
  const { slice, root } = harness(s);
  // claude has no context SOURCE, so `getContextSeries` goes to the log (`logFor` → no id here).
  assert.equal(slice.getContextSeries("s1"), null);
  assert.equal(asked, 0);
  assert.equal(existsSync(join(hostStateDir(root), "ctxseries")), false);
  setLiveSourceLookup(null);
});

test("a kept file for a CLAUDE id is never read in place of the log", () => {
  const root = mkdtempSync(join(tmpdir(), "waterplane-ctxsrc-"));
  const dir = join(hostStateDir(root), "ctxseries");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "s1.json"), JSON.stringify({ samples: [{ t: 1, tok: 5 }], windowTok: null, windowFrom: "none", updatedAt: 1 }));
  const c = harness(null, root);
  c.closed.set("s1", { id: "s1", cwd: "/tmp/x" }); // no launch ⇒ claude
  assert.equal(c.slice.getContextSeries("s1"), null, "claude's closed row asks the log, which has no id here");
});
