/**
 * The last thing asked before a work item fires — `IntentDeps.pickHold`.
 *
 * The backlog's smart pick holds a repo's next item for a few seconds while a
 * cheap headless pass looks over that repo's other waiting items. Phase 0 ships
 * only the seam: no pass exists yet, nothing is ticked on anywhere, and a host
 * that supplies no `pickHold` must behave EXACTLY as it did before the dep
 * existed. That last sentence is the whole of this phase's claim to being
 * shippable on its own, and it is pinned first below.
 *
 * Everything else here is about the shape of the hold, and every one of them is
 * a way this could quietly break something that works today:
 *
 *  • **A held row is `blocked`, never `starting`.** A `starting` row claims its
 *    worktree (`busyCwds`), sets `hostBusy` for every `holdForHost` row on the
 *    desktop and spends one of the automatic-session slots. If a hold claimed
 *    any of that, one repo thinking for twenty seconds would stop every other
 *    repo — which is not what a per-repo tick-box may cost.
 *  • **The manager does not de-dupe, and must not.** `serial` bites only once
 *    something has been CLAIMED, and a held row claims nothing, so the second
 *    row of the same worktree reaches the hook in the SAME pass. It is asked
 *    too, and the DEP answers both out of one in-flight look — because whether
 *    two calls are the same "pick" depends on a fingerprint over items, branch,
 *    dirty paths and commit subjects, none of which this module has ever heard
 *    of. A de-dupe written in the manager would be a second opinion about the
 *    same question, and the two would drift.
 *  • **It never types.** This feature reads a list and reorders it; it may not
 *    reach a session. The pins below assert that during a hold NO executor was
 *    called at all — not `deliver`, not `freshSession`, not one of them.
 *  • **A person's tap is not a pick.** `runNow` never asks, because holding
 *    somebody's finger for twenty seconds while machinery reconsiders is not
 *    what they pressed.
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

const REPO = "/tmp/waterplane-pickhold-repo";
const OTHER = "/tmp/waterplane-pickhold-other";

/** The sentence a real hold carries — `intentReasonText("picking")`. */
const LOOKING = "looking over this repo's waiting items before picking the next one — a few seconds";

/**
 * A store over its own temp root.
 *
 * `hold` is the fake smart pick: `(row) => string | null`, recorded into
 * `state.asked` on the way in so a test can say WHICH rows were offered as well
 * as what happened to them. Left out entirely, no `pickHold` dep is supplied at
 * all — which is the "nothing changed" case and is a different thing from a dep
 * that always answers `null`.
 */
function makeStore({ hold, slots = 3, ...over } = {}) {
  const root = mkdtempSync(join(tmpdir(), "waterplane-pickhold-"));
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
    /** EVERY executor call, whichever it was — a hold may reach none. */
    ran: [],
    /** Every row `pickHold` was offered, in order. */
    asked: [],
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
    reapAutoSession: () => null,
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
    ...(hold ? { pickHold: async (row) => { state.asked.push(row.id); return hold(row); } } : {}),
    ...over,
  });
  const done = () => { store.stop(); rmSync(root, { recursive: true, force: true }); };
  return { store, state, done };
}

/** An ordinary automatic work item: repo target, `idle` trigger, `serial`. */
const item = (id, { cwd = REPO, order = 0, label = "an item" } = {}) =>
  backlogDraft({ id, cwd, text: `do ${id}`, label, order });

const settle = () => new Promise((r) => setTimeout(r, 30));

// ── 1. absent is today, exactly ─────────────────────────────────────────────

test("with NO pickHold dep at all, a work item fires exactly as it always did", async () => {
  const { store, state, done } = makeStore();
  await store.reconcile();
  store.post(item("a"));
  store.kick();
  await settle();
  assert.deepEqual(state.ran.map((r) => r.name), ["freshSession"]);
  assert.deepEqual(state.asked, [], "there was nobody to ask");
  assert.equal(store.get("a").state, "done");
  done();
});

test("a pickHold that answers null is also today, exactly", async () => {
  const { store, state, done } = makeStore({ hold: () => null });
  await store.reconcile();
  store.post(item("a"));
  store.kick();
  await settle();
  assert.deepEqual(state.asked, ["a"]);
  assert.deepEqual(state.ran.map((r) => r.name), ["freshSession"], "asked and released in the same pass");
  assert.equal(store.get("a").state, "done");
  done();
});

// ── 2. a hold is a wait, and it types nothing ───────────────────────────────

test("a hold blocks the row `picking` with the dep's own sentence, and runs NOTHING", async () => {
  const { store, state, done } = makeStore({ hold: () => LOOKING });
  await store.reconcile();
  store.post(item("a"));
  store.kick();
  await settle();

  const row = store.get("a");
  assert.equal(row.state, "blocked", "a hold is a WAIT the row wears, not a claim");
  assert.equal(row.blockReason, "picking");
  assert.equal(row.blockDetail, LOOKING, "the sentence arrives finished and is stored as is");
  // The rule the whole feature lives under: it reads a list, it does not type.
  assert.deepEqual(state.ran, [], "no executor at all — not deliver, not freshSession, none");
  assert.equal(row.startedAt, undefined, "nothing started");
  assert.equal(row.sessionId, undefined, "and no session was opened for it");
  done();
});

test("the hold is re-asked every pass, and the row fires the moment it lifts", async () => {
  // Nothing here is armed with a timer, exactly as nothing else in this store
  // is: a tick re-asks. That is what makes every way a pass can end — an
  // answer, a watchdog, a failure, a usage limit — release the row on its own,
  // with no code in the manager that knows any of those endings exist.
  let held = true;
  const { store, state, done } = makeStore({ hold: () => (held ? LOOKING : null) });
  await store.reconcile();
  store.post(item("a"));
  store.kick();
  await settle();
  assert.equal(store.get("a").state, "blocked");
  assert.deepEqual(state.ran, []);

  held = false;
  store.kick();
  await settle();
  assert.deepEqual(state.ran.map((r) => r.name), ["freshSession"], "released, it fires");
  assert.equal(store.get("a").state, "done");
  done();
});

// ── 3. a held row claims nothing ────────────────────────────────────────────

test("a held row spends no automatic-session slot — another repo fires behind it", async () => {
  // The number that makes this visible: ONE slot. If the hold consumed it, the
  // other repo's item would block `noSlot`, and a tick-box on one repo would
  // have stopped a repo that never ticked it on.
  const { store, state, done } = makeStore({ slots: 1, hold: (row) => (row.cwd === REPO ? LOOKING : null) });
  await store.reconcile();
  store.post(item("a", { cwd: REPO }));
  store.post(item("b", { cwd: OTHER, order: 1 }));
  // `post()` kicks, so the first pass started with only the first row in it —
  // let it finish, then take a pass that has both, which is every pass the real
  // 2 s tick makes.
  await settle();
  store.kick();
  await settle();

  assert.equal(store.get("a").state, "blocked");
  assert.equal(store.get("a").blockReason, "picking");
  assert.deepEqual(state.ran.map((r) => r.id), ["b"], "the other repo kept moving");
  done();
});

test("a held row does not make the desktop look busy to a holdForHost row", async () => {
  // `holdForHost` is *wait until nothing on this desktop is starting or
  // running*. A hold is neither, and a row that set `hostBusy` while merely
  // thinking would park every such row on every other repo for the duration.
  const { store, state, done } = makeStore({ hold: (row) => (row.cwd === REPO ? LOOKING : null) });
  await store.reconcile();
  store.post(item("a", { cwd: REPO }));
  store.post({ ...item("b", { cwd: OTHER, order: 1 }), holdForHost: true });
  await settle();
  store.kick();
  await settle();

  assert.equal(store.get("a").blockReason, "picking");
  assert.deepEqual(state.ran.map((r) => r.id), ["b"], "the wait-until-free row still saw a free desktop");
  done();
});

// ── 4. the manager does not de-dupe, because it cannot ──────────────────────

test("BOTH rows of one repo reach the hook in one pass — the dep is what de-dupes", async () => {
  // `serial` blocks the second row of a worktree only once the first has been
  // CLAIMED. A hold claims nothing, so the second row arrives here too, in the
  // same pass, and is asked in its own right. A real dep answers both out of
  // one in-flight look keyed on the cwd; this test's job is to prove the second
  // call happens at all, because a manager that quietly skipped it would make
  // that per-cwd key look unnecessary right up until it was not.
  const seen = [];
  const { store, state, done } = makeStore({ hold: (row) => { seen.push(row.cwd); return LOOKING; } });
  await store.reconcile();
  store.post(item("a", { order: 0 }));
  store.post(item("b", { order: 1 }));
  // `post()` kicks, so the first pass started with only the first row in it.
  // Let it finish, then take a pass that has both — which is every pass the
  // real 2 s tick makes.
  await settle();
  state.asked.length = 0;
  seen.length = 0;
  store.kick();
  await settle();

  assert.deepEqual(state.asked, ["a", "b"], "the second row of the same repo was asked too");
  assert.deepEqual(seen, [REPO, REPO], "…and asked about the same worktree");
  assert.equal(store.get("a").blockReason, "picking");
  assert.equal(store.get("b").blockReason, "picking");
  assert.deepEqual(state.ran, [], "and neither of them ran");
  done();
});

// ── 5. what is never asked, and what always is ──────────────────────────────

test("runNow never asks — a tap is not a pick, even on a row already held", async () => {
  const { store, state, done } = makeStore({ hold: () => LOOKING });
  await store.reconcile();
  store.post(item("a"));
  await settle();
  assert.equal(store.get("a").blockReason, "picking", "the tick has it held");

  state.asked.length = 0;
  const r = await store.runNow("a");
  assert.equal(r.ok, true);
  await settle();
  assert.deepEqual(state.asked, [], "nobody was asked about a row a person fired themselves");
  assert.deepEqual(state.ran.map((x) => x.name), ["freshSession"], "it just ran");
  done();
});

test("every row that reaches `go` is offered to the dep — the filtering is the DEP's", async () => {
  // Deliberately NOT filtered in the manager. It does not know what a candidate
  // for a pick is: that depends on the repo's tick-box, on how many items are
  // waiting and on a fingerprint, and a shape test written here would be a
  // second, drifting copy of a judgement that lives somewhere else. The real
  // dep's first line is a `Set` lookup on the cwd, so an un-ticked repo costs
  // one call and nothing else — and `null` fires the row in the same pass.
  const { store, state, done } = makeStore({ hold: () => null });
  await store.reconcile();
  // A pinned, session-targeted row: a person aimed this one, and the dep is
  // what decides it is not a pick candidate.
  state.sessions.push({ id: "s1", cwd: REPO, running: true, turnActive: false, idleMs: 99_000 });
  store.post(backlogDraft({ id: "p", cwd: REPO, text: "typed at a session", order: 0, targetSessionId: "s1", autoFire: true }));
  store.kick();
  await settle();

  assert.deepEqual(state.asked, ["p"], "offered to the dep");
  assert.deepEqual(state.ran.map((x) => x.name), ["deliver"], "and fired, because the dep said go");
  done();
});

// ── 5. the facts a hold spans ───────────────────────────────────────────────

test("a hand fire DURING a hold does not put two agents in one worktree", async () => {
  // Every fact the ladder answered with — `busyCwds`, `busySessions`,
  // `hostBusy`, `autoSlotsFree` — is computed at the top of the pass, and the
  // pick hold is the first `await` inside the loop. A real hold spawns `git`
  // (30–200 ms, longer on a cold cache in a big repo), and `backlog.fire` →
  // `runNow` reaches `fire()` DIRECTLY, not through this loop. Reproduced
  // against the real store: `ran = ["B", "A"]`, both `starting`, one cwd —
  // precisely the "five due rows putting five agents in one worktree" that
  // `serial` exists to stop.
  //
  // Everything here is shaped to make that window real: the hold resolves on a
  // MACROTASK (a microtask would not let `runNow` in) and the executor stays
  // pending, the way a spawn plus a delivery does.
  let release;
  let pending;
  const { store, state, done } = makeStore({
    hold: (row) => (row.id === "a" ? new Promise((r) => { release = r; }) : null),
  });
  // An executor that does NOT return — a row is `starting` for the whole of a
  // delivery, which is exactly the window this is about.
  const exec = (name) => (i) => { state.ran.push({ name, id: i.id, cwd: i.cwd }); return new Promise((r) => { pending = r; }); };
  store.deps.executors.freshSession = exec("freshSession");

  await store.reconcile();
  store.post(item("a", { order: 0 }));
  store.post(item("b", { order: 1 }));
  store.kick();
  await settle();
  assert.deepEqual(state.asked, ["a"], "the pass is holding the front row");

  // A person taps fire on the row behind it, which never asks the dep.
  void store.runNow("b");
  await settle();
  assert.deepEqual(state.ran.map((r) => r.id), ["b"], "the tap ran, as a tap must");

  // …and now the look comes back "go".
  release(null);
  await settle();
  assert.deepEqual(state.ran.map((r) => r.id), ["b"], "the held row did NOT fire on a verdict taken before the tap");
  assert.equal(store.get("a").state, "blocked");
  assert.equal(store.get("a").blockReason, "serial", "it says what is in its way, in the store's own words");
  pending?.({ ok: true, detail: "done" });
  done();
});

test("a slot spent during a hold is seen by the row that was being held", async () => {
  // The same staleness, on the cap rather than on `serial`. With one slot free
  // at the top of the pass and a person's tap spending it during the hold, the
  // held row used to fire on the snapshot and open a second automatic session.
  let release;
  let pending;
  const { store, state, done } = makeStore({
    slots: 1,
    hold: (row) => (row.id === "a" ? new Promise((r) => { release = r; }) : null),
  });
  const exec = (name) => (i) => { state.ran.push({ name, id: i.id }); return new Promise((r) => { pending = r; }); };
  store.deps.executors.freshSession = exec("freshSession");
  await store.reconcile();
  store.post(item("a", { cwd: REPO, order: 0 }));
  store.post(item("b", { cwd: OTHER, order: 1 }));
  store.kick();
  await settle();

  void store.runNow("b");
  await settle();
  state.slots = 0; // the host's live count: the tap's session is real
  release(null);
  await settle();
  assert.deepEqual(state.ran.map((r) => r.id), ["b"], "the cap was re-read on the other side of the await");
  assert.equal(store.get("a").blockReason, "noSlot");
  pending?.({ ok: true, detail: "done" });
  done();
});

test("the post-hold re-read does not count this pass's own fires twice", async () => {
  // The re-ask on the far side of the hold (`base.autoSlotsFree = min(base,
  // deps.autoSlotsFree())`) used to subtract this pass's own fires from the
  // host's live count as well — and the live count already holds them, because
  // a fired row's session exists synchronously. The figure came back one per
  // fire below the truth.
  //
  // Reproduced here, which is also the shape it has on the real host: the
  // re-ask runs for every `go` row whenever the `pickHold` dep exists, so a
  // desktop with smart pick installed and every repo un-ticked hit it on every
  // pass that fired two rows. The third row read `noSlot` with a slot genuinely
  // free, and — worse — asked `reapAutoSession()`, which closes the oldest idle
  // automatic session: a finished item somebody may still have wanted to read,
  // destroyed to make room that was already there.
  let reaps = 0;
  let armed = false;
  const { store, state, done } = makeStore({
    slots: 3,
    hold: () => null,                       // smart pick present, every repo un-ticked
    reapAutoSession: () => { reaps++; return null; },
    // Posted with the gate shut and opened once, so all three rows are in ONE
    // pass — which is the whole claim: `post()` kicks, and three posts that each
    // started their own pass would be testing three passes.
    autoFire: () => armed,
  });
  await store.reconcile();
  store.post(item("a", { cwd: "/tmp/waterplane-pickhold-a", order: 0 }));
  store.post(item("b", { cwd: "/tmp/waterplane-pickhold-b", order: 1 }));
  store.post(item("c", { cwd: "/tmp/waterplane-pickhold-c", order: 2 }));
  armed = true;
  await store.pass();
  await settle();

  assert.deepEqual(state.asked, ["a", "b", "c"], "every go row is offered to the dep");
  assert.deepEqual(state.ran.map((r) => r.id), ["a", "b", "c"], "three rows, three slots, three fires");
  assert.equal(reaps, 0, "nothing was closed to make room that was already there");
  done();
});

test("…and the cap still bites when it really is full", async () => {
  // The other half, so the fix above cannot be "stop reading the cap". Cap 2,
  // three due rows in three repos: the third waits, and asks for a reap ONCE.
  let reaps = 0;
  let armed = false;
  const { store, state, done } = makeStore({
    slots: 2,
    hold: () => null,
    reapAutoSession: () => { reaps++; return null; },
    autoFire: () => armed,
  });
  await store.reconcile();
  store.post(item("a", { cwd: "/tmp/waterplane-pickhold-a", order: 0 }));
  store.post(item("b", { cwd: "/tmp/waterplane-pickhold-b", order: 1 }));
  store.post(item("c", { cwd: "/tmp/waterplane-pickhold-c", order: 2 }));
  armed = true;
  await store.pass();
  await settle();

  assert.deepEqual(state.ran.map((r) => r.id), ["a", "b"]);
  assert.equal(store.get("c").blockReason, "noSlot");
  assert.equal(reaps, 1, "asked once per pass, never once per blocked row");
  done();
});
