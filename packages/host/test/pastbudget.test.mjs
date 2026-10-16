/**
 * *Let past the budget* — `Intent.pastBudget`, set by `intent.waive`.
 *
 * The incident: the re-time sheet's bulk *run all 4 now, past the budget* sent
 * `intent.run` per row, `runNow` skips the WHOLE ladder, and four queued rows in
 * one repo (holdForHost, serial) started in parallel in one
 * worktree. The waiver lifts rung 2 and nothing else, so every test here is the
 * budget being over the ceiling (`budgetBlocked: () => true`) and some rung
 * BELOW it still doing its job.
 *
 * `freshSession` is DEFERRED — a row it starts stays `starting` until the test
 * releases it, because a running row is what `serial` and `hostBusy` are made
 * of. The harness is `ladderpass.test.mjs`'s.
 *
 * The waiver is SCOPED: `waive()` stamps `{ until }`, the latest reset among
 * the ceilings `budgetOver()` reports tripped, and rung 2 honours it only
 * before then. `state.resetAt` is that reset here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { IntentManager } = await import("../dist/intents/manager.js");
const { backlogDraft } = await import("../dist/intents/adapters.js");
const { workRoutes } = await import("../dist/routes/work.js");

const REPO = "/tmp/waterplane-pastbudget-repo";
const OTHER = "/tmp/waterplane-pastbudget-other";

function makeStore({ slots = 3, answer, ...over } = {}) {
  const root = mkdtempSync(join(tmpdir(), "waterplane-pastbudget-"));
  const state = {
    root, sessions: [], slots, live: 0,
    /** The tripped ceiling's reset — what a waiver granted now is scoped to. */
    resetAt: Date.now() + 3 * 3_600_000,
    /** `false` = the budget holds nothing (`budgetOver()` is empty). */
    over: true,
    /** Every executor call. */
    ran: [],
    /** Resolvers for the fresh sessions still "running", by row id. */
    open: new Map(),
  };
  const store = new IntentManager({
    root,
    sessions: () => state.sessions,
    sessionAlive: () => false,
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
    budgetBlocked: () => true,
    budgetDetail: () => "paused — over the budget",
    budgetOver: () => (state.over ? [{ which: "session", pct: 90, max: 75, resetAt: state.resetAt }] : []),
    autoFire: () => true,
    logVerdict: () => "unknown",
    executors: {
      freshSession: (i) => {
        state.ran.push(i.id);
        if (answer) return Promise.resolve(answer(i));
        state.live++;
        return new Promise((r) => state.open.set(i.id, () => { state.live--; r({ ok: true, detail: "delivered" }); }));
      },
      sweep: async () => ({ ok: true, detail: "x" }),
      deliver: async () => ({ ok: true, detail: "x" }),
      workItem: async () => ({ ok: true, detail: "x" }),
      build: async () => ({ ok: true, detail: "x" }),
      assess: async () => ({ ok: true, detail: "x" }),
    },
    onChange: () => {},
    ...over,
  });
  const done = () => { store.stop(); rmSync(root, { recursive: true, force: true }); };
  const release = async (id) => { state.open.get(id)?.(); state.open.delete(id); await settle(); };
  return { store, state, done, release };
}

/** An automatic work item: repo target, `serial`, optionally holding for the host. */
const item = (id, { cwd = REPO, order = 0, holdForHost = true } = {}) =>
  backlogDraft({ id, cwd, text: `do ${id}`, order, holdForHost });

const settle = () => new Promise((r) => setTimeout(r, 30));
// Every post kicks a pass of its own, and a kick while a pass is running is a
// no-op — so each test lets the post's pass finish before it waives and kicks.
const waiveAll = (store, ids) => ids.forEach((id) => assert.deepEqual(store.waive(id, "budget", true), { ok: true }));

/** Case 1's shape: four rows in one checkout, all waived over the budget. */
async function fourWaived(opts) {
  const made = makeStore(opts);
  const { store } = made;
  await store.reconcile();
  ["a", "b", "c", "d"].forEach((id, n) => store.post(item(id, { order: n, holdForHost: opts?.holdForHost ?? true })));
  store.kick();
  await settle();
  waiveAll(store, ["a", "b", "c", "d"]);
  store.kick();
  await settle();
  return made;
}

test("four waived rows in one checkout start ONE at a time — the waiver is not a fire", async () => {
  const { store, state, done, release } = makeStore();
  try {
    await store.reconcile();
    ["a", "b", "c", "d"].forEach((id, n) => store.post(item(id, { order: n })));
    store.kick();
    await settle();
    assert.deepEqual(state.ran, [], "over the budget, nothing starts");
    assert.equal(store.get("a").blockReason, "budget");

    waiveAll(store, ["a", "b", "c", "d"]);
    store.kick();
    await settle();
    assert.deepEqual(state.ran, ["a"], "one executor, not four");
    for (const id of ["b", "c", "d"]) {
      assert.equal(store.get(id).state, "blocked");
      assert.notEqual(store.get(id).blockReason, "budget", `${id} is held by a rung below the budget`);
      assert.deepEqual(store.get(id).pastBudget, { until: state.resetAt }, `${id} keeps its waiver until it starts`);
    }

    await release("a");
    store.kick();
    await settle();
    assert.deepEqual(state.ran, ["a", "b"], "the next one goes when the first is done");
    assert.equal(store.get("a").state, "done");
  } finally { done(); }
});

test("an unwaived sibling keeps waiting for the budget while the waived one goes", async () => {
  const { store, state, done } = makeStore();
  try {
    await store.reconcile();
    store.post(item("w", { order: 0 }));
    store.post(item("u", { order: 1 }));
    await settle();
    waiveAll(store, ["w"]);
    store.kick();
    await settle();
    assert.deepEqual(state.ran, ["w"]);
    assert.equal(store.get("u").blockReason, "budget");
  } finally { done(); }
});

test("a waived holdForHost row still waits for work running in ANOTHER repo", async () => {
  const { store, state, done } = makeStore();
  try {
    await store.reconcile();
    store.post(item("other", { cwd: OTHER, holdForHost: false }));
    await settle();
    waiveAll(store, ["other"]);
    store.kick();
    await settle();
    assert.deepEqual(state.ran, ["other"]);
    store.post(item("mine"));
    await settle();
    waiveAll(store, ["mine"]);
    store.kick();
    await settle();
    assert.equal(store.get("mine").blockReason, "hostBusy");
  } finally { done(); }
});

test("a waived row with no free automatic slot waits for one", async () => {
  const { store, state, done } = makeStore({ slots: 0 });
  try {
    await store.reconcile();
    store.post(item("a", { holdForHost: false }));
    await settle();
    waiveAll(store, ["a"]);
    store.kick();
    await settle();
    assert.deepEqual(state.ran, []);
    assert.equal(store.get("a").blockReason, "noSlot");
  } finally { done(); }
});

test("the waiver stays on through starting, and survives a provable retry", async () => {
  let seenAtStart;
  let store;
  const made = makeStore({
    answer: (i) => { seenAtStart = store.get(i.id).pastBudget; return { ok: false, retry: true, detail: "the table is full" }; },
  });
  store = made.store;
  try {
    await store.reconcile();
    store.post(item("r", { holdForHost: false }));
    await settle();
    waiveAll(store, ["r"]);
    store.kick();
    await settle();
    // Kept while `starting`, so a restart that reconciles to *nothing ran*
    // hands back a row still let past (see the reconcile test below).
    assert.deepEqual(seenAtStart, { until: made.state.resetAt }, "still on the row while it starts");
    const row = store.get("r");
    assert.equal(row.state, "queued");
    assert.deepEqual(row.pastBudget, { until: made.state.resetAt }, "nothing was typed, so the waiver was not used either");
  } finally { made.done(); }
});

test("a recurring rule let past the budget runs ONE occurrence, then waits for it again", async () => {
  const realNow = Date.now;
  let clock = realNow();
  Date.now = () => clock;
  const { store, state, done } = makeStore({ answer: () => ({ ok: true, detail: "delivered" }) });
  try {
    await store.reconcile();
    const at = new Date(clock + 3 * 60_000);
    store.post({
      id: "wk", cwd: REPO,
      payload: { kind: "prompt", steps: ["the weekly words"] },
      target: { kind: "repo", fresh: true },
      trigger: { kind: "at", rule: { kind: "weekly", days: [at.getDay()], hour: at.getHours(), minute: at.getMinutes() }, graceMin: 120 },
      auto: true, title: "weekly",
    });
    clock += 4 * 60_000;
    store.kick();
    await settle();
    assert.equal(store.get("wk").blockReason, "budget");
    waiveAll(store, ["wk"]);
    store.kick();
    await settle();
    assert.deepEqual(state.ran, ["wk"], "this occurrence ran");
    const after = store.get("wk");
    assert.equal(after.state, "queued");
    assert.equal(after.pastBudget, undefined, "the waiver covered exactly that one");

    clock += 7 * 24 * 3_600_000;
    store.kick();
    await settle();
    assert.deepEqual(state.ran, ["wk"], "next week's occurrence did not start");
    assert.equal(store.get("wk").blockReason, "budget");
  } finally { Date.now = realNow; done(); }
});

test("re-saving a row (upsert) keeps a waiver the draft does not mention", async () => {
  const { store, done } = makeStore({ budgetBlocked: () => false });
  try {
    await store.reconcile();
    const draft = { ...item("u"), trigger: { kind: "at", rule: { kind: "once", at: Date.now() + 3_600_000, offsetMin: 0 }, graceMin: 120 } };
    store.post(draft);
    waiveAll(store, ["u"]);
    store.upsert({ ...draft, label: "renamed" });
    assert.ok(store.get("u").pastBudget?.until > Date.now());
  } finally { done(); }
});

test("waive refuses what it cannot be about, in words, and on:false is the undo", async () => {
  const { store, done } = makeStore();
  try {
    await store.reconcile();
    store.post(item("q", { holdForHost: false }));
    const odd = store.waive("q", "serial", true);
    assert.equal(odd.ok, false);
    assert.match(odd.reason, /only the budget/);
    assert.deepEqual(store.waive("nope", "budget", true), { ok: false, reason: "that intent is gone" });

    waiveAll(store, ["q"]);
    assert.deepEqual(store.waive("q", "budget", false), { ok: true });
    assert.deepEqual(store.waive("q", "budget", false), { ok: true }, "an undo twice is still an undo");
    assert.equal(store.get("q").pastBudget, undefined);
    store.kick();
    await settle();
    assert.equal(store.get("q").blockReason, "budget", "undone, it waits for the budget again");

    waiveAll(store, ["q"]);
    store.kick();
    await settle();
    assert.equal(store.get("q").state, "starting");
    assert.deepEqual(store.waive("q", "budget", false), { ok: false, reason: "it is already running" });

    store.post(item("t", { holdForHost: false, cwd: OTHER }));
    store.cancel("t");
    assert.deepEqual(store.waive("t", "budget", true), { ok: false, reason: "it is already canceled" });
  } finally { done(); }
});

test("case 1 WITHOUT holdForHost: serial alone still lets only the first go", async () => {
  const { store, state, done } = await fourWaived({ holdForHost: false });
  try {
    assert.deepEqual(state.ran, ["a"], "one executor, not four — `serial` is on every repo-target item");
    for (const id of ["b", "c", "d"]) {
      assert.equal(store.get(id).state, "blocked");
      assert.equal(store.get(id).blockReason, "serial", `${id} waits for the checkout, not the budget`);
    }
  } finally { done(); }
});

test("a waiver is an answer about ITS window: past the reset the row waits for the budget again", async () => {
  const realNow = Date.now;
  let clock = realNow();
  Date.now = () => clock;
  const { store, state, done } = makeStore({ slots: 0 });
  try {
    await store.reconcile();
    store.post(item("t", { holdForHost: false }));
    await settle();
    waiveAll(store, ["t"]);
    store.kick();
    await settle();
    assert.equal(store.get("t").blockReason, "noSlot", "inside the window, only the slot holds it");
    // The window resets; the next one trips its own ceiling.
    clock = state.resetAt + 60_000;
    state.resetAt = clock + 5 * 3_600_000;
    store.kick();
    await settle();
    const row = store.get("t");
    assert.equal(row.blockReason, "budget", "a fresh block nobody waived holds it");
    assert.equal(row.pastBudget, undefined, "and the tick drops the expired waiver, so no chip says otherwise");
  } finally { Date.now = realNow; done(); }
});

test("waive refuses an archived row, and a budget that holds nothing, in words", async () => {
  const { store, state, done } = makeStore();
  try {
    await store.reconcile();
    store.post({ ...item("ar", { holdForHost: false }), archived: true });
    assert.deepEqual(store.waive("ar", "budget", true), { ok: false, reason: "it is set aside — put it back on the list first" });
    assert.deepEqual(store.waive("ar", "budget", false), { ok: true }, "the undo is always allowed");
    store.post(item("fr", { holdForHost: false, cwd: OTHER }));
    state.over = false;
    assert.deepEqual(store.waive("fr", "budget", true), { ok: false, reason: "the budget is not holding anything right now" });
    state.over = true;
    state.resetAt = null;
    const r = store.waive("fr", "budget", true);
    assert.equal(r.ok, false);
    assert.match(r.reason, /does not say when that budget window resets/);
    assert.equal(store.get("fr").pastBudget, undefined);
  } finally { done(); }
});

test("a restart while a waived row is STARTING: nothing ran ⇒ requeued, still let past", async () => {
  const first = makeStore();
  try {
    await first.store.reconcile();
    first.store.post(item("s", { holdForHost: false }));
    await settle();
    waiveAll(first.store, ["s"]);
    first.store.kick();
    await settle();
    assert.equal(first.store.get("s").state, "starting");
    first.store.noteSession("s", "sid-1");
    first.store.stop();

    // The daemon dies here. The next one reads the row off disk and asks the
    // CLI's log, which provably does not have the words.
    for (const [verdict, kept] of [["absent", true], ["landed", false]]) {
      const { IntentManager: Again } = await import("../dist/intents/manager.js");
      const { mkdtempSync: mk, cpSync } = await import("node:fs");
      const root = mk(join(tmpdir(), "waterplane-pastbudget-re-"));
      cpSync(join(first.state.root, ".waterplane"), join(root, ".waterplane"), { recursive: true });
      const again = new Again({
        ...first.store.deps,
        root,
        budgetOver: () => [{ which: "session", pct: 90, max: 75, resetAt: first.state.resetAt }],
        sessionAlive: () => true,
        logVerdict: () => verdict,
        // No free slot, so the requeued row cannot start again in the pass
        // `reconcile()` kicks — the waiver is read off a row at rest.
        autoSlotsFree: () => 0,
      });
      await again.reconcile();
      const row = again.get("s");
      if (kept) {
        assert.equal(row.blockReason, "noSlot", "requeued, past the budget, waiting only for a slot");
        assert.deepEqual(row.pastBudget, { until: first.state.resetAt }, "the start it was for is still ahead");
      } else {
        assert.equal(row.state, "done");
        assert.equal(row.pastBudget, undefined, "it ran — the waiver was used");
      }
      again.stop();
      rmSync(root, { recursive: true, force: true });
    }
  } finally { first.done(); }
});

test("intent.post off the wire cannot bring a waiver — or a before-reset pass", async () => {
  const { store, done } = makeStore();
  try {
    await store.reconcile();
    const sent = [];
    const r = await workRoutes["intent.post"].run({
      msg: { t: "intent.post", intent: { ...item("w1", { holdForHost: false }), pastBudget: { until: Date.now() + 9e9 }, budgetPass: { window: "session", from: 1, until: 9e15 } } },
      ws: {},
      c: { intents: store, send: (_ws, m) => sent.push(m), containRepoDir: async (d) => d },
    });
    assert.equal(r.ok, true);
    assert.equal(store.get("w1").pastBudget, undefined, "only intent.waive sets it");
    assert.equal(store.get("w1").budgetPass, undefined, "only the host stamps it");
    store.kick();
    await settle();
    assert.equal(store.get("w1").blockReason, "budget");
  } finally { done(); }
});

test("backlog.add with pastBudget waives the NEW row; a budget holding nothing is silent, any other refusal is said", async () => {
  const run = async (waive) => {
    const sent = [], waived = [];
    const c = {
      containRepoDir: async (d) => d,
      backlog: { add: (text, repoDir) => ({ id: "new1", text, repoDir, status: "queued" }) },
      intents: { waive: (id, rung, on) => { waived.push([id, rung, on]); return waive; } },
      send: (_ws, m) => sent.push(m),
    };
    workRoutes["backlog.add"]({ msg: { t: "backlog.add", text: "go", repoDir: REPO, autoFire: true, targetSessionId: "s1", pastBudget: true }, ws: {}, c });
    await settle();
    return { sent, waived };
  };
  const ok = await run({ ok: true });
  assert.deepEqual(ok.waived, [["new1", "budget", true]]);
  assert.equal(ok.sent.length, 0);
  const idle = await run({ ok: false, reason: "the budget is not holding anything right now" });
  assert.equal(idle.sent.length, 0, "nothing tripped is nothing to lift — the row runs when free anyway");
  const refused = await run({ ok: false, reason: "the usage reading does not say when that budget window resets" });
  assert.equal(refused.sent.length, 1);
  assert.match(refused.sent[0].text, /not past the budget — the usage reading/);
});

test("a WEEKLY waiver that runs out unstarted leaves a leftover: the new week holds it at the leftover ceiling", async () => {
  const realNow = Date.now;
  let clock = realNow();
  Date.now = () => clock;
  const weekly = { over: true, leftover: null };
  const { store, state, done } = makeStore({
    slots: 0,
    budgetBlocked: () => weekly.over,
    budgetOver: () => (weekly.over ? [{ which: "weekly", pct: 97, max: 75, resetAt: state.resetAt }] : []),
    leftoverOver: () => weekly.leftover,
  });
  try {
    await store.reconcile();
    store.post(item("w", { holdForHost: false }));
    await settle();
    waiveAll(store, ["w"]);
    await settle();
    assert.deepEqual(store.get("w").pastBudget, { until: state.resetAt, weekly: true }, "granted against the weekly cap");
    const reset = state.resetAt;
    // The week resets with the row still waiting for a slot; the new week is
    // already past the leftover ceiling.
    clock = reset + 60_000;
    weekly.over = false;
    weekly.leftover = { which: "weekly", pct: 25, max: 20, resetAt: reset + 7 * 86_400_000 };
    store.kick();
    await settle();
    let row = store.get("w");
    assert.equal(row.pastBudget, undefined);
    assert.equal(row.leftoverOf, reset, "stamped with the week it outlived");
    assert.equal(row.blockReason, "budget");
    assert.match(row.blockDetail ?? "", /leftover from a week that has reset/);
    // Under the leftover ceiling it is ordinary work again (only the slot holds it).
    weekly.leftover = null;
    store.kick();
    await settle();
    row = store.get("w");
    assert.equal(row.blockReason, "noSlot");
    assert.equal(row.leftoverOf, reset, "the stamp stays until the row starts");
  } finally { Date.now = realNow; done(); }
});

test("a SESSION-only waiver that runs out leaves nothing behind", async () => {
  const realNow = Date.now;
  let clock = realNow();
  Date.now = () => clock;
  const made = makeStore({ slots: 0, budgetBlocked: () => made.state.over, leftoverOver: () => ({ which: "weekly", pct: 25, max: 20, resetAt: null }) });
  const { store, state, done } = made;
  try {
    await store.reconcile();
    store.post(item("s", { holdForHost: false }));
    await settle();
    waiveAll(store, ["s"]);
    await settle();
    assert.deepEqual(store.get("s").pastBudget, { until: state.resetAt });
    clock = state.resetAt + 60_000;
    state.over = false;
    store.kick();
    await settle();
    assert.equal(store.get("s").leftoverOf, undefined);
    assert.equal(store.get("s").blockReason, "noSlot", "not held as a leftover");
  } finally { Date.now = realNow; done(); }
});
