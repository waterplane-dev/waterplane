/**
 * The smart pick against the REAL intent store — the cases the fake cannot see.
 *
 * `smartpickstore.test.mjs` fakes the seven verbs the feature is allowed, which
 * is the right harness for what a merge and an undo DO. It cannot show what
 * those verbs SET OFF: `IntentManager.update()` kicks the tick, `pass()` runs
 * synchronously as far as its first `await`, and a chained row never reaches
 * one — so its verdict is computed and SETTLED inside the call that kicked it.
 * That is a property of the real manager and of nothing else, and it is where
 * `undo` was found destroying the chains it exists to put back.
 *
 * Two rules live here, both measured:
 *
 *  • **An undo re-points its chains BEFORE it takes the merged row away.** The
 *    other order failed every chain but the first (reproduced: `Z1 failed`,
 *    `Z2 blocked`), because the merged row was already gone from `rows` and
 *    `readArchiveTail` skips non-terminal rows — so it was not in
 *    `knownIntents` either, and `intentVerdict` failed the rest with *"the item
 *    this waited for is gone — nothing is going to release it"*.
 *  • **Nothing fires while any of that is happening.** The pass holds this
 *    repo's ladder (`SmartPick.applying`) across the whole of an apply and the
 *    whole of an undo, so a tick re-entered by one of the writes cannot start an
 *    item out of a half-restored list.
 *
 * Every executor is a fake that records and returns, so nothing spawns; the
 * slots are set to zero where a test needs the list to sit still.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.WATERPLANE_SMARTPICK_TIMEOUT_MS ||= "2000";
process.env.WATERPLANE_SMARTPICK_MIN_INTERVAL_MS ||= "0";

const { IntentManager } = await import("../dist/intents/manager.js");
const { backlogDraft } = await import("../dist/intents/adapters.js");
const { SmartPick } = await import("../dist/smartpick.js");

const REPO = "/tmp/waterplane-spchain-repo";
const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));

/** A real store over a temp root, with every outside fact faked. `slots: 0`
 *  keeps every row `blocked` on the cap, which is how a test watches a list
 *  without racing an executor. */
function makeStore({ slots = 0, ...over } = {}) {
  const root = mkdtempSync(join(tmpdir(), "waterplane-spchain-"));
  const state = { root, ran: [], holder: null, slots };
  const exec = (name) => async (i) => { state.ran.push({ name, id: i.id }); return { ok: true, detail: "delivered" }; };
  const store = new IntentManager({
    root,
    sessions: () => [],
    sessionAlive: () => false,
    repoSession: () => null,
    autoSlotsFree: () => state.slots,
    reapAutoSession: () => null,
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
      freshSession: exec("freshSession"), sweep: exec("sweep"), deliver: exec("deliver"),
      workItem: exec("workItem"), build: exec("build"), assess: exec("assess"),
    },
    onChange: () => {},
    pickHold: (row) => (state.holder ? state.holder.hold(row) : Promise.resolve(null)),
    ...over,
  });
  return { store, state, done: () => { store.stop(); rmSync(root, { recursive: true, force: true }); } };
}

const item = (id, over = {}) => ({ ...backlogDraft({ id, cwd: REPO, text: `do ${id}`, order: over.order ?? 0 }), ...over });

const MERGE = JSON.stringify({
  pick: "A", order: ["A", "B", "C"],
  merges: [{ ids: ["A", "B"], text: "do A and B together", why: "one job" }],
  why: "same job",
});

function makePick(store, state, answer = MERGE) {
  const pick = new SmartPick({
    root: state.root, intents: store, isOn: () => true,
    facts: async () => ({ branch: "main", dirty: [], commits: [] }),
    run: async () => { await settle(0); return { text: answer, failed: false, limited: false, durationMs: 1 }; },
    onChange: () => {},
  });
  state.holder = pick;
  return pick;
}

test("an undo puts BOTH chains back — the first re-point must not fail the rest", async () => {
  const { store, state, done } = makeStore();
  const pick = makePick(store, state);
  await store.reconcile();
  store.post(item("A", { order: 0 }));
  store.post(item("B", { order: 1 }));
  store.post(item("C", { order: 2 }));
  store.post(item("Z1", { order: 8, trigger: { kind: "after", id: "A", title: "do A" } }));
  store.post(item("Z2", { order: 9, trigger: { kind: "after", id: "B", title: "do B" } }));
  await settle();

  await pick.hold(store.get("A"));
  await settle();
  const mg = store.list().find((r) => r.origin?.startsWith("smartpick:"));
  assert.ok(mg, "the merge went in");
  assert.equal(store.get("Z1").trigger.id, mg.id, "both chains were re-pointed at the row that WILL finish");
  assert.equal(store.get("Z2").trigger.id, mg.id);

  const res = pick.undo(mg.id);
  await settle();
  assert.equal(res.ok, true);

  const z1 = store.get("Z1"), z2 = store.get("Z2");
  assert.notEqual(z1.state, "failed", `Z1 was failed by the undo: ${z1.result?.detail ?? ""}`);
  assert.notEqual(z2.state, "failed", `Z2 was failed by the undo: ${z2.result?.detail ?? ""}`);
  assert.equal(z1.trigger.id, "A", "…and each edge went back exactly where it came from");
  assert.equal(z2.trigger.id, "B");
  assert.equal(z1.trigger.title, "do A");
  assert.equal(store.get(mg.id), undefined, "the machine-written row is gone, last of all");
  assert.equal(store.get("A").archived, undefined, "and both originals are back");
  assert.equal(store.get("B").archived, undefined);
  done();
});

test("a post-run put-back keeps the merged row, archived, and its chain edges go back too", async () => {
  // The other direction of the same order rule: the merged row is ARCHIVED
  // rather than removed (it is the only account of the session that ran it), so
  // the chains are re-pointed while it is still there and are never orphaned.
  const { store, state, done } = makeStore();
  const pick = makePick(store, state);
  await store.reconcile();
  store.post(item("A", { order: 0 }));
  store.post(item("B", { order: 1 }));
  store.post(item("C", { order: 2 }));
  store.post(item("Z1", { order: 8, trigger: { kind: "after", id: "B", title: "do B" } }));
  await settle();

  await pick.hold(store.get("A"));
  await settle();
  const mg = store.list().find((r) => r.origin?.startsWith("smartpick:"));
  store.get(mg.id).state = "running";

  const res = pick.undo(mg.id);
  await settle();
  assert.equal(res.ok, true);
  assert.equal(res.ran, true);
  assert.ok(store.get(mg.id), "the row that is running is not deleted out from under its session");
  assert.equal(store.get(mg.id).archived, true);
  assert.notEqual(store.get("Z1").state, "failed");
  assert.equal(store.get("Z1").trigger.id, "B");
  done();
});

test("the row that fires after a merge is one a PERSON wrote, and only one of them", () => {
  // Two rules at once, both of them about the breath immediately after an apply.
  // The list is held at the cap while the pass runs (a repo with slots open and
  // one waiting item simply fires it — there is nothing to decide), then the cap
  // is lifted and the tick is let go:
  //
  //  • the merged row does NOT fire, because `applySmartPick` may name it as the
  //    pick and the notification has just promised an undo on it;
  //  • exactly one item starts, because `serial` is what stands between five due
  //    rows and five agents in one worktree.
  const h = makeStore();
  return (async () => {
    const { store, state, done } = h;
    const pick = makePick(store, state);
    await store.reconcile();
    store.post(item("A", { order: 0 }));
    store.post(item("B", { order: 1 }));
    store.post(item("C", { order: 2 }));
    await settle();
    assert.equal(state.ran.length, 0, "the cap is holding the whole list still");

    await pick.hold(store.get("A"));
    await settle();
    const mg = store.list().find((r) => r.origin?.startsWith("smartpick:"));
    assert.ok(mg, "the merge went in");

    state.slots = 3;
    store.kick();
    await settle(60);
    const runs = state.ran.filter((r) => r.name === "freshSession");
    assert.equal(runs.length, 1, `one at a time in one repo, got ${JSON.stringify(runs)}`);
    assert.notEqual(runs[0].id, mg.id, "the merged row did not fire in the breath that wrote it");
    done();
  })();
});

test("a merged row is never folded AGAIN — the sidecar cannot represent a nested merge", async () => {
  // `mg` comes out of a merge auto, repo-targeted and `queued`, so a later pass
  // is offered it like any other candidate. Two things break if one is taken:
  // `reindex()` writes `index[mg] = {mergedFrom}` and then `index[mg] =
  // {mergedInto: mg2}`, one `Map.set` overwriting the other, so the row shows one
  // of its two chips; and `undo(mg)` taken before `undo(mg2)` puts A and B back
  // in the queue while `mg2` still carries their words — the work runs twice and
  // nothing says so.
  const { store, state, done } = makeStore();
  const pick = makePick(store, state);
  await store.reconcile();
  store.post(item("A", { order: 0 }));
  store.post(item("B", { order: 1 }));
  store.post(item("C", { order: 2 }));
  await settle();

  await pick.hold(store.get("A"));
  await settle();
  const mg = store.list().find((r) => r.origin?.startsWith("smartpick:"));
  assert.ok(mg, "the first merge went in");
  assert.deepEqual(pick.rowFacts(mg.id)?.mergedFrom, ["A", "B"]);

  // Something new arrives, so the fingerprint moves and a second pass is worth
  // buying (rung 6 would otherwise say "nothing has changed" — an applied pass
  // records the fingerprint it LEFT BEHIND).
  store.post(item("D", { order: 3 }));
  await settle();

  // A second pass proposes folding the merged row together with C.
  const nested = new SmartPick({
    root: state.root, intents: store, isOn: () => true,
    facts: async () => ({ branch: "main", dirty: [], commits: [] }),
    run: async () => {
      await settle(0);
      return {
        text: JSON.stringify({
          pick: mg.id, order: [mg.id, "C"],
          merges: [{ ids: [mg.id, "C"], text: "everything at once", why: "one job" }],
          why: "one job",
        }),
        failed: false, limited: false, durationMs: 1,
      };
    },
    onChange: () => {},
  });
  state.holder = nested;
  // Held on C, not on `mg`: rung 4 refuses a pass whose ROW is a merged row the
  // machinery wrote in the last 30 s, and that guard is about the undo window,
  // not about what a merge may contain.
  await nested.hold(store.get("C"));
  await settle();

  const rows = store.list().filter((r) => r.origin?.startsWith("smartpick:") && !r.archived);
  assert.equal(rows.length, 1, "there is still exactly one machine-written row");
  assert.equal(rows[0].id, mg.id);
  assert.equal(store.get("C").archived, undefined, "C was not folded into a row nothing could unwind");
  // The chips still say both halves of the ONE merge that happened.
  assert.deepEqual(nested.rowFacts(mg.id)?.mergedFrom, ["A", "B"]);
  assert.equal(nested.rowFacts("A")?.mergedInto, mg.id);
  // …and the pass said so rather than silently dropping it.
  const pass = nested.summary(REPO);
  assert.match(JSON.stringify(pass ?? {}), /already a merged item/);
  done();
});
