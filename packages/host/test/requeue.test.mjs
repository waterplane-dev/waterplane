/**
 * Putting a row that had STOPPED back in the queue.
 *
 * The bug this closes is not a crash: applying *still wanted* to a failed row
 * wrote it a sort position, the sheet said "position 1 in the order", and the
 * row was terminal — not in that order, not in any other, and never looked at
 * by the ladder again. Measured on the desktop this was written on: 0 queued,
 * 19 failed. So the verb exists, and everything about it is a promise that can
 * only be broken quietly:
 *
 *  1. the FIELDS. A row returned to `queued` still wearing `startedAt`,
 *     `sessionId` or `dismissedAt` renders as something it is not, and the last
 *     of those three is pending work `compact()` is already allowed to evict.
 *  2. `result` is KEPT and the failure is COPIED into the history, so the run
 *     before this one is still readable after the run after it.
 *  3. every refusal is a SENTENCE, and a different one per state, because the
 *     next move differs: a done item is re-fired, a called-off one is posted
 *     again.
 *  4. a spent one-off drops its clock, or rung 3 fails it again two seconds
 *     later for the only reason it can — that instant has passed.
 *  5. NO `requeued` event: that channel is the usage limit's, and it says
 *     "Backlog paused" about work the host parked, not about a person's tap.
 *  6. the chain rules, which are `chainFacts()`'s and are asserted here because
 *     they are what makes a re-queue safe in the middle of a chain.
 *  7. the PRE-FLIGHT. Repairing the row is not the same as the row being able
 *     to run, and for three shapes the honest answer is no, for ever: a chain
 *     whose predecessor is gone, a `session` target whose session has closed,
 *     and a row somebody set aside. Put back, the first fails again on the next
 *     tick with the same sentence and the other two wait for ever — while Apply
 *     has already said "19 put back in the queue … they run again when their
 *     turn comes". So the ladder is asked about a COPY of the revived row
 *     first, and those three are refused in words. The ORDINARY waits are not:
 *     the budget, a slot, `serial`, quiet hours and a live chain are exactly
 *     what "when its turn comes" means.
 *  8. the COUNT rises past `REQUEUE_KEEP` when the words stop. The list is
 *     capped because it carries sentences; `requeueCount` is not, or a row put
 *     back eleven times says "the 5th time" for ever.
 *  9. `by` is per CALL SITE — `hand` for a tap that leaves the row waiting,
 *     `run` for the two verbs that fire it in the same breath, `assess` for a
 *     proposal — and the row is the only account of which it was.
 *
 * Fake deps and a temp root, `intentsched.test.mjs`'s harness: the store is the
 * thing under test and every fact it reads is a function it was handed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { IntentManager } = await import("../dist/intents/manager.js");
const { intentToBacklogItem } = await import("../dist/intents/adapters.js");
const { workRoutes } = await import("../dist/routes/work.js");
const { REQUEUE_KEEP } = await import("@waterplane/shared");

const REPO = "/tmp/waterplane-requeue-repo";
const HOUR = 3_600_000;

/**
 * A store over its own temp root.
 *
 * `slots` is the pause lever throughout: every row here is a repo-target row,
 * so 0 free slots holds it at the cap rung — BELOW the trigger rung, which is
 * what lets a chain's own verdict still be read off `blockReason` while nothing
 * is allowed to actually run.
 */
function makeStore(over = {}) {
  const root = mkdtempSync(join(tmpdir(), "waterplane-requeue-"));
  const state = {
    root,
    slots: 3,
    /** Executor calls, in order. */
    ran: [],
    /** What every executor answers. */
    result: { ok: true, detail: "delivered" },
    /** Every `onChange` — an id, or `null` for the bare "the whole store moved". */
    changes: [],
    /**
     * A deep copy of every row as the write that ANNOUNCED it left it.
     *
     * Needed because every write in here ends in `kick()` and the tick runs
     * synchronously as far as its first await — so a row that a verb left
     * `queued` can already be wearing the ladder's verdict by the next line.
     * The snapshot is the transition; `store.get()` is what happened next.
     */
    snaps: [],
    /** Every event the store emitted, by name. */
    events: [],
  };
  const exec = (name) => async (i) => { state.ran.push({ name, id: i.id }); return state.result; };
  const store = new IntentManager({
    root,
    sessions: () => [],
    sessionAlive: () => false,
    repoSession: () => null,
    repoAnySession: () => false,
    autoSlotsFree: () => state.slots,
    autoSlotsDetail: () => (state.slots > 0 ? undefined : "waiting for a free slot"),
    revivedSessionFor: () => null,
    diedAtLimit: () => false,
    stopCount: () => 0,
    isHooked: () => false,
    sessionIdleMs: () => 99_000,
    sessionHasPrompt: () => false,
    idleWindowMs: () => 1000,
    groupConcurrency: () => 6,
    knownDirs: async () => new Set([REPO]),
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
    onChange: (row) => {
      state.changes.push(row ? row.id : null);
      if (row) state.snaps.push(JSON.parse(JSON.stringify(row)));
    },
    ...over,
  });
  for (const name of ["requeued", "settled", "skipped", "missed"]) {
    store.on(name, (row) => state.events.push(`${name}:${row.id}`));
  }
  return { store, state, root };
}

/** An ordinary work item: no clock, its own session, nothing special. */
const workRow = (id, extra = {}) => ({
  id,
  cwd: REPO,
  payload: { kind: "prompt", steps: ["do the thing"] },
  target: { kind: "repo", fresh: true },
  trigger: { kind: "idle" },
  // `auto: true` is what makes `slots` a lever at all — the cap rung reads it,
  // and a hand-posted row is exempt from every rung machinery is held at.
  auto: true,
  title: "a work item",
  ...extra,
});

/** A one-off with a clock — `isTimedWorkRow`, the shape whose instant can pass. */
const timedRow = (id, at, extra = {}) => workRow(id, {
  trigger: { kind: "at", rule: { kind: "once", at, offsetMin: 0 }, graceMin: 120 },
  ...extra,
});

/**
 * Let the tick have a go.
 *
 * TWICE, and that is not belt and braces: a kick that lands while a pass is
 * still awaiting is dropped (`ticking`), every write in here kicks, and a pass
 * reads the slot count once at the top — so the kick that follows a change to
 * the fake host's facts is routinely the one that is swallowed.
 */
async function run(store, ms = 40) {
  store.kick();
  await settle(ms);
  store.kick();
  await settle(ms);
}

const rowsOnDisk = (root) => JSON.parse(readFileSync(join(root, ".waterplane", "intents.json"), "utf8")).intents;
const settle = (ms = 40) => new Promise((r) => setTimeout(r, ms));

/** Post it, let it run, and hand back the row it failed as. */
async function postAndFail(store, state, draft, detail = "the session exited before the task finished") {
  state.result = { ok: false, detail };
  assert.equal(store.post(draft).ok, true);
  await run(store);
  const row = store.get(draft.id);
  assert.equal(row.state, "failed", `${draft.id} was meant to fail, and is ${row.state}`);
  return row;
}

// ── 1. the field transition ─────────────────────────────────────────────────

test("a failed row comes back queued, keeps its result, and says who put it back", async () => {
  const { store, state, root } = makeStore();
  await store.reconcile();
  const row = await postAndFail(store, state, workRow("w1", {
    label: "the migration", order: 7, origin: "schedule:abc123", groupId: "g1",
  }), "it went wrong");
  // Host-written, so it is set here rather than on the draft — and it must
  // survive, or "one at a time in this repo" quietly stops holding.
  row.serial = `repo:${REPO}`;
  const failure = row.result;
  // Everything a run leaves behind, present at once — the point being that the
  // transition is asserted as a whole rather than one field per bug report.
  row.attempts = 2;
  row.dismissedAt = Date.now();
  row.missing = ["design.png"];
  row.followed = true;
  row.clearedOccurrence = 1234;
  row.handOrdered = true;
  // Nothing may actually start, so the row stays where the ladder can be seen
  // looking at it — which is the whole of the bug being fixed.
  state.slots = 0;
  state.snaps.length = 0;

  const r = store.requeueFailed("w1", { kind: "hand" });
  assert.deepEqual(r, { ok: true });

  const back = state.snaps[0];
  assert.equal(back.state, "queued");
  for (const f of ["attempts", "startedAt", "settledAt", "sessionId", "dismissedAt", "blockReason", "blockDetail", "missing", "followed", "clearedOccurrence"]) {
    assert.equal(back[f], undefined, `${f} is an account of the run that ended`);
  }
  // KEPT: the last thing anybody wrote about this work.
  assert.equal(back.result.detail, failure.detail, "the failure stays on the row until the next run replaces it");
  assert.equal(back.result.at, failure.at);
  assert.equal(back.result.ok, false);
  // Untouched: same work, same place, same aim. `origin` above all — it is
  // classification (`scheduleIdFromOrigin`), never provenance.
  assert.equal(back.origin, "schedule:abc123");
  assert.equal(back.order, 7);
  assert.equal(back.label, "the migration");
  assert.equal(back.groupId, "g1");
  assert.equal(back.serial, `repo:${REPO}`);
  assert.equal(back.handOrdered, true);
  assert.equal(back.createdAt, row.createdAt);
  assert.deepEqual(back.payload, { kind: "prompt", steps: ["do the thing"] });
  assert.deepEqual(back.target, { kind: "repo", fresh: true });

  assert.equal(back.requeues.length, 1);
  assert.equal(back.requeues[0].by, "hand");
  assert.equal(back.requeues[0].runId, undefined, "a hand re-queue has no document behind it");
  assert.equal(back.requeues[0].clockDropped, undefined, "there was no clock to drop");
  assert.equal(back.requeues[0].result.detail, failure.detail, "the failure is copied into the history");
  assert.equal(back.requeues[0].result.at, failure.at);

  // …and the ladder is judging it again, which a terminal row is never.
  assert.equal(store.get("w1").blockReason, "noSlot");

  const onDisk = rowsOnDisk(root).find((x) => x.id === "w1");
  assert.equal(onDisk.requeues.length, 1);
  assert.equal(onDisk.result.detail, failure.detail, "…on disk too");

  // What the phone is handed: a queued row with no error line, and one sentence
  // saying it was put back and what it was carrying when it was.
  const item = intentToBacklogItem(store.get("w1"));
  assert.equal(item.status, "queued");
  assert.equal(item.error, undefined, "a queued row's result is history, not a red line");
  assert.equal(item.requeued.n, 1);
  assert.equal(item.requeued.by, "hand");
  assert.equal(item.requeued.error, "it went wrong");

  store.stop();
  rmSync(root, { recursive: true, force: true });
});

test("an assessment's re-queue names the run it came out of", async () => {
  const { store, state, root } = makeStore();
  await store.reconcile();
  await postAndFail(store, state, workRow("w2"));
  state.slots = 0;
  assert.equal(store.requeueFailed("w2", { kind: "assess", runId: "run_42" }).ok, true);
  const e = store.get("w2").requeues[0];
  assert.equal(e.by, "assess");
  assert.equal(e.runId, "run_42", "one tap from the verdicts it came out of");
  store.stop();
  rmSync(root, { recursive: true, force: true });
});

// ── 2. every refusal, in words ──────────────────────────────────────────────

test("only a failed row passes, and every other state is refused in its own words", async () => {
  const { store, state, root } = makeStore();
  await store.reconcile();
  state.slots = 0;

  assert.deepEqual(store.requeueFailed("nobody", { kind: "hand" }),
    { ok: false, reason: "that intent is gone" });

  store.post(workRow("q1"));
  await run(store);
  assert.equal(store.get("q1").state, "blocked", "held at the cap rung, which is a waiting state");
  assert.deepEqual(store.requeueFailed("q1", { kind: "hand" }),
    { ok: false, reason: "it is already waiting its turn" });
  store.get("q1").state = "queued";
  assert.deepEqual(store.requeueFailed("q1", { kind: "hand" }),
    { ok: false, reason: "it is already waiting its turn" });

  store.get("q1").state = "running";
  assert.deepEqual(store.requeueFailed("q1", { kind: "hand" }),
    { ok: false, reason: "it is already running" });
  store.get("q1").state = "starting";
  assert.deepEqual(store.requeueFailed("q1", { kind: "hand" }),
    { ok: false, reason: "it is already running" });
  store.get("q1").state = "queued";

  store.post(workRow("d1"));
  store.markDone("d1");
  assert.deepEqual(store.requeueFailed("d1", { kind: "hand" }),
    { ok: false, reason: "it already ran — a done item is re-fired, not put back in the queue" });

  store.post(workRow("c1"));
  store.cancel("c1");
  assert.deepEqual(store.requeueFailed("c1", { kind: "hand" }),
    { ok: false, reason: "it was called off — post it again if you still want it" });

  // …and the one that passes.
  state.slots = 3;
  await postAndFail(store, state, workRow("f1"));
  assert.deepEqual(store.requeueFailed("f1", { kind: "hand" }), { ok: true });
  store.stop();
  rmSync(root, { recursive: true, force: true });
});

test("a host already holding its ceiling of pending work refuses, in post()'s words", async () => {
  const { store, state, root } = makeStore();
  await store.reconcile();
  await postAndFail(store, state, workRow("f2"));
  state.slots = 0;
  // Fill to `PENDING_MAX` — `post()` refuses the one that would exceed it, so
  // the loop ends by itself and the number is never restated here.
  let n = 0;
  while (store.post(workRow(`p${n}`)).ok) n++;
  const r = store.requeueFailed("f2", { kind: "hand" });
  assert.equal(r.ok, false);
  assert.match(r.reason, /^this host is already holding \d+ intents that have not run — clear some before adding more$/);
  assert.equal(store.get("f2").state, "failed", "and nothing was written");
  store.stop();
  rmSync(root, { recursive: true, force: true });
});

// ── 3. the spent one-off ────────────────────────────────────────────────────

test("a spent one-off comes back with its clock dropped, and says so", async () => {
  const { store, state, root } = makeStore();
  await store.reconcile();
  state.slots = 0;
  // Four hours past a two-hour grace: rung 3 fails it, and `settle()` nulls
  // `nextAt` — the exact row whose re-queue would otherwise die of the same
  // sentence on the next tick.
  store.post(timedRow("t1", Date.now() - 4 * HOUR));
  await run(store);
  const failed = store.get("t1");
  assert.equal(failed.state, "failed");
  assert.equal(failed.nextAt, null);
  failed.lastOccurrence = Date.now() - 4 * HOUR;

  state.changes.length = 0;
  assert.equal(store.requeueFailed("t1", { kind: "hand" }).ok, true);
  const back = store.get("t1");
  assert.deepEqual(back.trigger, { kind: "idle" }, "it waits its turn instead of an instant that has gone");
  assert.equal(back.nextAt, undefined);
  assert.equal(back.lastOccurrence, undefined);
  assert.equal(back.requeues[0].clockDropped, true, "the row says what was changed about it");
  // A trigger-KIND change moves the row between lists, and a row LEAVING a list
  // is not expressible as a changed row.
  assert.deepEqual(state.changes.slice(0, 2), ["t1", null], "the row, then the whole store");

  // …and it is genuinely runnable now, where as-it-was it would fail again.
  state.slots = 3;
  state.result = { ok: true, detail: "delivered" };
  await run(store);
  assert.equal(store.get("t1").state, "done");
  assert.deepEqual(state.ran.map((x) => x.name), ["freshSession"]);
  store.stop();
  rmSync(root, { recursive: true, force: true });
});

// ── 4. the history, and the cap ─────────────────────────────────────────────

test("after the next run the row carries the NEW result and the history carries the old", async () => {
  const { store, state, root } = makeStore();
  await store.reconcile();
  await postAndFail(store, state, workRow("h1"), "the first failure");
  state.slots = 0;
  assert.equal(store.requeueFailed("h1", { kind: "hand" }).ok, true);
  state.slots = 3;
  state.result = { ok: true, detail: "delivered" };
  await run(store);
  const row = store.get("h1");
  assert.equal(row.state, "done");
  assert.equal(row.result.detail, "delivered", "the row says how it went THIS time");
  assert.equal(row.requeues[0].result.detail, "the first failure", "and the history is the only copy of last time");
  store.stop();
  rmSync(root, { recursive: true, force: true });
});

test("the history is capped by COUNT, keeping the newest", async () => {
  const { store, state, root } = makeStore();
  await store.reconcile();
  const rounds = REQUEUE_KEEP + 2;
  state.slots = 0;
  store.post(workRow("k1"));
  for (let n = 1; n <= rounds; n++) {
    state.slots = 3;
    state.result = { ok: false, detail: `failure #${n}` };
    await run(store);
    assert.equal(store.get("k1").state, "failed");
    state.slots = 0;
    assert.equal(store.requeueFailed("k1", { kind: "hand" }).ok, true);
  }
  const kept = store.get("k1").requeues;
  assert.equal(kept.length, REQUEUE_KEEP);
  assert.deepEqual(kept.map((e) => e.result.detail),
    Array.from({ length: REQUEUE_KEEP }, (_, i) => `failure #${rounds - REQUEUE_KEEP + 1 + i}`),
    "oldest first, and the oldest ENTRIES are the ones dropped");

  // …and the COUNT keeps going. The cap is on the WORDS — a row re-queued
  // weekly for a year must not grow a field without a bound in a file every
  // tick rewrites — and reading its length back as the number is how the chip
  // came to say "the 5th time" for ever.
  assert.equal(store.get("k1").requeueCount, rounds, "the number is uncapped and the list is not");
  assert.equal(intentToBacklogItem(store.get("k1")).requeued.n, rounds,
    "…and the phone is handed the number, not the length of what fitted");
  assert.equal(rowsOnDisk(root).find((x) => x.id === "k1").requeueCount, rounds, "…on disk too");
  store.stop();
  rmSync(root, { recursive: true, force: true });
});

test("a row that predates the count takes its list length as a FLOOR, once", async () => {
  // The upgrade case, and the only legitimate read of `requeues.length` in the
  // host. A row written before the field has four entries and no count; one is
  // a worse first answer than four, and the floor is taken at the next
  // transition and never again.
  const { store, state, root } = makeStore();
  await store.reconcile();
  const row = await postAndFail(store, state, workRow("o1"));
  row.requeues = [1, 2, 3].map((n) => ({ at: Date.now() - n, by: "hand" }));
  row.requeueCount = undefined;
  state.slots = 0;
  assert.equal(store.requeueFailed("o1", { kind: "hand" }).ok, true);
  assert.equal(store.get("o1").requeueCount, 4);
  // And from here it is the count that is read, never the list again.
  state.slots = 3;
  state.result = { ok: false, detail: "again" };
  await run(store);
  state.slots = 0;
  assert.equal(store.requeueFailed("o1", { kind: "hand" }).ok, true);
  assert.equal(store.get("o1").requeueCount, 5);
  assert.equal(store.get("o1").requeues.length, REQUEUE_KEEP);
  store.stop();
  rmSync(root, { recursive: true, force: true });
});

// ── 5. no event ─────────────────────────────────────────────────────────────

test("a person's tap emits no 'requeued' event — that channel is the usage limit's", async () => {
  const { store, state, root } = makeStore();
  await store.reconcile();
  await postAndFail(store, state, workRow("e1"));
  state.slots = 0;
  state.events.length = 0;
  state.changes.length = 0;
  assert.equal(store.requeueFailed("e1", { kind: "hand" }).ok, true);
  assert.deepEqual(state.events, [], "no push saying the backlog was paused");
  assert.equal(state.changes[0], "e1", "the row changed, and that is all anybody is told");
  assert.equal(state.changes.includes(null), false, "no clock moved, so no list did either");
  store.stop();
  rmSync(root, { recursive: true, force: true });
});

// ── 6. the chain ────────────────────────────────────────────────────────────

test("a successor waits for the re-queued row's NEW finish, and is not told it is gone", async () => {
  const { store, state, root } = makeStore();
  await store.reconcile();
  await postAndFail(store, state, workRow("a1", { title: "the migration" }));
  // Nothing may run from here: the cap rung is BELOW the trigger rung, so the
  // successor's own verdict is still what `blockReason` reports.
  state.slots = 0;
  store.post(workRow("b1", { trigger: { kind: "after", id: "a1", title: "the migration" } }));
  await run(store);
  assert.equal(store.get("b1").blockReason, "noSlot", "a settled predecessor releases the chain");

  assert.equal(store.requeueFailed("a1", { kind: "hand" }).ok, true);
  await run(store);
  const b = store.get("b1");
  assert.equal(b.state, "blocked");
  assert.equal(b.blockReason, "notYet", "re-queued means not settled: the successor waits again");
  assert.match(b.blockDetail, /the migration/, "…and it waits for the NEW finish, by name");

  // It is still KNOWN, which is the fact that keeps the wait a wait: an unknown
  // predecessor fails the row instead.
  state.slots = 3;
  state.result = { ok: true, detail: "delivered" };
  await run(store, 60);
  assert.equal(store.get("a1").state, "done");
  assert.equal(store.get("b1").state, "done", "released by the finish it waited for");
  store.stop();
  rmSync(root, { recursive: true, force: true });
});

test("a successor that already failed is NOT revived by its predecessor coming back", async () => {
  const { store, state, root } = makeStore();
  await store.reconcile();
  await postAndFail(store, state, workRow("a2"));
  store.post(workRow("b2", { trigger: { kind: "after", id: "a2", onlyIfOk: true } }));
  await run(store);
  const before = store.get("b2");
  assert.equal(before.state, "failed", "a chain that asked for success cannot be released by a failure");
  state.slots = 0;
  assert.equal(store.requeueFailed("a2", { kind: "hand" }).ok, true);
  await run(store);
  const after = store.get("b2");
  assert.equal(after.state, "failed", "putting one row back is a decision about that row");
  assert.equal(after.requeues, undefined, "and nothing walked forward to write on it");
  store.stop();
  rmSync(root, { recursive: true, force: true });
});

// ── 7. the other verb, and the tap that fires ───────────────────────────────

test("the bare requeue still takes a DONE row when the caller says it means one", async () => {
  const { store, state, root } = makeStore();
  await store.reconcile();
  state.slots = 0;
  store.post(workRow("r1"));
  store.markDone("r1", "did it by hand");
  assert.equal(store.requeue("r1"), false, "'put it back' is not 'run it again'");
  assert.equal(store.get("r1").state, "done");
  assert.equal(store.requeue("r1", { allowDone: true }), true, "…and the backlog's re-fire button says which it means");
  const row = store.get("r1");
  assert.equal(row.state, "queued");
  assert.equal(row.requeues.length, 1);
  assert.equal(row.requeues[0].by, "hand");
  assert.equal(row.requeues[0].result.detail, "did it by hand", "the account it is about to overwrite");
  store.stop();
  rmSync(root, { recursive: true, force: true });
});

test("run it now on a FAILED row puts it back and fires it once — and still refuses done", async () => {
  const { store, state, root } = makeStore();
  await store.reconcile();
  await postAndFail(store, state, workRow("n1"), "it went wrong");
  state.ran.length = 0;
  state.result = { ok: true, detail: "delivered" };

  const r = await store.runNow("n1");
  assert.deepEqual(r, { ok: true }, "the phone offered this verb on this row; the host used to answer 'it is already failed'");
  await settle();
  assert.deepEqual(state.ran.map((x) => x.id), ["n1"], "exactly once");
  const row = store.get("n1");
  assert.equal(row.state, "done");
  assert.equal(row.requeues.length, 1, "and the row records that somebody put it back");
  assert.equal(row.requeues[0].by, "run",
    "…as the first half of running it now, which is a different sentence from 'put it back to wait its turn'");
  assert.equal(row.requeues[0].result.detail, "it went wrong");

  // Unchanged: a row that RAN is re-fired through the backlog's own button, and
  // one somebody called off is not started again by a tap on "run it now".
  assert.deepEqual(await store.runNow("n1"), { ok: false, reason: "it is already done" });
  store.post(workRow("n2"));
  store.cancel("n2");
  assert.deepEqual(await store.runNow("n2"), { ok: false, reason: "it is already canceled" });
  store.stop();
  rmSync(root, { recursive: true, force: true });
});

// ── 8. the pre-flight: would the revived row actually get anywhere? ─────────

test("a chain whose predecessor is gone is REFUSED, quoting the sentence it would die of", async () => {
  // The shape the e2e builds, and the one that made this rung necessary: the
  // row comes back `queued`, the very next tick asks the ladder, the ladder
  // answers exactly what it answered before, and the row is failed again — one
  // history entry and one list re-render later. "Did nothing observable" is the
  // bug this whole verb exists to remove, and putting it back into the state it
  // died in is that bug with a delay on it.
  const { store, state, root } = makeStore();
  await store.reconcile();
  const row = await postAndFail(store, state, workRow("c9", {
    trigger: { kind: "after", id: "nobody-has-this-id", title: "a predecessor that was removed" },
  }));
  const died = row.result.detail;
  state.slots = 0;
  state.changes.length = 0;

  const r = store.requeueFailed("c9", { kind: "hand" });
  assert.equal(r.ok, false);
  assert.equal(r.reason, `it would stop again straight away: ${died}`,
    "the ladder's own detail, quoted — a refusal that does not say why is a dead end on a phone");
  const after = store.get("c9");
  assert.equal(after.state, "failed", "left exactly as it was");
  assert.equal(after.requeues, undefined, "nothing was written down about a re-queue that did not happen");
  assert.equal(after.requeueCount, undefined, "…including the count");
  assert.deepEqual(state.changes, [], "…and nobody was told a row moved");
  store.stop();
  rmSync(root, { recursive: true, force: true });
});

test("a row aimed at a session that has closed is REFUSED: nothing here ever re-aims it", async () => {
  // Rung 5 answers `sessionGone`, which is a WAIT — and it is the one wait in
  // the ladder that nothing in this store ever ends. (The limit resurrection
  // does, and only for a session that exited at the usage limit.) So the row
  // would sit in the queue, politely, in a list of things that are going to run.
  const { store, state, root } = makeStore();
  await store.reconcile();
  const row = await postAndFail(store, state, workRow("s9"));
  row.target = { kind: "session", sessionId: "a-session-that-is-gone" };
  state.slots = 0;

  const r = store.requeueFailed("s9", { kind: "hand" });
  assert.equal(r.ok, false);
  assert.match(r.reason, /^it would wait for ever: /);
  assert.equal(store.get("s9").state, "failed");
  assert.equal(store.get("s9").requeues, undefined);
  store.stop();
  rmSync(root, { recursive: true, force: true });
});

test("an ARCHIVED row is REFUSED, and the sentence says what to do about it", async () => {
  // `buildAssessInput` filters on STATE, so an unscoped assessment judges rows
  // somebody set aside too. Re-queued, rung 1 holds them at *set aside* for ever
  // — which reads, on the list, exactly like a row waiting its turn.
  //
  // Asked on the ROW rather than off the verdict, because rung 1 turns both
  // `archived` and auto-fire-off into a `gate` wait, and one of those two is a
  // row that runs the moment a switch flips.
  const { store, state, root } = makeStore();
  await store.reconcile();
  const row = await postAndFail(store, state, workRow("a9"));
  row.archived = true;
  state.slots = 0;

  const r = store.requeueFailed("a9", { kind: "hand" });
  assert.equal(r.ok, false);
  assert.match(r.reason, /set aside/);
  assert.match(r.reason, /bring it back/, "…and it names the next move");
  assert.equal(store.get("a9").state, "failed");
  assert.equal(store.get("a9").requeues, undefined);
  store.stop();
  rmSync(root, { recursive: true, force: true });
});

test("the ORDINARY waits are not refused — they are what 'when its turn comes' means", async () => {
  // The other half of the rung, and the half that keeps it safe: a refusal rule
  // that read every wait as "it would not run" would be a phone that will not
  // put anything back while the desktop is busy.
  const flags = { budget: false };
  const { store, state, root } = makeStore({ budgetBlocked: () => flags.budget });
  await store.reconcile();

  // …held at the cap.
  await postAndFail(store, state, workRow("w9"));
  state.slots = 0;
  assert.deepEqual(store.requeueFailed("w9", { kind: "hand" }), { ok: true });
  assert.equal(store.get("w9").blockReason, "noSlot");

  // …held by the budget.
  state.slots = 3;
  await postAndFail(store, state, workRow("w8"));
  flags.budget = true;
  assert.deepEqual(store.requeueFailed("w8", { kind: "hand" }), { ok: true });
  flags.budget = false;

  // …waiting on a predecessor that has not finished. A LIVE chain is not a dead
  // one, and the difference is the whole of `knownIntents`.
  state.slots = 3;
  const s = await postAndFail(store, state, workRow("w7"));
  state.slots = 0;
  store.post(workRow("pred7", { title: "the predecessor" }));
  s.trigger = { kind: "after", id: "pred7", title: "the predecessor" };
  assert.deepEqual(store.requeueFailed("w7", { kind: "hand" }), { ok: true });
  await run(store);
  assert.equal(store.get("w7").blockReason, "notYet", "it waits for the finish, which is a wait with an end");
  store.stop();
  rmSync(root, { recursive: true, force: true });
});

test("a spent one-off passes the pre-flight BECAUSE the probe already dropped its clock", async () => {
  // The probe is `revivedShape()`'s output and not the row on disk, which is
  // the reason the two share one function: judged as it stands, this row's rung
  // 3 answers `fail` and the pre-flight would refuse the single most common
  // thing anybody taps this verb for.
  const { store, state, root } = makeStore();
  await store.reconcile();
  state.slots = 0;
  store.post(timedRow("t9", Date.now() - 4 * HOUR));
  await run(store);
  assert.equal(store.get("t9").state, "failed");
  assert.equal(store.requeueFailed("t9", { kind: "hand" }).ok, true);
  assert.deepEqual(store.get("t9").trigger, { kind: "idle" });
  store.stop();
  rmSync(root, { recursive: true, force: true });
});

// ── 9. one fire, whoever asks ──────────────────────────────────────────────

test("fire() refuses a row that is already claimed", async () => {
  // Reached through a private, deliberately: the ordering that produced a double
  // fire is the one `kick: false` just closed (`runNow` kicked, the kicked pass
  // fired the row synchronously, and `runNow` fired it again), so there is no
  // longer a public path to it — and a guard with no test is a guard the next
  // rewrite deletes. What it costs to be wrong is a prompt typed twice into one
  // session, or two agents in one worktree.
  const { store, state, root } = makeStore();
  await store.reconcile();
  state.slots = 3;
  store.post(workRow("g1"));
  const row = store.get("g1");

  for (const s of ["starting", "running"]) {
    row.state = s;
    state.ran.length = 0;
    await store.fire(row, {});
    assert.deepEqual(state.ran, [], `a ${s} row is not started a second time`);
    assert.equal(row.state, s, "…and nothing about it is rewritten");
  }
  row.state = "queued";
  store.inflight.set("g1", Date.now());
  state.ran.length = 0;
  await store.fire(row, {});
  assert.deepEqual(state.ran, [], "and the in-memory claim covers the window before there is a persisted state");
  store.stop();
  rmSync(root, { recursive: true, force: true });
});

// ── 10. who put it back ────────────────────────────────────────────────────

test("`by` is the call site's, and the three of them mean three different things", async () => {
  const { store, state, root } = makeStore();
  await store.reconcile();

  // A tap on *put it back*, through `intent.requeue`. It leaves the row waiting.
  await postAndFail(store, state, workRow("by1"));
  state.slots = 0;
  assert.equal(store.requeueFailed("by1", { kind: "hand" }).ok, true);
  assert.equal(store.get("by1").requeues[0].by, "hand");

  // An assessment's *still wanted*, which names the run it came out of.
  state.slots = 3;
  await postAndFail(store, state, workRow("by2"));
  state.slots = 0;
  assert.equal(store.requeueFailed("by2", { kind: "assess", runId: "run_9" }).ok, true);
  assert.deepEqual(
    { by: store.get("by2").requeues[0].by, runId: store.get("by2").requeues[0].runId },
    { by: "assess", runId: "run_9" },
  );

  // The backlog's re-fire button, which puts the row back and fires it in the
  // same breath — `backlog.fire()`'s call, verbatim.
  state.slots = 3;
  await postAndFail(store, state, workRow("by3"));
  assert.equal(store.requeue("by3", { allowDone: true, by: "run" }), true);
  assert.equal(store.get("by3").requeues[0].by, "run");
  // …and the default is still the tap that waits, for every other caller.
  assert.equal(store.requeue("by3", { allowDone: true }), true);
  assert.equal(store.get("by3").requeues[1].by, "hand");
  store.stop();
  rmSync(root, { recursive: true, force: true });
});

// ── 11. which failure the tapper was looking at ────────────────────────────

const requeueRoute = workRoutes["intent.requeue"];

/** The two things that route touches. */
const routeCtx = (store, msg, sent) => ({
  msg: { t: "intent.requeue", ...msg },
  ws: {},
  c: { intents: store, send: (_ws, m) => sent.push(m) },
});

test("a re-queue naming a failure the row no longer has is refused, in words", async () => {
  // `failed` is a STATE, not an event. This op is durable and may be delivered
  // an hour late, and the live-state guard — the thing that makes a late
  // delivery safe — says "yes, failed" to a row that has since been put back,
  // run, and failed again on something completely different. Reviving it then
  // starts the work over on the strength of a failure nobody has read, and
  // quietly retires the one actually on the row.
  const { store, state, root } = makeStore();
  await store.reconcile();
  const row = await postAndFail(store, state, workRow("fa1"), "the first failure");
  const sawIt = row.settledAt;
  state.slots = 0;

  // It failed again while the op sat in an outbox.
  row.settledAt = sawIt + 5000;
  row.result = { at: sawIt + 5000, ok: false, detail: "a completely different failure" };

  const sent = [];
  const stale = await requeueRoute.run(routeCtx(store, { id: "fa1", failedAt: sawIt }, sent));
  assert.equal(stale.ok, false);
  assert.match(stale.reason, /failed again since you looked/);
  assert.equal(sent.length, 1, "…and the phone is told, because a refusal nobody sees is a silence");
  assert.equal(sent[0].t, "toast");
  assert.equal(store.get("fa1").requeues, undefined, "nothing was written");

  // Naming the failure that IS on the row goes through.
  sent.length = 0;
  const fresh = await requeueRoute.run(routeCtx(store, { id: "fa1", failedAt: sawIt + 5000 }, sent));
  assert.equal(fresh.ok, true);
  assert.equal(store.get("fa1").requeues.length, 1);
  assert.equal(store.get("fa1").requeues[0].by, "hand", "a tap on *put it back* leaves the row waiting");
  store.stop();
  rmSync(root, { recursive: true, force: true });
});

test("a re-queue that names no failure is applied on the state alone, as every older client's is", async () => {
  // Absence is the fact not having been written, never a refusal — the posture
  // every optional field on this wire takes.
  const { store, state, root } = makeStore();
  await store.reconcile();
  await postAndFail(store, state, workRow("fa2"));
  state.slots = 0;
  const sent = [];
  const r = await requeueRoute.run(routeCtx(store, { id: "fa2" }, sent));
  assert.equal(r.ok, true);
  assert.equal(store.get("fa2").requeues.length, 1);
  assert.deepEqual(sent, [], "nothing to say");
  store.stop();
  rmSync(root, { recursive: true, force: true });
});

// Not a re-queue, but the same seam: what the phone is handed for a row that
// ended without running. Every cancelled row is `calledOff` (status stays
// `failed` for older phones): `"agent"` only for the posting agent's own
// call-off, `"other"` for the phone's or an assessment's. A real failure is not.
test("intentToBacklogItem: a call-off is calledOff, and only the agent's own reads as agent", async () => {
  const { AGENT_WITHDREW_DETAIL, ORIGIN_AGENT } = await import("@waterplane/shared");
  const row = (over) => ({
    id: "a1", cwd: REPO, payload: { kind: "prompt", steps: ["x"] }, target: { kind: "repo", fresh: true },
    trigger: { kind: "idle" }, createdAt: 1, settledAt: 2, origin: ORIGIN_AGENT, state: "canceled",
    result: { at: 2, ok: false, detail: AGENT_WITHDREW_DETAIL }, ...over,
  });
  const gone = intentToBacklogItem(row({}));
  assert.equal(gone.status, "failed");
  assert.equal(gone.calledOff, "agent");
  assert.equal(intentToBacklogItem(row({ result: { at: 2, ok: false, detail: "called off from the phone" } })).calledOff, "other");
  assert.equal(intentToBacklogItem(row({ origin: undefined })).calledOff, "other");
  assert.equal(intentToBacklogItem(row({ state: "failed" })).calledOff, undefined);
});
