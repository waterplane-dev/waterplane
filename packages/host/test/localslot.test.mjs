/**
 * The local-model gate (`localslot.ts`, R-intent-local-001): which sessions
 * and rows count against the local cap, the model loaded before an automatic
 * fire, the sidecar's swap guard — and the ladder over a REAL store with fake
 * deps (`ladderpass.test.mjs`'s harness), where the at-most-once and the
 * per-pass decrement are what is under test.
 */
import "../../../scripts/lib-tmuxiso.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { IntentManager } = await import("../dist/intents/manager.js");
const { backlogDraft } = await import("../dist/intents/adapters.js");
const {
  LocalModelGate, installLocalSlots, isLocalLaunch, isLoopbackUrl, loadFailureText, localModelHold,
  localSlotReading, localStartNotice, localSwapGuard, READY_FRESH_MS, RETRY_MS,
} = await import("../dist/localslot.js");

const QWEN = { backend: "claude-local", model: "qwen3:30b" };
const isLocal = (backend, model) => backend === "claude-local" && !!model;

const row = (over = {}) => ({
  id: "r1", cwd: "/repo", payload: { kind: "prompt", steps: ["go"] },
  target: { kind: "repo", fresh: true }, trigger: { kind: "now" },
  state: "queued", createdAt: 1, auto: true, launch: QWEN, ...over,
});

// ── locality ────────────────────────────────────────────────────────────────

test("locality is a backend fact: claude-local on a loopback Ollama is local, claude never is", () => {
  // WATERPLANE_OLLAMA_URL unset in the test env ⇒ 127.0.0.1.
  assert.equal(isLocalLaunch("claude-local", "qwen3:30b"), true);
  assert.equal(isLocalLaunch("claude-local", undefined), false, "no model, nothing to load or count");
  assert.equal(isLocalLaunch(undefined, "opus"), false);
  assert.equal(isLocalLaunch("claude", "sonnet"), false);
  assert.equal(isLocalLaunch("no-such-backend", "x"), false, "unknown is never local");
  assert.equal(isLoopbackUrl("http://localhost:11434"), true);
  assert.equal(isLoopbackUrl("http://gpu-box.tailnet:11434"), false);
});

// ── the reading ─────────────────────────────────────────────────────────────

test("a local session mid-turn holds the cap; an idle one does not; a hosted one never", () => {
  const sessions = [
    { id: "a", running: true, turnActive: true, ...QWEN, name: "fix the parser" },
    { id: "b", running: true, turnActive: false, ...QWEN },
    { id: "c", running: true, turnActive: true, backend: "claude", model: "opus" },
  ];
  const r = localSlotReading({ max: 1, sessions, rows: [row()], isLocal });
  assert.deepEqual(r.facts.working, [{ id: "a", name: "fix the parser" }]);
  assert.equal(r.pass.free, 0);
  assert.deepEqual([...r.pass.rows], ["r1"]);
  assert.deepEqual([...r.pass.busy], ["a"]);
});

test("a local row starting or running counts once, with or without its session mid-turn", () => {
  const sessions = [{ id: "s9", running: true, turnActive: true, ...QWEN }];
  const rows = [
    row({ id: "x", state: "starting" }),                       // spawned, no turn yet
    row({ id: "y", state: "running", sessionId: "s9" }),       // the same session as above: not twice
    row({ id: "z" }),                                          // waiting
  ];
  const r = localSlotReading({ max: 2, sessions, rows, isLocal });
  assert.equal(r.facts.working.length, 2);
  assert.equal(r.pass.free, 0);
  assert.deepEqual([...r.pass.rows], ["z"]);
});

test("only automatic rows are gated; a hosted row, a manual one and a sweep parent are not", () => {
  const rows = [
    row({ id: "auto" }),
    row({ id: "hand", auto: false }),
    row({ id: "hosted", launch: { model: "opus" } }),
    row({ id: "sweep", target: { kind: "repos", dirs: ["/a"] } }),
    row({ id: "target", auto: undefined, origin: "fanout" }),
  ];
  const r = localSlotReading({ max: 1, sessions: [], rows, isLocal });
  assert.deepEqual([...r.pass.rows].sort(), ["auto", "target"]);
});

test("no cap means every local row may go; the start being told about is not counted", () => {
  const sessions = [{ id: "a", running: true, turnActive: true, ...QWEN }];
  assert.ok(localSlotReading({ max: null, sessions, rows: [], isLocal }).pass.free > 1000);
  const r = localSlotReading({ max: 1, sessions, rows: [], isLocal }, { sessionId: "a" });
  assert.equal(r.facts.working.length, 0);
});

// ── the model, loaded ───────────────────────────────────────────────────────

function gateWith(answers) {
  let t = 1_000_000;
  const calls = [];
  let kicks = 0;
  const gate = new LocalModelGate({
    load: async (model) => { calls.push(model); return answers.shift() ?? { ok: true }; },
    now: () => t, settled: () => { kicks++; }, url: () => "http://127.0.0.1:11434",
  });
  return { gate, calls, advance: (ms) => { t += ms; }, kicks: () => kicks };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

test("the first ask starts ONE load and holds; the row goes once it is loaded", async () => {
  const g = gateWith([{ ok: true }]);
  assert.match(g.gate.check("qwen3"), /loading qwen3 on Ollama/);
  assert.match(g.gate.check("qwen3"), /loading/, "a second row asks the same load");
  await flush();
  assert.deepEqual(g.calls, ["qwen3"], "one load, whichever rows asked");
  assert.equal(g.kicks(), 1, "the tick is re-asked when it ends");
  assert.equal(g.gate.check("qwen3"), null);
  g.advance(READY_FRESH_MS + 1);
  assert.match(g.gate.check("qwen3"), /loading/, "a stale reading asks the runner again");
});

test("unreachable and missing hold the row with a named reason and retry after the gap — never another model", async () => {
  const g = gateWith([
    { ok: false, kind: "unreachable", error: "ECONNREFUSED" },
    { ok: false, kind: "missing", error: "no such model" },
    { ok: true },
  ]);
  g.gate.check("qwen3"); await flush();
  assert.match(g.gate.check("qwen3"), /Ollama is not reachable at http:\/\/127\.0\.0\.1:11434/);
  assert.deepEqual(g.calls, ["qwen3"], "no retry inside the gap");
  g.advance(RETRY_MS + 1);
  g.gate.check("qwen3"); await flush();
  assert.match(g.gate.check("qwen3"), /qwen3 is not on this desktop's Ollama \(run `ollama pull qwen3`\)/);
  g.advance(RETRY_MS + 1);
  g.gate.check("qwen3"); await flush();
  assert.equal(g.gate.check("qwen3"), null);
  assert.deepEqual(g.calls, ["qwen3", "qwen3", "qwen3"], "only ever the model the item asked for");
});

test("a load past its bound says so in seconds", () => {
  assert.match(loadFailureText("qwen3", "timeout", "u", "x", 180_000), /did not finish loading within 180 s/);
});

// ── the installed readers: the person's notice and the sidecar guard ────────

test("a person's own local start past the cap is told, and the sidecar never swaps the model mid-turn", async () => {
  const sessions = [{ id: "a", running: true, turnActive: true, ...QWEN, name: "nightly" }];
  let setting = "1";
  installLocalSlots({ sessions: () => sessions, rows: () => [], setting: () => setting, kick: () => {} },
    { load: async () => ({ ok: true }) });
  assert.match(localStartNotice(QWEN, { sessionId: "new" }), /^another local-model session is working \(nightly\)/);
  assert.equal(localStartNotice({ model: "opus" }, { sessionId: "new" }), undefined, "a hosted start is none of this");
  setting = "2";
  assert.equal(localStartNotice(QWEN, { sessionId: "new" }), undefined, "under the cap, nothing to say");

  assert.match(localSwapGuard("http://localhost:11434/v1", "gemma4:e4b"), /working on qwen3:30b .* skipped/);
  assert.equal(localSwapGuard("http://localhost:11434/v1", "qwen3:30b"), null, "same model: no swap");
  assert.equal(localSwapGuard("http://other-box:11434/v1", "gemma4:e4b"), null, "another runner");
  sessions[0].turnActive = false;
  assert.equal(localSwapGuard("http://localhost:11434/v1", "gemma4:e4b"), null, "nothing working");

  // The model hold answers only for a backend with a local runner.
  assert.match(localModelHold(row()), /loading qwen3:30b/);
  assert.equal(localModelHold(row({ launch: { model: "opus" } })), null);
});

// ── the ladder, over a real store ───────────────────────────────────────────

function makeStore(t, { max = 1, sessions = [], hold = () => null } = {}) {
  const root = mkdtempSync(join(tmpdir(), "waterplane-localslot-"));
  const state = { ran: [], release: new Map() };
  let store;
  const exec = async (i) => {
    state.ran.push(i.id);
    // Stays `starting` until the test releases it — a local turn in flight.
    await new Promise((r) => state.release.set(i.id, r));
    return { ok: true, detail: "delivered" };
  };
  const reading = () => localSlotReading({ max, sessions, rows: store.list(), isLocal });
  store = new IntentManager({
    root,
    sessions: () => [],
    sessionAlive: () => false,
    repoSession: () => null,
    repoAnySession: () => false,
    autoSlotsFree: () => 9,
    revivedSessionFor: () => null,
    diedAtLimit: () => false,
    stopCount: () => 0,
    isHooked: () => false,
    sessionIdleMs: () => 99_000,
    sessionHasPrompt: () => false,
    idleWindowMs: () => 1000,
    groupConcurrency: () => 6,
    knownDirs: async () => new Set(),
    budgetBlocked: () => false,
    autoFire: () => true,
    logVerdict: () => "unknown",
    executors: { freshSession: exec, sweep: exec, deliver: exec, workItem: exec, build: exec, assess: exec },
    onChange: () => {},
    localSlots: () => reading().pass,
    localSlotsDetail: () => undefined,
    localHold: (r) => hold(r),
  });
  // Close on EVERY path: an assertion that throws must not leave an executor
  // pending or the store's tick armed, or the file's process never exits.
  t.after(async () => {
    for (const r of state.release.values()) r();
    await new Promise((r) => setTimeout(r, 10));
    store.stop();
    rmSync(root, { recursive: true, force: true });
  });
  return { store, state };
}
const settle = () => new Promise((r) => setTimeout(r, 30));
const item = (id, cwd, launch = QWEN) => ({ ...backlogDraft({ id, cwd, text: `do ${id}`, label: id, order: 0, launch }) });

test("two local items due in two repos in ONE pass: one starts, the other waits naming the local model", async (t) => {
  const { store, state } = makeStore(t);
  // Both posted before the first pass, so ONE pass sees both.
  store.post(item("a", "/tmp/wp-ls-a"));
  store.post(item("b", "/tmp/wp-ls-b"));
  await store.reconcile();
  store.kick();
  await settle();
  assert.deepEqual(state.ran, ["a"], "at most one local turn starts");
  assert.equal(store.get("b").state, "blocked");
  assert.equal(store.get("b").blockReason, "localModel");
  // A hosted item in a third repo is none of the cap's business.
  store.post(item("h", "/tmp/wp-ls-h", { model: "opus" }));
  store.kick();
  await settle();
  assert.deepEqual(state.ran, ["a", "h"]);
  // a finishes ⇒ b goes, once.
  state.release.get("a")();
  await settle();
  store.kick();
  await settle();
  assert.deepEqual(state.ran, ["a", "h", "b"], "b fires exactly once");
});

test("a model that is not loaded holds the row and fires NOTHING; loaded, it goes", async (t) => {
  let loaded = false;
  const { store, state } = makeStore(t, { max: 2, hold: () => (loaded ? null : "waiting for the local model — loading qwen3:30b on Ollama") });
  await store.reconcile();
  store.post(item("a", "/tmp/wp-ls-a"));
  store.kick();
  await settle();
  assert.deepEqual(state.ran, []);
  assert.equal(store.get("a").blockReason, "localModel");
  assert.match(store.get("a").blockDetail, /loading qwen3:30b/);
  loaded = true;
  store.kick();
  await settle();
  assert.deepEqual(state.ran, ["a"]);
});

test("a person's run-now is not held by the cap — it is told instead", async (t) => {
  const { store, state } = makeStore(t);
  // Both posted before the first pass, so ONE pass sees both.
  store.post(item("a", "/tmp/wp-ls-a"));
  store.post(item("b", "/tmp/wp-ls-b"));
  await store.reconcile();
  store.kick();
  await settle();
  assert.equal(store.get("b").blockReason, "localModel");
  // Not awaited: `runNow` resolves when the executor does, and this one is a
  // local turn in flight until `t.after` releases it.
  void store.runNow("b");
  await settle();
  assert.deepEqual(state.ran, ["a", "b"]);
});
