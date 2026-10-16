/**
 * One pass of the tick (`intents/ladder.ts`) over a real store with fake deps:
 * what fires, and what one pass claims for the rows behind a fire.
 *
 * This file was `pickhold.test.mjs`, the smart pick's pre-fire hold. The
 * smart pick was removed 2026-10-16 (26 real passes, 0 merges, 2 reorders);
 * its `pickHold` await became a bare microtask yield, and the ladder is still
 * re-asked on its far side. What is kept here is what still matters:
 *
 *  • a due row fires, and runs exactly one executor;
 *  • the second row of the same worktree, in the SAME pass, waits on `serial`
 *    — the claim is made before the next row is judged;
 *  • the automatic-session cap counts this pass's own fires exactly once.
 *
 * Fake deps and a temp root, the way `intentsched.test.mjs` does it: the store
 * is the thing under test, and every fact it reads is a function it was handed.
 */
import "../../../scripts/lib-tmuxiso.mjs"; // any tmux this test starts runs in a socket dir of its own
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { IntentManager } = await import("../dist/intents/manager.js");
const { backlogDraft } = await import("../dist/intents/adapters.js");

const REPO = "/tmp/waterplane-ladderpass-repo";
const OTHER = "/tmp/waterplane-ladderpass-other";

/** A store over its own temp root. */
function makeStore({ slots = 3, ...over } = {}) {
  const root = mkdtempSync(join(tmpdir(), "waterplane-ladderpass-"));
  const state = {
    root,
    sessions: [],
    /** The CAP, not the free count — see `autoSlotsFree` below. */
    slots,
    /**
     * Automatic sessions the fake host has open.
     *
     * This exists because the fake used to answer `state.slots` flat, hand-set
     * to 0 where a test needed pressure — which meant it never counted the
     * executor's OWN sessions, and that is precisely where the real
     * `autoSlotsFree()` gets its number (`BACKLOG_SESSIONS_MAX -
     * backlog.autoSessionCount()`, counted off sessions that already exist). A
     * flat fake cannot see a double count, and one shipped: see the cap-3 test
     * at the end of this file.
     *
     * Incremented SYNCHRONOUSLY by the `freshSession` executor, because that is
     * when the real one exists: `freshSession()` → `openItemSession()` →
     * `sessions.create()` all run before the executor's first `await`.
     */
    live: 0,
    /** EVERY executor call, whichever it was. */
    ran: [],
  };
  const exec = (name) => async (i) => {
    state.ran.push({ name, id: i.id });
    if (name === "freshSession") state.live++;
    return { ok: true, detail: "delivered" };
  };
  const store = new IntentManager({
    root,
    sessions: () => state.sessions,
    sessionAlive: (id) => state.sessions.some((s) => s.id === id && s.running !== false),
    repoSession: () => null,
    repoAnySession: () => false,
    autoSlotsFree: () => Math.max(0, state.slots - state.live),
    revivedSessionFor: () => null,
    diedAtLimit: () => false,
    stopCount: () => 0,
    isHooked: () => false,
    sessionIdleMs: () => 99_000,
    sessionHasPrompt: () => false,
    idleWindowMs: () => 1000,
    groupConcurrency: () => 6,
    knownDirs: async () => new Set([REPO, OTHER]),
    budgetBlocked: () => false,
    autoFire: () => true,
    logVerdict: () => "unknown",
    executors: {
      freshSession: exec("freshSession"),
      sweep: exec("sweep"),
      deliver: exec("deliver"),
      workItem: exec("workItem"),
      build: exec("build"),
      assess: exec("assess"),
    },
    onChange: () => {},
    ...over,
  });
  const done = () => { store.stop(); rmSync(root, { recursive: true, force: true }); };
  return { store, state, done };
}

/** An ordinary automatic work item: repo target, `idle` trigger, `serial`. */
const item = (id, { cwd = REPO, order = 0, label = "an item" } = {}) =>
  backlogDraft({ id, cwd, text: `do ${id}`, label, order });

const settle = () => new Promise((r) => setTimeout(r, 30));

// ── 1. a due row fires ──────────────────────────────────────────────────────

test("a due work item fires through exactly one executor", async () => {
  const { store, state, done } = makeStore();
  await store.reconcile();
  store.post(item("a"));
  store.kick();
  await settle();
  assert.deepEqual(state.ran.map((r) => r.name), ["freshSession"]);
  assert.equal(store.get("a").state, "done");
  done();
});

// ── 2. one pass claims before it judges the next row ────────────────────────

test("two due rows in one worktree, one pass: the second waits on serial", async () => {
  let armed = false;
  let pending;
  const { store, state, done } = makeStore({ autoFire: () => armed });
  // An executor that does not return — a row is `starting` for the whole of a
  // delivery, which is the window `serial` guards.
  store.deps.executors.freshSession = (i) => { state.ran.push({ name: "freshSession", id: i.id }); state.live++; return new Promise((r) => { pending = r; }); };
  await store.reconcile();
  store.post(item("a", { order: 0 }));
  store.post(item("b", { order: 1 }));
  armed = true;
  await store.pass();
  await settle();
  assert.deepEqual(state.ran.map((r) => r.id), ["a"], "one agent per worktree");
  assert.equal(store.get("b").state, "blocked");
  assert.equal(store.get("b").blockReason, "serial");
  pending?.({ ok: true, detail: "done" });
  done();
});

// ── 3. the cap counts this pass's own fires once ────────────────────────────

test("three rows, three repos, three slots: all three fire in one pass", async () => {
  // The live count already holds every session this pass opened (a fired row's
  // session exists synchronously), so a post-yield re-read that ALSO
  // subtracted this pass's fires put the figure one per fire below the truth.
  // The third row read `noSlot` with a slot genuinely free.
  let armed = false;
  const { store, state, done } = makeStore({ slots: 3, autoFire: () => armed });
  await store.reconcile();
  store.post(item("a", { cwd: "/tmp/waterplane-ladderpass-a", order: 0 }));
  store.post(item("b", { cwd: "/tmp/waterplane-ladderpass-b", order: 1 }));
  store.post(item("c", { cwd: "/tmp/waterplane-ladderpass-c", order: 2 }));
  armed = true;
  await store.pass();
  await settle();
  assert.deepEqual(state.ran.map((r) => r.id), ["a", "b", "c"]);
  done();
});

test("…and the cap still bites when it really is full", async () => {
  let armed = false;
  const { store, state, done } = makeStore({ slots: 2, autoFire: () => armed });
  await store.reconcile();
  store.post(item("a", { cwd: "/tmp/waterplane-ladderpass-a", order: 0 }));
  store.post(item("b", { cwd: "/tmp/waterplane-ladderpass-b", order: 1 }));
  store.post(item("c", { cwd: "/tmp/waterplane-ladderpass-c", order: 2 }));
  armed = true;
  await store.pass();
  await settle();
  assert.deepEqual(state.ran.map((r) => r.id), ["a", "b"]);
  assert.equal(store.get("c").blockReason, "noSlot");
  done();
});
