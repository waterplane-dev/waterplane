/**
 * What a SCHEDULE is still allowed to claim about itself, and where its work goes.
 *
 * Four rules, each of which failed silently in the field and none of which an
 * e2e could have caught by watching a screen — the store said one thing, the
 * sheet drew another, and the only symptom was a row that sat there looking
 * armed:
 *
 *  1. a terminal one-off is NOT armed (`nextAt` null), or the phone renders a
 *     countdown to a fire the tick will never make (`inWords(nextAt)` on a row
 *     `isTerminal` skips — measured: a missed `once` wore "due now" for a day);
 *  2. running one BY HAND does not spend its own occurrence, which is what the
 *     button promises and what settling it terminal quietly took away;
 *  3. a row written by the OLD lifecycle is corrected on the way in, since
 *     nothing else will ever look at it again;
 *  4. automatic work opens a session PER ITEM, bounded by a cap the ladder
 *     reads as a rung, and the cap frees itself by reaping — never by running
 *     the item twice, and never by closing a session with work in it.
 *
 * Fake deps and a temp root: the store is the thing under test, and every fact
 * it reads is a function it was handed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { IntentManager } = await import("../dist/intents/manager.js");
const { scheduleToIntent, intentToSchedule, intentToBacklogItem, backlogDraft, workItemInherits } = await import("../dist/intents/adapters.js");
const { scheduleItemOrigin, scheduleIdFromOrigin } = await import("@waterplane/shared");

const REPO = "/tmp/waterplane-sched-repo";
const HOUR = 3_600_000;

/** A store over its own temp root, plus the levers each test needs. */
function makeStore(over = {}) {
  const root = mkdtempSync(join(tmpdir(), "waterplane-sched-"));
  const state = {
    root,
    /** Sessions the fake host has live. */
    sessions: [],
    /** What `repoSession` answers — null is "no session of this repo's own". */
    backlogSession: null,
    /** Sessions machinery may still open — `IntentFacts.autoSlotsFree`. */
    slots: 3,
    /** What `reapAutoSession` answers, and how many times it was asked. */
    reapable: null,
    reaps: 0,
    /** Executor calls, in order. */
    ran: [],
    /** What every executor answers. */
    result: { ok: true, detail: "delivered" },
  };
  const exec = (name) => async (i) => { state.ran.push({ name, id: i.id }); return state.result; };
  const store = new IntentManager({
    root,
    sessions: () => state.sessions,
    sessionAlive: (id) => state.sessions.some((s) => s.id === id && s.running !== false),
    repoSession: () => state.backlogSession,
    repoAnySession: (cwd) => state.sessions.some((s) => s.running !== false && s.cwd === cwd),
    autoSlotsFree: () => state.slots,
    autoSlotsDetail: () => (state.slots > 0 ? undefined : "waiting for a free slot — this desktop runs 1 automatic session at a time and 1 is busy"),
    reapAutoSession: () => {
      state.reaps++;
      if (!state.reapable) return null;
      const id = state.reapable;
      state.reapable = null;
      state.sessions = state.sessions.filter((x) => x.id !== id);
      state.slots += 1;
      return id;
    },
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
    onChange: () => {},
    ...over,
  });
  return { store, state, root };
}

/** A one-off schedule, due `inMs` from now (negative = already passed). */
const onceAt = (id, at, extra = {}) => ({
  id,
  cwd: REPO,
  payload: { kind: "prompt", steps: ["do the thing"] },
  target: { kind: "repo", fresh: true },
  trigger: { kind: "at", rule: { kind: "once", at, offsetMin: 0 }, graceMin: 120 },
  title: "a one-off",
  ...extra,
});

/** The store's file is `{ schema, intents }` from schema 2 on — the version that
 *  records "a session per work item". Read through the envelope, never around
 *  it: a helper that only understood the v1 array would make every assertion
 *  below silently vacuous the day the shape changed again. */
const storeFile = (root) => JSON.parse(readFileSync(join(root, ".waterplane", "intents.json"), "utf8"));
const rowsOnDisk = (root) => storeFile(root).intents;
const settle = () => new Promise((r) => setTimeout(r, 30));

// ── 1. a terminal one-off is not armed ──────────────────────────────────────

test("a one-off past its grace fails AND stops claiming a next run", async () => {
  const { store, root } = makeStore();
  await store.reconcile();
  const posted = store.post(onceAt("s1", Date.now() - 4 * HOUR));
  assert.equal(posted.ok, true);
  // Armed on the way in (the occurrence is inside `armFrom`'s floor only if it
  // is recent — four hours back with a two-hour grace is not).
  store.kick();
  await settle();
  const row = store.get("s1");
  assert.equal(row.state, "failed", "past the grace window, a once is failed");
  assert.equal(row.nextAt, null, "a terminal one-off must not carry a next fire");
  assert.match(row.result.detail, /one-off/);
  assert.equal(rowsOnDisk(root).find((r) => r.id === "s1").nextAt, null, "…on disk too");
  store.stop();
  rmSync(root, { recursive: true, force: true });
});

test("a one-off saved AFTER its instant still runs, late, and says so", async () => {
  const { store, state, root } = makeStore();
  await store.reconcile();
  // The offline case: written at 20:58 for 21:00, delivered at 21:05. Inside the
  // grace window, so it runs — arming it from `createdAt` made it fail on
  // arrival with "post it again", the words still sitting in the row.
  store.post(onceAt("s2", Date.now() - 5 * 60_000));
  store.kick();
  await settle();
  assert.deepEqual(state.ran.map((r) => r.name), ["freshSession"]);
  const row = store.get("s2");
  assert.equal(row.state, "done");
  assert.equal(row.nextAt, null);
  assert.equal(row.lastOccurrence > 0, true, "its occurrence is spent");
  assert.equal(row.result.late, true, "and the row says it ran late");
  store.stop();
  rmSync(root, { recursive: true, force: true });
});

// ── 2. running it by hand does not spend the schedule ────────────────────────
//
// …and "the schedule" is now exactly the rows that HAVE a next run: a standing
// rule, and a one-off SWEEP. A one-off aimed at ONE place is work with a clock
// on it (`isTimedWorkRow`), its clock is spent by its one run, and returning it
// to `queued` after a hand fire would leave a work item that has already run
// sitting in the backlog waiting to run again.

/** A one-off SWEEP: `repos`, so it has no single backlog to live in and stays a
 *  schedule card until it is spent. */
const onceSweep = (id, at, extra = {}) => ({
  id,
  cwd: REPO,
  payload: { kind: "prompt", steps: ["audit every repo"] },
  target: { kind: "repos", dirs: [REPO] },
  trigger: { kind: "at", rule: { kind: "once", at, offsetMin: 0 }, graceMin: 120 },
  title: "a one-off sweep",
  ...extra,
});

test("run now fires a one-off SWEEP without consuming the scheduled occurrence", async () => {
  const { store, state, root } = makeStore();
  await store.reconcile();
  const at = Date.now() + 2 * HOUR;
  store.post(onceSweep("s3", at));
  const r = await store.runNow("s3");
  assert.equal(r.ok, true);
  await settle();
  assert.deepEqual(state.ran.map((x) => x.name), ["sweep"], "it really ran");
  const row = store.get("s3");
  assert.equal(row.state, "queued", "still waiting for its own clock");
  assert.equal(row.nextAt, at, "the occurrence was not spent");
  assert.equal(row.lastOccurrence, undefined);
  // …and it still fires at its time.
  state.ran.length = 0;
  row.nextAt = Date.now() - 1000;
  store.kick();
  await settle();
  assert.deepEqual(state.ran.map((x) => x.name), ["sweep"], "the schedule itself still fires");
  assert.equal(store.get("s3").state, "done");
  store.stop();
  rmSync(root, { recursive: true, force: true });
});

test("a hand-run TIMED WORK row settles, because it has no next run to protect", async () => {
  // The promise the branch above keeps — "this does not use up the next
  // scheduled run" — describes nothing for a one-off work item: there is no
  // next run. Kept anyway, it fired the row and then put it straight back in
  // the queue, so the tick ran the same words a second time when the instant
  // came round.
  const { store, state, root } = makeStore();
  await store.reconcile();
  store.post(onceAt("s3w", Date.now() + 2 * HOUR));
  const r = await store.runNow("s3w");
  assert.equal(r.ok, true);
  await settle();
  assert.deepEqual(state.ran.map((x) => x.name), ["freshSession"],
    "it runs ITSELF — a one-off never had a second row to make");
  const row = store.get("s3w");
  assert.equal(row.state, "done", "a work item settles like any other work item");
  assert.equal(row.nextAt, null, "…and stops claiming a run it no longer has");
  // The instant it was posted for arrives: nothing happens, because nothing is
  // waiting for it.
  state.ran.length = 0;
  store.kick();
  await settle();
  assert.equal(state.ran.length, 0, "one piece of work, one run");
  store.stop();
  rmSync(root, { recursive: true, force: true });
});

test("run now revives a SPENT one-off instead of refusing it", async () => {
  const { store, state, root } = makeStore();
  await store.reconcile();
  store.post(onceAt("s4", Date.now() - 4 * HOUR));
  store.kick();
  await settle();
  assert.equal(store.get("s4").state, "failed");
  state.ran.length = 0;
  const r = await store.runNow("s4");
  assert.equal(r.ok, true, "the words are still there — a person may still mean them");
  await settle();
  assert.deepEqual(state.ran.map((x) => x.name), ["freshSession"]);
  store.stop();
  rmSync(root, { recursive: true, force: true });
});

// ── 2b. pausing, and sitting out exactly one run ─────────────────────────────

/** A weekly rule: every day at an hour that has already passed today, so the
 *  next occurrence is tomorrow and nothing fires during the test. */
const weekly = (id) => ({
  id, cwd: REPO,
  payload: { kind: "prompt", steps: ["the weekly sweep"] },
  target: { kind: "repo", fresh: true },
  trigger: { kind: "at", rule: { kind: "weekly", days: [], hour: 4, minute: 0, tz: "UTC", offsetMin: 0 }, graceMin: 120 },
  title: "a standing rule",
});

test("skip next spends the pending occurrence and arms the one after it", async () => {
  const { store, state, root } = makeStore();
  await store.reconcile();
  store.post(weekly("r1"));
  const first = store.get("r1").nextAt;
  assert.equal(typeof first, "number");
  const r = store.skipNext("r1");
  assert.equal(r.ok, true);
  const row = store.get("r1");
  assert.equal(row.lastOccurrence, first, "the skipped occurrence is SPENT, not stepped over");
  assert.equal(row.nextAt > first, true, "…and the one after it is armed");
  assert.match(row.result.detail, /skipped/);
  store.kick();
  await settle();
  assert.equal(state.ran.length, 0, "nothing ran — that is the whole point");
  store.stop();
  rmSync(root, { recursive: true, force: true });
});

test("skip next is refused for a one-off, whose only run is the one it has", async () => {
  const { store, root } = makeStore();
  await store.reconcile();
  store.post(onceAt("r2", Date.now() + HOUR));
  const r = store.skipNext("r2");
  assert.equal(r.ok, false);
  assert.match(r.reason, /one-off/);
  assert.equal(store.get("r2").nextAt > Date.now(), true, "and it is still armed");
  store.stop();
  rmSync(root, { recursive: true, force: true });
});

test("pause holds a standing rule; resume re-arms it from NOW", async () => {
  const { store, state, root } = makeStore();
  await store.reconcile();
  store.post(weekly("r3"));
  assert.equal(store.setArmed("r3", false), true);
  assert.equal(store.get("r3").nextAt, null, "paused is `nextAt === null` — the one explicit 'nothing is armed'");
  store.kick();
  await settle();
  assert.equal(state.ran.length, 0);
  assert.equal(store.setArmed("r3", true), true);
  const back = store.get("r3");
  assert.equal(back.nextAt > Date.now(), true, "resumed at its own next occurrence, never at one it slept through");
  store.stop();
  rmSync(root, { recursive: true, force: true });
});

// ── 3. rows the old lifecycle wrote ──────────────────────────────────────────

test("a stored terminal one-off is corrected on load", async () => {
  const root = mkdtempSync(join(tmpdir(), "waterplane-sched-old-"));
  mkdirSync(join(root, ".waterplane"), { recursive: true });
  const past = Date.now() - HOUR;
  const future = Date.now() + HOUR;
  writeFileSync(join(root, ".waterplane", "intents.json"), JSON.stringify([
    // failed, still advertising a fire that already passed
    { ...onceAt("old-failed", past), state: "failed", nextAt: past, createdAt: past, settledAt: past,
      result: { at: past, ok: false, detail: "missed" } },
    // done, occurrence never spent, still ahead — the fingerprint of a hand run
    { ...onceAt("old-handrun", future), state: "done", nextAt: future, createdAt: past, settledAt: past,
      result: { at: past, ok: true, detail: "queued" } },
  ]));
  const { store } = makeStore({ root });
  assert.equal(store.get("old-failed").nextAt, null, "a terminal one-off claims no next run");
  const revived = store.get("old-handrun");
  assert.equal(revived.state, "queued", "its own occurrence is still ahead — it is still armed");
  assert.equal(revived.nextAt, future);
  store.stop();
  rmSync(root, { recursive: true, force: true });
});

// ── 4. automatic work gets a session of its own ──────────────────────────────

/** A work item: the plainest intent there is, aimed at a repo, auto-fire on. */
const workItem = (id, extra = {}) => ({
  id, cwd: REPO,
  payload: { kind: "prompt", steps: ["fix the thing"] },
  target: { kind: "repo" },
  trigger: { kind: "idle" },
  auto: true,
  ...extra,
});

test("auto work opens a session of its OWN, never the one a person is driving", async () => {
  const { store, state, root } = makeStore();
  state.sessions.push({ id: "s-hand", cwd: REPO, running: true });
  await store.reconcile();
  store.post(workItem("w1"));
  store.kick();
  await settle();
  // `freshSession`, not `deliver`: the row does not wait for a session to exist
  // and does not adopt the hand-driven one. This is the whole change — it used
  // to sit blocked for a pass while the host opened the repo's shared session,
  // then type into that.
  assert.deepEqual(state.ran.map((r) => r.name), ["freshSession"]);
  assert.equal(store.get("w1").state, "done");
  store.stop();
  rmSync(root, { recursive: true, force: true });
});

test("a row aimed at a session over its OWN budget waits, saying so — and run now fires it anyway", async () => {
  const held = new Set(["s-over"]);
  const { store, state, root } = makeStore({ budgetHeldSessions: () => held });
  state.sessions.push({ id: "s-over", cwd: REPO, running: true });
  await store.reconcile();
  store.post({ ...workItem("sb1"), target: { kind: "session", sessionId: "s-over" } });
  store.kick();
  await settle();
  assert.deepEqual(state.ran, [], "nothing is typed into a session past its cap");
  const row = store.get("sb1");
  assert.equal(row.state, "blocked");
  assert.equal(row.blockReason, "sessionBudget");
  // A person's tap is not unattended work: the hold is the queue's, not theirs.
  const r = await store.runNow("sb1");
  assert.equal(r.ok, true);
  await settle();
  assert.deepEqual(state.ran.map((x) => x.name), ["deliver"]);
  store.stop();
  rmSync(root, { recursive: true, force: true });
});

test("a repo-target row is not held by some session's budget, and its executor receives the row's budget", async () => {
  const seen = [];
  const budget = { unit: "usd", max: 1.5, interrupt: true };
  const { store, root } = makeStore({ budgetHeldSessions: () => new Set(["s-over"]) });
  store.deps.executors.freshSession = async (i) => { seen.push(i.budget); return { ok: true, detail: "delivered" }; };
  await store.reconcile();
  store.post(workItem("sb2", { budget }));
  store.kick();
  await settle();
  assert.deepEqual(seen, [budget], "the session the row opens is born with the row's budget");
  assert.equal(store.get("sb2").state, "done");
  store.stop();
  rmSync(root, { recursive: true, force: true });
});

test("re-saving a row from a draft that never heard of budgets keeps the budget", async () => {
  const { store, root } = makeStore();
  await store.reconcile();
  const budget = { unit: "weeklyPct", max: 2, interrupt: true };
  const at = Date.now() + 2 * HOUR;
  store.post(onceAt("sb3", at, { budget }));
  // `schedule.save` from an old bundle: the same row, re-timed, silent on it.
  store.upsert(onceAt("sb3", at + HOUR));
  assert.deepEqual(store.get("sb3").budget, budget);
  store.stop();
  rmSync(root, { recursive: true, force: true });
});

test("re-saving with budget: null CLEARS the cap; through schedule.save's own shape too", async () => {
  const { store, root } = makeStore();
  await store.reconcile();
  const budget = { unit: "usd", max: 1, interrupt: true };
  const at = Date.now() + 2 * HOUR;
  store.post(onceAt("sb4", at, { budget }));
  store.upsert(onceAt("sb4", at + HOUR, { budget: null }));
  assert.equal(store.get("sb4").budget, undefined, "a person blanking the field is a clear, not 'nobody said'");
  // The send sheet's re-time: `schedule.save` → `cleanAction` → `scheduleToIntent` → `upsert()`.
  const once = { id: "sch-bud", name: "groom", enabled: true, graceMin: 120, createdAt: Date.now() - HOUR,
    rule: { kind: "once", at: Date.now() + 2 * HOUR },
    action: { kind: "backlog", repoDir: REPO, text: "groom the notes", autoFire: true, budget } };
  store.post(scheduleToIntent(once, Date.now()));
  assert.deepEqual(store.get("sch-bud").budget, budget);
  store.upsert(scheduleToIntent({ ...once, action: { ...once.action, budget: undefined } }, Date.now()));
  assert.deepEqual(store.get("sch-bud").budget, budget, "silent keeps it");
  store.upsert(scheduleToIntent({ ...once, action: { ...once.action, budget: null } }, Date.now()));
  assert.equal(store.get("sch-bud").budget, undefined, "null clears it");
  store.stop();
  rmSync(root, { recursive: true, force: true });
});

test("the cap blocks the next item, says so in the host's numbers, and asks for a reap ONCE", async () => {
  const { store, state, root } = makeStore();
  state.slots = 0;
  await store.reconcile();
  store.post(workItem("cap1"));
  store.post(workItem("cap2", { cwd: "/tmp/waterplane-sched-b" }));
  store.kick();
  await settle();
  assert.equal(state.ran.length, 0, "no slot, nothing spawned");
  const row = store.get("cap1");
  assert.equal(row.blockReason, "noSlot");
  assert.match(row.blockDetail, /1 automatic session at a time/,
    "the numbers are the HOST's — the pure rule is handed the difference, never the ceiling");
  assert.equal(state.reaps, 1, "asked once per pass, however many rows are holding");
  store.stop();
  rmSync(root, { recursive: true, force: true });
});

test("the slot a reap frees goes to the row that ASKED, never to the one behind it", async () => {
  // `SKILL.md`'s "the freed slot is NOT claimed by the pass that freed it", and
  // the test below is NAMED for it — but it has one row, so it could not see the
  // other half. `base.autoSlotsFree += 1` handed the freed slot to every LATER
  // `go` row in the same pass, and the row that asked was `continue`d straight
  // past. Reproduced with a cap of 1: A (order 0) blocks `noSlot … closing an
  // idle one to make room` while B (order 1, another repo) takes A's slot and
  // runs; with three repos the inversion holds for as long as anything is
  // queued behind. The user's order is the whole of what makes a queue a queue.
  // The reap CLOSES a session, so the host's live count really does drop the
  // moment it succeeds — modelled here, because a fake that keeps answering
  // zero would hide the bug behind the re-read the pick hold does.
  const { store, state, root } = makeStore({
    reapAutoSession: () => { state.reaps++; if (!state.reapable) return null; state.slots += 1; return state.reapable; },
  });
  state.slots = 0;
  state.reapable = null;
  state.sessions.push({ id: "s-idle", cwd: "/tmp/waterplane-sched-other", running: true });
  await store.reconcile();
  store.post(workItem("front", { order: 0 }));
  store.post(workItem("behind", { cwd: "/tmp/waterplane-sched-b", order: 1 }));
  // Both rows have to be in the list BEFORE the reaping pass — a `post` kicks
  // the tick itself, so a pass that ran between the two would only ever see one
  // of them, which is the shape that hid this.
  await settle();
  assert.deepEqual(state.ran.map((r) => r.id), [], "nothing has a slot yet");

  // …and now there is an idle session to close.
  state.reapable = "s-idle";
  store.kick();
  await settle();

  assert.deepEqual(state.ran.map((r) => r.id), [], "nothing ran in the pass that reaped");
  assert.equal(store.get("front").blockReason, "noSlot");
  assert.match(store.get("front").blockDetail, /closing an idle one to make room/);
  assert.notEqual(store.get("behind").state, "starting", "and the row behind did not take it either");

  // The next tick's FRESH count hands it to the first row in order.
  state.reapable = null;
  store.kick();
  await settle();
  assert.deepEqual(state.ran.map((r) => r.id), ["front"]);
  store.stop();
  rmSync(root, { recursive: true, force: true });
});

test("a row following a resurrection asks about the SESSION that died, never about its directory", async () => {
  // `revivedSessionFor` was asked by CWD and answered "the newest live session
  // in that repo", and the window between a limit exit and its reset is HOURS.
  // Open a session by hand in that worktree in the meantime — or tap the sheet's
  // *open a session here* — and the row was re-aimed at the session a PERSON was
  // driving: their next Stop completed an item that had never run, while the
  // real `--continue` finished the work at the reset with no row watching it.
  const asked = [];
  const { store, state, root } = makeStore({
    diedAtLimit: (id) => id === "s-item",
    revivedSessionFor: (id) => { asked.push(id); return id === "s-item" ? "s-revived" : null; },
    sessionIdleMs: (id) => (state.sessions.some((x) => x.id === id) ? 0 : null),
  });
  state.result = { ok: true, detail: "ran", sessionId: "s-item", watch: "turn" };
  state.sessions.push({ id: "s-item", cwd: REPO, running: true });
  await store.reconcile();
  store.post(workItem("rev1"));
  store.kick();
  await settle();

  // The item's own session dies at the limit; a PERSON opens one in the same
  // repo while the reset is still hours away.
  state.sessions = [{ id: "s-hand", cwd: REPO, running: true }];
  store.onSessionExit("s-item");
  await settle();
  assert.ok(asked.length, "it asked");
  assert.ok(asked.every((id) => id === "s-item"), `asked about ${JSON.stringify(asked)} — a cwd is not a session`);
  assert.equal(store.get("rev1").state, "running", "held, following its own session and nobody else's");
  assert.notEqual(store.get("rev1").sessionId, "s-hand", "the person's session was NOT handed the row");
  store.stop();
  rmSync(root, { recursive: true, force: true });
});

test("a reap frees a slot, and the row runs on the NEXT tick rather than on the one that reaped", async () => {
  const { store, state, root } = makeStore();
  state.slots = 0;
  state.reapable = "s-idle";
  state.sessions.push({ id: "s-idle", cwd: "/tmp/waterplane-sched-other", running: true });
  await store.reconcile();
  store.post(workItem("reap1"));
  store.kick();
  await settle();
  assert.equal(state.ran.length, 0, "the slot it just freed is not claimed by the pass that freed it");
  assert.match(store.get("reap1").blockDetail, /closing an idle one to make room/);
  store.kick();
  await settle();
  assert.deepEqual(state.ran.map((r) => r.name), ["freshSession"]);
  store.stop();
  rmSync(root, { recursive: true, force: true });
});

test("a person's own item ignores the cap entirely", async () => {
  const { store, state, root } = makeStore();
  state.slots = 0;
  await store.reconcile();
  // `auto: false` is the tap. Same exemption shape as the gate and the budget:
  // a cap written for unattended work was never a statement about a person
  // spending a slot on purpose.
  store.post(workItem("hand1", { auto: false }));
  store.kick();
  await settle();
  assert.deepEqual(state.ran.map((r) => r.name), ["freshSession"]);
  store.stop();
  rmSync(root, { recursive: true, force: true });
});

test("a fresh row whose session dies at the limit FOLLOWS the revival — it is never requeued", async () => {
  // F8, and the sharpest rule in this change. Requeueing is what the shared
  // session did and what was right for it: `resolveRepoSession` followed the
  // resurrection, so the requeued row landed back in the same conversation. For
  // a row whose session was opened FOR IT, a requeue runs the work TWICE — the
  // host `--continue`s that conversation at the reset AND the queued row opens a
  // second session to run the same words in.
  let revived = null;
  const { store, state, root } = makeStore({
    diedAtLimit: (id) => id === "s-item",
    revivedSessionFor: () => revived,
    // A session that has JUST printed something, and NULL once it is gone — the
    // two facts this path turns on. The default fake answers a flat 99 s, which
    // is both the completion fallback for an unhooked session (the row would
    // settle `done` before it ever got to die) and, worse, an answer for a
    // session that no longer exists.
    sessionIdleMs: (id) => (state.sessions.some((x) => x.id === id) ? 0 : null),
  });
  state.result = { ok: true, detail: "ran", sessionId: "s-item", watch: "turn" };
  state.sessions.push({ id: "s-item", cwd: REPO, running: true });
  await store.reconcile();
  store.post(workItem("lim1"));
  store.kick();
  await settle();
  assert.equal(store.get("lim1").state, "running");
  // The session exits at the limit, and nothing has reopened yet.
  state.sessions = state.sessions.filter((x) => x.id !== "s-item");
  store.onSessionExit("s-item");
  await settle();
  let row = store.get("lim1");
  assert.equal(row.state, "running", "held running — a queued row would open a SECOND session");
  assert.match(row.blockDetail, /usage limit — following it to the reopened one/);
  // …and now it is back, under a new id.
  revived = "s-revived";
  state.sessions.push({ id: "s-revived", cwd: REPO, running: true });
  store.kick();
  await settle();
  row = store.get("lim1");
  assert.equal(row.state, "running");
  assert.deepEqual(row.target, { kind: "session", sessionId: "s-revived" });
  assert.equal(row.sessionId, "s-revived");
  assert.equal(state.ran.length, 1, "the words were delivered exactly once, all told");
  // It completes on the revived session's turn, once.
  store.onTurnEnded("s-revived", 1);
  await settle();
  assert.equal(store.get("lim1").state, "done");
  store.stop();
  rmSync(root, { recursive: true, force: true });
});

test("a v1 store is converted, its repo rows open their own sessions, and the old file is kept", async () => {
  const root = mkdtempSync(join(tmpdir(), "waterplane-sched-v1-"));
  mkdirSync(join(root, ".waterplane"), { recursive: true });
  // Schema 1: a bare ARRAY, and a work item aimed at the repo's ONE shared
  // backlog session (no `fresh`). Both readings are retired.
  writeFileSync(join(root, ".waterplane", "intents.json"), JSON.stringify([
    { id: "v1a", cwd: REPO, payload: { kind: "prompt", steps: ["old work"] },
      target: { kind: "repo" }, trigger: { kind: "idle" }, auto: true, state: "queued", createdAt: Date.now() - HOUR },
  ]));
  const { store } = makeStore({ root });
  assert.deepEqual(store.get("v1a").target, { kind: "repo", fresh: true },
    "a non-fresh repo target is retired — it means a session of its own now");
  // `>= 2` rather than `=== 2`: the number is a LADDER of conversions that have
  // run (2 = a session per work item, 3 = the legacy timed parents set aside),
  // and pinning today's value here would make the next one look like a break.
  // What this test is about is that the file says a reading was recorded at all.
  assert.ok(storeFile(root).schema >= 2, "and the file says which reading it was written under");
  assert.deepEqual(
    JSON.parse(readFileSync(join(root, ".waterplane", "intents.json.bak"), "utf8"))[0].target,
    { kind: "repo" },
    "the pre-conversion file is kept beside it — a conversion nobody can check is one nobody can trust");
  store.stop();
  rmSync(root, { recursive: true, force: true });
});

// ── 2c. a ONE-SHOT window rule (`oneShot: true`) behaves like a `once`, not
//        like the recurring window rule it used to be the only kind of ───────

/** A window-anchored rule that fires once and stops, rather than every reset. */
const windowOnce = (id, rule = {}, extra = {}) => ({
  id, cwd: REPO,
  payload: { kind: "prompt", steps: ["burn what's left"] },
  target: { kind: "repo", fresh: true },
  trigger: {
    kind: "at",
    rule: { kind: "window", window: "session", edge: "after", offsetMin: 0, oneShot: true, ...rule },
    graceMin: 120,
  },
  title: "burn the session window once",
  ...extra,
});

test("a one-shot window rule fires once and settles terminal, nextAt cleared", async () => {
  const usageWindows = () => ({ sessionResetAt: Date.now() + HOUR, sessionPct: 10 });
  const { store, state, root } = makeStore({ usageWindows });
  await store.reconcile();
  store.post(windowOnce("wo1"));
  // `post()` already ran one pass synchronously (armed it against the reset
  // above, found it not due, and blocked it) before this line runs at all —
  // let it fully settle before poking `nextAt`, or the explicit `kick()` below
  // is silently dropped by the still-in-flight first pass's `ticking` guard.
  await settle();
  const armed = store.get("wo1");
  assert.equal(typeof armed.nextAt, "number", "armed against the future reset it was given");
  armed.nextAt = Date.now() - 1000;
  store.kick();
  await settle();
  assert.deepEqual(state.ran.map((r) => r.name), ["freshSession"], "it really ran, exactly once");
  const row = store.get("wo1");
  assert.equal(row.state, "done");
  assert.equal(row.nextAt, null, "a spent one-shot must not claim a next reset");
  assert.equal(typeof row.lastOccurrence, "number");
  // A second tick must not fire it again — there is no next occurrence to find.
  state.ran.length = 0;
  store.kick();
  await settle();
  assert.equal(state.ran.length, 0);
  store.stop();
  rmSync(root, { recursive: true, force: true });
});

test("a one-shot window rule whose condition fails is KEPT for the next reset, and runs once when one meets it", async () => {
  // 1% left, needs 90% — the condition fails. A skip is not the rule's one
  // shot (nothing ran), so the row stays queued for the following reset: "once,
  // when 90% is left" is a standing offer to spend what would expire, not a
  // coin toss on the next reset.
  let usage = { sessionResetAt: Date.now() + HOUR, sessionPct: 99 };
  const { store, state, root } = makeStore({ usageWindows: () => usage });
  await store.reconcile();
  store.post(windowOnce("wo2", { edge: "before", offsetMin: -30, minPctLeft: 90 }));
  await settle();
  store.get("wo2").nextAt = Date.now() - 1000;
  store.kick();
  await settle();
  assert.equal(state.ran.length, 0, "the condition failed — nothing ran");
  let row = store.get("wo2");
  assert.equal(row.state, "queued", "kept, not failed");
  assert.equal(row.settledAt, undefined);
  assert.notEqual(row.nextAt, null, "never the explicit null that means retired");
  assert.match(row.result.detail, /conditions not met.*kept for the next reset/);

  // The next reset, with room to spare: it runs, exactly once, and is spent.
  usage = { sessionResetAt: Date.now() + 6 * HOUR, sessionPct: 5 };
  store.get("wo2").nextAt = Date.now() - 1000;
  store.kick();
  await settle();
  assert.deepEqual(state.ran.map((r) => r.name), ["freshSession"]);
  row = store.get("wo2");
  assert.equal(row.state, "done");
  assert.equal(row.nextAt, null, "a one-shot that has RUN is spent");
  store.stop();
  rmSync(root, { recursive: true, force: true });
});

test("a kept one-shot whose next reset is not read yet WAITS — it is never gravestoned as spent", async () => {
  const { intentVerdict } = await import("@waterplane/shared");
  const { isSpentOnce } = await import("@waterplane/shared");
  const rule = { kind: "window", window: "session", edge: "before", offsetMin: -30, minPctLeft: 90, oneShot: true };
  const now = Date.now();
  const row = {
    id: "k1", cwd: "/r", createdAt: now - HOUR, state: "queued", payload: { kind: "prompt", steps: ["x"] },
    target: { kind: "repo", fresh: true }, trigger: { kind: "at", rule, graceMin: 120 }, lastOccurrence: now - 60_000,
  };
  const v = intentVerdict(row, now, {});
  assert.notEqual(v.kind, "fail", `undefined nextAt is "not computed", got ${JSON.stringify(v)}`);
  assert.equal(isSpentOnce({ rule, nextAt: undefined, lastOccurrence: row.lastOccurrence }, now), false);
  assert.equal(isSpentOnce({ rule, nextAt: null, lastOccurrence: row.lastOccurrence }, now), true, "the explicit null is still spent");
  assert.equal(isSpentOnce({ rule, nextAt: null, lastOccurrence: row.lastOccurrence, enabled: true }, now), false, "a ScheduleEntry the host still holds armed");
});

test("skip next is refused for a one-shot window rule, exactly as for a `once`", async () => {
  const usageWindows = () => ({ sessionResetAt: Date.now() + HOUR, sessionPct: 10 });
  const { store, root } = makeStore({ usageWindows });
  await store.reconcile();
  store.post(windowOnce("wo3"));
  const r = store.skipNext("wo3");
  assert.equal(r.ok, false);
  assert.match(r.reason, /one-off/);
  store.stop();
  rmSync(root, { recursive: true, force: true });
});

test("run now revives a spent one-shot window rule instead of refusing it", async () => {
  const usageWindows = () => ({ sessionResetAt: Date.now() + HOUR, sessionPct: 10 });
  const { store, state, root } = makeStore({ usageWindows });
  await store.reconcile();
  store.post(windowOnce("wo4"));
  await settle();
  const armed = store.get("wo4");
  armed.nextAt = Date.now() - 1000;
  store.kick();
  await settle();
  assert.equal(store.get("wo4").state, "done");
  state.ran.length = 0;
  const r = await store.runNow("wo4");
  assert.equal(r.ok, true, "the words are still there — a person may still mean them");
  await settle();
  assert.deepEqual(state.ran.map((x) => x.name), ["freshSession"]);
  store.stop();
  rmSync(root, { recursive: true, force: true });
});

test("several repos due in ONE pass open min(due, free) sessions, not one each", async () => {
  // The `hostBusy`/`busyCwds` trick, applied to the cap. A fresh repo target
  // passes rung 5 unconditionally — nothing exists yet for the tick to see busy
  // — so without the per-fire decrement five rows due in five repos would each
  // read the cap as untouched and each spawn.
  const { store, state, root } = makeStore();
  // Posted with the cap already full, so all three are waiting on the same fact
  // and one pass then has to decide between them — `post()` kicks, and three
  // posts that each fired on their own tick would not be the case under test.
  state.slots = 0;
  await store.reconcile();
  store.post(workItem("m1", { cwd: "/tmp/waterplane-sched-a" }));
  store.post(workItem("m2", { cwd: "/tmp/waterplane-sched-b" }));
  store.post(workItem("m3", { cwd: "/tmp/waterplane-sched-c" }));
  await settle();
  state.slots = 2;
  store.kick();
  await settle();
  assert.equal(state.ran.length, 2, `two slots, two fires (ran ${state.ran.length})`);
  const held = ["m1", "m2", "m3"].map((id) => store.get(id)).filter((r) => r.state === "blocked");
  assert.equal(held.length, 1);
  assert.equal(held[0].blockReason, "noSlot");
  store.stop();
  rmSync(root, { recursive: true, force: true });
});

// ── 5. chains: the three facts an `after` row is told ────────────────────────
//
// The verdict itself is pinned in `shared/test/intent.test.mjs`; what is pinned
// here is the HOST half, which is the half that can be silently wrong. All
// four facts are optional on `IntentFacts` and an absent one means "nobody
// said" ⇒ wait, so a manager that supplied three of them would produce a store
// where every chain looks patient and none of them is.

/** A row that waits for another one to finish. `title` is the snapshot — the
 *  predecessor may be compacted out of the file by the time anyone reads this. */
const afterRow = (id, waitsOn, trig = {}, extra = {}) => ({
  id, cwd: REPO,
  payload: { kind: "prompt", steps: ["review what just landed"] },
  target: { kind: "repo", fresh: true },
  trigger: { kind: "after", id: waitsOn, title: "the migration", ...trig },
  auto: true,
  ...extra,
});

test("a chain waits for a live predecessor, naming it, and goes once it settles", async () => {
  const { store, state, root } = makeStore();
  await store.reconcile();
  // A one-off two hours out: live, queued, and nothing in this test fires it.
  store.post(onceAt("mig", Date.now() + 2 * HOUR));
  store.post(afterRow("chain1", "mig"));
  // `post()` kicks a pass of its own and the second one lands while the first
  // is still in flight, so let that settle before asking for a pass that
  // actually sees both rows — the `ticking` guard drops the rest.
  await settle();
  store.kick();
  await settle();
  assert.equal(state.ran.length, 0, "nothing ran — the predecessor has not finished");
  const waiting = store.get("chain1");
  assert.equal(waiting.blockReason, "notYet");
  assert.match(waiting.blockDetail, /waits for “the migration” to finish/,
    "the SNAPSHOT is what the row says, not a lookup that may find nothing");
  // It finishes, by hand. The next pass is the one that sees it — `settled` is
  // built once at the top of a pass, so a row that settles mid-pass releases
  // its chain on the following tick rather than inside the same one.
  store.markDone("mig");
  store.kick();
  await settle();
  assert.deepEqual(state.ran.map((r) => r.name), ["freshSession"]);
  assert.equal(store.get("chain1").state, "done");
  store.stop();
  rmSync(root, { recursive: true, force: true });
});

test("a chain whose predecessor has been COMPACTED away still releases", async () => {
  // The whole reason `settled` is built from the archive as well as the live
  // rows. A predecessor that finished, was dismissed and left the file is still
  // a predecessor that finished, and a chain that read its absence as "not yet"
  // would strand itself the first time the store was tidied.
  const { store, state, root } = makeStore();
  await store.reconcile();
  store.post(onceAt("mig2", Date.now() + 2 * HOUR));
  store.post(afterRow("chain2", "mig2"));
  await settle();
  store.markDone("mig2");
  // `remove()` archives before it deletes — this is the row leaving the live
  // file exactly as compaction would have taken it.
  assert.equal(store.remove("mig2"), true);
  assert.equal(store.get("mig2"), undefined, "gone from the live rows");
  store.kick();
  await settle();
  assert.deepEqual(state.ran.map((r) => r.name), ["freshSession"], "the archive answered for it");
  store.stop();
  rmSync(root, { recursive: true, force: true });
});

test("a chain behind a RECURRING rule fails — the manager says which rows never end", async () => {
  // The host half of `IntentFacts.neverSettles`. `settled` is terminal-only and
  // a standing rule never goes terminal, so without this fact the row below
  // would sit at `notYet` for as long as the desktop ran, under the one
  // sentence in the vocabulary that sounds like everything is fine.
  const { store, state, root } = makeStore();
  await store.reconcile();
  store.post(weekly("standing"));
  store.post(afterRow("chainRec", "standing", { title: "a standing rule" }));
  await settle();
  store.kick();
  await settle();
  assert.equal(state.ran.length, 0);
  const row = store.get("chainRec");
  assert.equal(row.state, "failed", "a wait that can never end is not a wait this store may hold");
  assert.match(row.result.detail, /repeating rule, so it never finishes/);
  store.stop();
  rmSync(root, { recursive: true, force: true });
});

test("a chain behind a ONE-OFF is untouched by that — it is a row that ends", async () => {
  // The fact bounds itself on recurrence, never on "it is a schedule": a
  // one-off runs once and settles, which is exactly what a chain waits for.
  const { store, state, root } = makeStore();
  await store.reconcile();
  store.post(onceAt("oneoff", Date.now() + 2 * HOUR));
  store.post(afterRow("chainOne", "oneoff"));
  await settle();
  store.kick();
  await settle();
  assert.equal(store.get("chainOne").blockReason, "notYet", "waiting, which is the honest answer here");
  assert.equal(store.get("chainOne").state, "blocked");
  store.stop();
  rmSync(root, { recursive: true, force: true });
});

test("a predecessor that is GONE fails the chain with a sentence, never strands it", async () => {
  const { store, state, root } = makeStore();
  await store.reconcile();
  store.post(afterRow("chain3", "never-existed"));
  store.kick();
  await settle();
  assert.equal(state.ran.length, 0);
  const row = store.get("chain3");
  assert.equal(row.state, "failed", "waiting for ever is not on the list of things a row may do");
  assert.match(row.result.detail, /gone/);
  assert.match(row.result.detail, /nothing is going to release it/);
  store.stop();
  rmSync(root, { recursive: true, force: true });
});

test("a row removed while still QUEUED counts as gone, not as known", async () => {
  // It is in the archive (every delete is), but it never finished and never
  // will. Counting it as known would put the chain behind it back into the
  // patient-for-ever state the fact exists to end.
  const { store, root } = makeStore();
  await store.reconcile();
  store.post(onceAt("mig3", Date.now() + 2 * HOUR));
  store.post(afterRow("chain4", "mig3"));
  await settle();
  store.remove("mig3");
  store.kick();
  await settle();
  const row = store.get("chain4");
  assert.equal(row.state, "failed");
  assert.match(row.result.detail, /gone/);
  store.stop();
  rmSync(root, { recursive: true, force: true });
});

test("two rows waiting on each other fail instead of spinning", async () => {
  // `chainWaits` is the only fact that makes a cycle visible from inside one
  // row: each of these reads the other as "not finished yet", for ever, and on
  // screen that is indistinguishable from work that is simply next.
  //
  // Loaded from the FILE rather than posted, because a cycle cannot be built a
  // row at a time — the first one posted names something that does not exist
  // yet and is quite correctly failed as gone. A cycle is a thing you find in
  // the store (an edit, a retarget, a restored file), which is exactly this.
  const root = mkdtempSync(join(tmpdir(), "waterplane-sched-loop-"));
  mkdirSync(join(root, ".waterplane"), { recursive: true });
  writeFileSync(join(root, ".waterplane", "intents.json"), JSON.stringify({
    schema: 2,
    intents: [
      { ...afterRow("loopA", "loopB"), state: "queued", createdAt: Date.now() - HOUR },
      { ...afterRow("loopB", "loopA"), state: "queued", createdAt: Date.now() - HOUR },
    ],
  }));
  const { store, state } = makeStore({ root });
  await store.reconcile();
  store.kick();
  await settle();
  assert.equal(state.ran.length, 0);
  for (const id of ["loopA", "loopB"]) {
    const row = store.get(id);
    assert.equal(row.state, "failed", `${id} fails rather than waiting`);
    assert.match(row.result.detail, /waiting on each other in a circle/);
  }
  store.stop();
  rmSync(root, { recursive: true, force: true });
});

test("the archive is read as a TAIL: the recent end releases, past the bound is gone", async () => {
  // The bound is bytes (`ARCHIVE_TAIL_BYTES`, 256 KB) and what it costs is
  // stated where it is set: a predecessor older than the tail reads as GONE and
  // FAILS the row. That is the intended trade — the alternative is an
  // ever-growing file read on the loop that also pumps every PTY, and a row
  // that waits for ever instead of saying so.
  const root = mkdtempSync(join(tmpdir(), "waterplane-sched-tail-"));
  mkdirSync(join(root, ".waterplane"), { recursive: true });
  const done = (id) => JSON.stringify({
    id, cwd: REPO, payload: { kind: "prompt", steps: ["x".repeat(600)] },
    target: { kind: "repo", fresh: true }, trigger: { kind: "idle" },
    state: "done", createdAt: Date.now() - HOUR, settledAt: Date.now() - HOUR,
    result: { at: Date.now() - HOUR, ok: true, detail: "ran" },
  });
  const lines = [done("too-old")];
  // Well past the bound, in rows of ~700 bytes each.
  for (let k = 0; k < 600; k++) lines.push(done(`filler-${k}`));
  lines.push(done("recent"));
  writeFileSync(join(root, ".waterplane", "intents-archive.jsonl"), lines.join("\n") + "\n");
  const { store, state } = makeStore({ root });
  await store.reconcile();
  store.post(afterRow("tail-ok", "recent"));
  store.post(afterRow("tail-old", "too-old"));
  await settle();
  store.kick();
  await settle();
  assert.deepEqual(state.ran.map((r) => r.id), ["tail-ok"], "the recent end of the archive still releases a chain");
  const old = store.get("tail-old");
  assert.equal(old.state, "failed", "past the bound it reads as gone — and says so, which is the trade");
  assert.match(old.result.detail, /gone/);
  store.stop();
  rmSync(root, { recursive: true, force: true });
});

// ── 6. quiet hours: the grace is counted from the window OPENING ─────────────

/** Minute of day, HOST-local — `cleanRule` keeps no zone on a `once` rule, so
 *  `inHours` reads it host-local and the test must ask the same clock. */
const nowMin = () => { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); };
const mod1440 = (m) => ((m % 1440) + 1440) % 1440;

test("an occurrence anchored inside quiet hours still runs when the window opens", async () => {
  // The case the floor exists for. Anchored three hours ago, behind a window
  // that opened five minutes ago, with two hours of grace. Counted from the
  // anchor it is an hour past its grace and was never once allowed to try;
  // counted from the opening it is five minutes late, which is what it is.
  const { store, state, root } = makeStore();
  await store.reconcile();
  const hours = { from: mod1440(nowMin() - 5), to: mod1440(nowMin() + 600) };
  store.post(onceAt("q1", Date.now() - 3 * HOUR, {
    trigger: { kind: "at", rule: { kind: "once", at: Date.now() - 3 * HOUR, offsetMin: 0, hours }, graceMin: 120 },
  }));
  store.kick();
  await settle();
  assert.deepEqual(state.ran.map((r) => r.name), ["freshSession"], "it ran — the grace had not been spent asleep");
  const row = store.get("q1");
  assert.equal(row.state, "done");
  assert.equal(row.result.late, true, "…and says it ran late, because it did");
  store.stop();
  rmSync(root, { recursive: true, force: true });
});

test("the SAME occurrence with no run window is past its grace and fails", async () => {
  // The control. Without `hours` the floor is `now − grace` and an anchor three
  // hours back is behind it, so the occurrence is never even offered — which is
  // the old behaviour and the right one when there is no window to wait for.
  const { store, state, root } = makeStore();
  await store.reconcile();
  store.post(onceAt("q2", Date.now() - 3 * HOUR));
  store.kick();
  await settle();
  assert.equal(state.ran.length, 0);
  assert.equal(store.get("q2").state, "failed");
  store.stop();
  rmSync(root, { recursive: true, force: true });
});

test("a due occurrence outside its hours WAITS, and says which door is shut", async () => {
  const { store, state, root } = makeStore();
  await store.reconcile();
  // A window that opens in an hour and shuts four hours later — shut right now.
  const hours = { from: mod1440(nowMin() + 60), to: mod1440(nowMin() + 300) };
  store.post(onceAt("q3", Date.now() - 60_000, {
    trigger: { kind: "at", rule: { kind: "once", at: Date.now() - 60_000, offsetMin: 0, hours }, graceMin: 120 },
  }));
  store.kick();
  await settle();
  assert.equal(state.ran.length, 0, "due is not the same as allowed");
  const row = store.get("q3");
  assert.equal(row.blockReason, "notYet");
  assert.match(row.blockDetail, /outside its hours .* runs when they open/);
  store.stop();
  rmSync(root, { recursive: true, force: true });
});

// ── 7. what a schedule may carry through the store and back ─────────────────
//
// A schedule is edited as a `ScheduleEntry`, stored as an `Intent` and read
// back as a `ScheduleEntry`. Every clause the user set has to survive both
// crossings: a round trip that drops one turns "not before 07:00" into "any
// time at all" the first time somebody renames the schedule, and nothing on
// screen says it happened.

const entry = (over = {}) => ({
  id: "sch-rt", name: "the nightly sweep", enabled: true, graceMin: 120,
  createdAt: Date.now() - HOUR,
  rule: { kind: "weekly", days: [], hour: 3, minute: 0, tz: "UTC", offsetMin: 0 },
  action: { kind: "backlog", repoDir: REPO, text: "groom the notes", autoFire: true },
  ...over,
});

/** The store's own normalisation, applied the way `post()` applies it — the
 *  round trip must survive `cleanIntentRow`, not just the two adapters. */
const through = (e) => {
  const { store, root } = makeStore();
  store.post(scheduleToIntent(e, Date.now()));
  const back = intentToSchedule(store.get(e.id));
  store.stop();
  rmSync(root, { recursive: true, force: true });
  return back;
};

test("quiet hours survive a round trip through the store", () => {
  const back = through(entry({
    rule: { kind: "weekly", days: [], hour: 3, minute: 0, tz: "UTC", offsetMin: 0, hours: { from: 7 * 60, to: 22 * 60 } },
  }));
  assert.deepEqual(back.rule.hours, { from: 420, to: 1320 },
    "the rule is carried WHOLE both ways — there is no field list here to forget it from");
});

test("the headroom guard on the OTHER window survives a round trip", () => {
  const back = through(entry({
    rule: { kind: "window", window: "session", edge: "after", offsetMin: 0, minPctLeft: 30, guardWindow: "weekly" },
  }));
  assert.equal(back.rule.guardWindow, "weekly");
  assert.equal(back.rule.minPctLeft, 30,
    "…and the condition it guards comes with it: an `after` edge keeps its percentage only behind a guard");
});

test("a rule with neither clause comes back with neither key", () => {
  // Absent = old behaviour is the whole rule for these fields, and a round trip
  // that invented `hours: undefined`-shaped keys would be a different row on
  // disk for every schedule written before they existed.
  const back = through(entry());
  assert.equal(back.rule.hours, undefined);
  assert.equal(back.rule.guardWindow, undefined);
});

// ── 7b. which LIST the round trip lands the row in ─────────────────────────
//
// Recurrence, not trigger kind, decides that (`isTimedWorkRow`), and the
// crossing is where it becomes visible: the SAME `schedule.save` message goes
// in — the wire is untouched, and an APK pinned to an old bundle still sends it
// — and what comes back is either a schedule card or a backlog row with a clock
// on it. Nothing is stored to say which; both sides derive it from the rule.

/** The crossing, keeping the ROW and BOTH views of it. `through` cannot say
 *  what happened to a timed work row, because the answer is that it has no
 *  `ScheduleEntry` at all. */
const bothWays = (e) => {
  const { store, root } = makeStore();
  store.post(scheduleToIntent(e, Date.now()));
  const row = store.get(e.id);
  const out = { row, card: intentToSchedule(row), item: intentToBacklogItem(row) };
  store.stop();
  rmSync(root, { recursive: true, force: true });
  return out;
};

test("`wait until it's free` survives the crossing in BOTH directions", () => {
  // F6. Both halves of one tick: `serial` (one at a time in this repo) and
  // `holdForHost` (nothing else on the desktop starting or running). The
  // previous audit read the flag off `trigger.rule`, where it has never lived,
  // and reported a loss that was not there — so the gap was not a bug but a
  // missing PIN, and this is it. The phone's `seedFromIntent` reads the box
  // back with this same expression, which is why one direction is not enough.
  const ticked = bothWays(entry({ waitUntilFree: true }));
  assert.equal(ticked.row.serial, true);
  assert.equal(ticked.row.holdForHost, true, "set together on the way in, never one without the other");
  assert.equal(ticked.card.waitUntilFree, true, "…and read back as the one tick it was");

  // Absent stays ABSENT, never `false`. A rule written before the field existed
  // must be byte-identical on disk after a rename, or the first edit of a name
  // rewrites every schedule in the store.
  const plain = through(entry());
  assert.equal(plain.waitUntilFree, undefined);
  assert.equal(Object.hasOwn(JSON.parse(JSON.stringify(plain)), "waitUntilFree"), false,
    "absent on the wire, not `false` — one is a box nobody ticked, the other a box somebody un-ticked");

  // Half a tick is not a tick: reading one flag back would silently report the
  // box as on the moment the other half lagged.
  const half = intentToSchedule({ ...ticked.row, holdForHost: undefined });
  assert.equal(half.waitUntilFree, undefined);
});

test("a ONE-OFF backlog entry comes back as a backlog row with a clock, and as NO schedule card", () => {
  const at = Date.now() + 2 * HOUR;
  const { row, card, item } = bothWays(entry({
    id: "sch-once-rt", rule: { kind: "once", at }, waitUntilFree: true,
  }));
  assert.equal(card, null,
    "the schedules sheet has no verb a spent one-off can use — `after`'s precedent, one trigger over");
  assert.equal(item.repoDir, REPO);
  assert.equal(item.at.rule.kind, "once");
  assert.equal(item.at.rule.at, at);
  assert.equal(item.at.graceMin, 120, "the grace travels with the rule — the row says how late is too late");
  assert.equal(item.at.nextAt, row.nextAt, "the ROW's armed instant, never a second reading of the rule");
  assert.equal(item.holdForHost, true, "the host-wide half of the tick, on the row that does the work");
  assert.equal(item.steps, undefined, "…and everything else about the item is what it always was");
});

test("a RECURRING backlog rule and a one-off SWEEP both stay schedule cards", () => {
  const rule = bothWays(entry({ id: "sch-weekly-rt" }));
  assert.equal(rule.card.action.kind, "backlog");
  assert.equal(rule.card.rule.kind, "weekly", "a standing rule is a standing rule wherever it is aimed");
  assert.equal(rule.item.at, undefined, "and it is no repo's waiting work — it is the thing that MAKES some");

  const sweep = bothWays(entry({
    id: "sch-sweep-rt",
    rule: { kind: "once", at: Date.now() + 2 * HOUR },
    action: { kind: "fanout", dirs: [REPO], text: "audit every repo" },
  }));
  assert.equal(sweep.card.action.kind, "fanout",
    "a one-off sweep has no single backlog to live in, so it stays a card until it is spent");
  assert.equal(sweep.card.rule.kind, "once");
});

test("an edit from `once` to `every week` moves the row between the lists, with nothing migrated", () => {
  // The whole reason the classification is DERIVED. A stored "which list am I
  // in" would be a second fact beside the trigger, free to disagree with it —
  // and the edit that flips the rule is the ordinary `schedule.save` upsert,
  // which has no idea either list exists.
  const { store, root } = makeStore();
  const once = entry({ id: "sch-flip", rule: { kind: "once", at: Date.now() + 2 * HOUR } });
  store.post(scheduleToIntent(once, Date.now()));
  assert.equal(intentToSchedule(store.get("sch-flip")), null, "a one-off: a backlog row");
  assert.equal(intentToBacklogItem(store.get("sch-flip")).at.rule.kind, "once");

  store.upsert(scheduleToIntent({ ...once, rule: { kind: "weekly", days: [], hour: 3, minute: 0, tz: "UTC", offsetMin: 0 } }, Date.now()));
  assert.equal(intentToSchedule(store.get("sch-flip")).rule.kind, "weekly", "…and now a schedule card");
  assert.equal(intentToBacklogItem(store.get("sch-flip")).at, undefined, "with no clock chip left behind on a row that is not there");

  store.stop();
  rmSync(root, { recursive: true, force: true });
});

test("re-saving a timed row's clock keeps the title somebody typed into it", () => {
  // SEVERE, and it is `revivedShape`'s rule one path over. A one-off with a
  // clock is a BACKLOG row (`isTimedWorkRow`), so a person titles it in the
  // backlog's own editor — stamped `hand`, the one author no machine may write
  // over — and later changes its time in the send sheet. That is
  // `schedule.save` → `scheduleToIntent` → `upsert()`, and `ScheduleEntry` has
  // no vocabulary for a title, a position or "I set this aside": every one of
  // them is the HOST's. So the row came back out untitled, un-placed and
  // un-archived, and the next naming pass then wrote machine words into the
  // field a person had typed in — the single failure the whole `NameAuthor`
  // apparatus exists to make impossible.
  const { store, root } = makeStore();
  const once = entry({ id: "sch-name", rule: { kind: "once", at: Date.now() + 2 * HOUR } });
  store.post(scheduleToIntent(once, Date.now()));
  store.edit("sch-name", { headline: "groom every note in docs", category: "chore" });
  store.edit("sch-name", { order: 7, handOrdered: true, archived: true });

  // The send sheet moving the clock, through the wire shape it actually sends.
  store.upsert(scheduleToIntent({ ...once, rule: { kind: "once", at: Date.now() + 5 * HOUR } }, Date.now()));

  const row = store.get("sch-name");
  assert.equal(row.headline, "groom every note in docs");
  assert.equal(row.headlineBy, "hand", "…with the stamp that is the whole of 'a machine may not write here'");
  assert.equal(row.category, "chore");
  assert.equal(row.categoryBy, "hand");
  assert.equal(row.order, 7, "where a person put it is not something a re-timing decides");
  assert.equal(row.handOrdered, true);
  assert.equal(row.archived, true, "…nor is having set it aside");

  // A draft that DOES name one means it — the carry is for a draft that is
  // silent, exactly like every other "nobody said" field on this path.
  store.upsert({ ...scheduleToIntent(once, Date.now()), headline: "a machine's reading", headlineBy: "assess" });
  assert.equal(store.get("sch-name").headline, "a machine's reading");
  assert.equal(store.get("sch-name").headlineBy, "assess");

  store.stop();
  rmSync(root, { recursive: true, force: true });
});

// ── 8. F14: the child of a `wait until it's free` schedule ──────────────────

test("a waitUntilFree schedule hands BOTH gates to the item it creates", () => {
  // The bug: the tick gated the making of the row, which is instantaneous and
  // never busy, while the item it made fired into whatever else was running.
  const parent = scheduleToIntent(entry({ waitUntilFree: true }), Date.now());
  assert.equal(parent.serial, true);
  assert.equal(parent.holdForHost, true, "the schedule itself carries both halves of the tick");
  const inherits = workItemInherits(parent);
  assert.equal(inherits.holdForHost, true, "…and hands the one that has nothing else carrying it to the child");
  const child = backlogDraft({ id: "kid", cwd: REPO, text: "x", order: 0, ...inherits });
  assert.equal(child.holdForHost, true, "the CHILD is where the work happens, so the gate has to be on it");
  assert.equal(child.serial, true, "`serial` is on every repo-target item by construction — satisfied before it is asked for");
});

test("a schedule with no tick makes a child with no host-wide hold", () => {
  const parent = scheduleToIntent(entry(), Date.now());
  const child = backlogDraft({ id: "kid2", cwd: REPO, text: "x", order: 0, ...workItemInherits(parent) });
  assert.equal(child.holdForHost, undefined, "absent = old behaviour, per field");
  assert.equal(child.serial, true, "one at a time in this repo is not the tick — it is the default");
});

test("a scheduled CHAIN reaches its child whole, instead of losing steps 2..n", () => {
  // S4/F13 on the host side. The steps were on the parent row, in the store,
  // where nobody could watch them go missing: the child was made from
  // `steps[0]` and the rest were simply not passed on.
  const parent = {
    ...scheduleToIntent(entry(), Date.now()),
    payload: { kind: "prompt", steps: ["read the diff", "write the note", "push it"] },
  };
  const inherits = workItemInherits(parent);
  assert.deepEqual(inherits.steps, ["read the diff", "write the note", "push it"]);
  const child = backlogDraft({ id: "kid3", cwd: REPO, text: inherits.steps[0], order: 0, ...inherits });
  assert.deepEqual(child.payload.steps, ["read the diff", "write the note", "push it"],
    "ONE item carrying three turns — `deliverChain` puts them on separate turns, in order");
});

test("the chain arrives from the ACTION and leaves again, so renaming a rule cannot shorten it", () => {
  // The last link. `payload.steps` was always the store's shape, but the only
  // way in for a scheduled send was `ScheduleAction.backlog.text` — one slot —
  // so the sheet posted turn 1 and told the user it had dropped the rest.
  const steps = ["read the diff", "write the note", "push it"];
  const draft = scheduleToIntent(entry({ action: { kind: "backlog", repoDir: REPO, text: steps[0], autoFire: true, steps } }), Date.now());
  assert.deepEqual(draft.payload.steps, steps, "the whole chain, straight onto the row");

  // Out again. An edit of the NAME re-posts what this function answers, so a
  // chain read back as its own head would vanish on the first rename — the
  // failure the whole-rule round trip above exists to avoid, one field over.
  const back = through(entry({ action: { kind: "backlog", repoDir: REPO, text: steps[0], autoFire: true, steps } }));
  assert.deepEqual(back.action.steps, steps);
  assert.equal(back.action.text, steps[0], "`text` stays `steps[0]` — one contract, shared with `backlog.add`");

  // And a one-turn rule is byte-identical to every one written before the field.
  assert.equal(through(entry()).action.steps, undefined);
  assert.deepEqual(scheduleToIntent(entry(), Date.now()).payload.steps, ["groom the notes"]);
});

// ── 5. a row held below rung 3 keeps its deadline ───────────────────────────
//
// The real case, audited out of a live `/Users/me/dev/.waterplane/intents.json`:
//
//   myapp · "We have setup local ai coding with ollama recently…"
//     rule: once · right after the weekly window resets · waits until free
//     · grace 120 min  →  state: failed
//     "missed — the desktop was not running when it was due (more than 120 min late)"
//
// The desktop had been running the entire time. Rung 3 cleared the row; rung 4.5
// (`holdForHost` — the user's own "wait until it's free" tick) held it; the clock
// kept advancing while it was held; and the next tick's rung 3, which re-runs
// from scratch and remembers nothing, judged the SAME occurrence missed and
// binned the work. It was killed for doing exactly what it was told to do, and
// then the sentence blamed the machine.
//
// This is that sequence against the real manager, with `Date.now` under the
// test's control so three hours can pass between two ticks. `setTimeout` is NOT
// mocked — the store's own tick timer and `settle()` stay real.

test("a weekly wait-until-free rule survives a desktop busier than its grace", async () => {
  const realNow = Date.now;
  let clock = realNow();
  Date.now = () => clock;
  let releaseHog = () => {};
  const { store, state, root } = makeStore({
    executors: {
      // One repo's work does not finish until the test lets it: that is what
      // "the desktop is busy" is made of (`hostBusy` = any row
      // `starting`/`running`).
      freshSession: async (i) => {
        state.ran.push({ name: "freshSession", id: i.id });
        if (i.id === "hog") return new Promise((r) => { releaseHog = () => r(state.result); });
        return state.result;
      },
      sweep: async () => state.result,
      deliver: async () => state.result,
      workItem: async () => state.result,
      build: async () => state.result,
      assess: async () => state.result,
    },
  });
  try {
    await store.reconcile();
    // Something else on the desktop, in another repo, that keeps running.
    store.post({
      id: "hog", cwd: "/tmp/waterplane-sched-other",
      payload: { kind: "prompt", steps: ["long job"] },
      target: { kind: "repo", fresh: true },
      trigger: { kind: "now" },
      auto: true, title: "the busy one",
    });
    store.kick();
    await settle();
    assert.equal(store.get("hog").state, "starting", "the desktop is busy");

    // The user's rule: weekly, waits until free, grace 120 min. Anchored a few
    // minutes AHEAD and then walked into its own occurrence, because that is the
    // real sequence — a standing rule that has been sitting there arms to its
    // next occurrence and the clock comes round to it. (`armNew` deliberately
    // refuses to arm a recurring rule at an instant already past: "every
    // Thursday 18:00" saved at 19:00 on Thursday means NEXT Thursday.)
    const anchor = new Date(clock + 3 * 60_000);
    store.post({
      id: "wk", cwd: REPO,
      payload: { kind: "prompt", steps: ["the words the user typed"] },
      target: { kind: "repo", fresh: true },
      trigger: {
        kind: "at",
        rule: { kind: "weekly", days: [anchor.getDay()], hour: anchor.getHours(), minute: anchor.getMinutes() },
        graceMin: 120,
      },
      auto: true, holdForHost: true, title: "the weekly one",
    });
    store.kick();
    await settle();
    assert.equal(store.get("wk").blockReason, "notYet", "armed, and not due yet");

    // …and the clock comes round to it.
    clock += 5 * 60_000;
    store.kick();
    await settle();

    // Tick 1: due, inside the grace, held by the rung the user opted into. The
    // sentence says HELD, not late, and says nothing about the desktop being off.
    const first = store.get("wk");
    assert.equal(first.state, "blocked");
    assert.equal(first.blockReason, "hostBusy");
    assert.match(first.blockDetail, /waiting for the desktop to be free/);
    assert.doesNotMatch(first.blockDetail, /missed|late|not running/);
    // …and the release is remembered, on disk, so a restart mid-hold cannot
    // forget it and re-arm the bug on the next tick.
    const onDisk = rowsOnDisk(root).find((r) => r.id === "wk");
    assert.equal(onDisk.clearedOccurrence, first.nextAt);

    // Three hours pass with the desktop still busy — an hour past the grace.
    // THIS is where the user's work was lost.
    clock += 3 * HOUR;
    store.kick();
    await settle();
    const later = store.get("wk");
    assert.equal(later.state, "blocked", "still held, not failed");
    assert.equal(later.blockReason, "hostBusy");
    assert.equal(state.ran.some((r) => r.id === "wk"), false, "and it has not run yet");

    // The desktop frees up. The row runs — late, and saying so.
    releaseHog();
    await settle();
    store.kick();
    await settle();
    assert.equal(state.ran.some((r) => r.id === "wk"), true, "the work the user asked for actually ran");
    const done = store.get("wk");
    // A standing rule goes back to `queued` with the next Thursday armed — the
    // run itself is what `result` records.
    assert.equal(done.state, "queued");
    assert.equal(done.result.ok, true);
    assert.equal(done.result.late, true, "it ran late, and says so");
    assert.equal(done.nextAt > clock, true, "and the next occurrence is armed");
    // The stamp is spent with the occurrence — it belongs to a run that happened.
    assert.equal(done.clearedOccurrence, undefined);
    assert.equal(rowsOnDisk(root).find((r) => r.id === "wk").clearedOccurrence, undefined);
  } finally {
    Date.now = realNow;
    store.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

// ── 6. a Stop is evidence about ONE turn ────────────────────────────────────

test("a chain whose LATER step never landed is not settled done by step 1's Stop", async () => {
  // `fire()`'s Stop shortcut exists for a real case: on a fast turn the hook
  // beats the executor's return value, and calling that row `unsubmitted` would
  // gravestone work the CLI itself recorded as done. But a `Stop` says one TURN
  // ended, and on a chain the turn that ended is step 1's — which a later step's
  // failure already takes for granted.
  //
  // Reproduced before this rule: a three-step item whose step 1 ran, whose Stop
  // arrived while step 2 was being delivered, and whose step 2 came back
  // `unconfirmed`, settled `done` saying *"its turn finished — the hook confirmed
  // it"* — with two of its three turns never typed, and the sentence naming the
  // stopped step thrown away. The person is told the item is done.
  const CHAIN = "Instruction sent but not confirmed on screen. (This is turn 2 of 3; turn 1 already ran in this session, so it is NOT re-run from the top — send the rest by hand.)";
  let store;
  const h = makeStore({
    executors: {
      freshSession: async (i) => {
        // `noteSession` takes the completion baseline; step 1's turn then ENDS
        // while step 2 is still being delivered.
        store.noteSession(i.id, "S1");
        store.onTurnEnded("S1", 1);
        return { ok: false, sessionId: "S1", retry: false, step: 1, detail: CHAIN };
      },
      sweep: async () => ({ ok: true, detail: "" }),
      deliver: async () => ({ ok: true, detail: "" }),
      workItem: async () => ({ ok: true, detail: "" }),
      build: async () => ({ ok: true, detail: "" }),
      assess: async () => ({ ok: true, detail: "" }),
    },
  });
  store = h.store;
  h.state.sessions.push({ id: "S1", cwd: REPO, running: true });
  await store.reconcile();
  store.post({
    id: "ch", cwd: REPO,
    payload: { kind: "prompt", steps: ["one", "two", "three"] },
    target: { kind: "repo", fresh: true },
    trigger: { kind: "now" },
    auto: true, title: "a chain",
  });
  store.kick();
  await settle();
  const row = store.get("ch");
  assert.equal(row.state, "failed", "two of its three turns never happened");
  assert.equal(row.result.detail, CHAIN, "and the row keeps the sentence that says which step stopped");
  h.done?.();
  store.stop();
  rmSync(h.root, { recursive: true, force: true });
});

test("…and the shortcut still works for the case it was written for: step ONE", async () => {
  // The other half. A single-turn item whose echo window could not confirm what
  // it typed, with a Stop past the baseline, is finished work — and an executor
  // that says nothing about steps (`step` absent) is read as step 0, which is
  // the "absent means the old behaviour" rule this store runs on.
  let store;
  const h = makeStore({
    executors: {
      freshSession: async (i) => {
        store.noteSession(i.id, "S1");
        store.onTurnEnded("S1", 1);
        return { ok: false, sessionId: "S1", retry: false, detail: "Instruction sent but not confirmed on screen." };
      },
      sweep: async () => ({ ok: true, detail: "" }),
      deliver: async () => ({ ok: true, detail: "" }),
      workItem: async () => ({ ok: true, detail: "" }),
      build: async () => ({ ok: true, detail: "" }),
      assess: async () => ({ ok: true, detail: "" }),
    },
  });
  store = h.store;
  h.state.sessions.push({ id: "S1", cwd: REPO, running: true });
  await store.reconcile();
  store.post({
    id: "one", cwd: REPO,
    payload: { kind: "prompt", steps: ["just the one"] },
    target: { kind: "repo", fresh: true },
    trigger: { kind: "now" },
    auto: true, title: "one turn",
  });
  store.kick();
  await settle();
  assert.equal(store.get("one").state, "done");
  assert.match(store.get("one").result.detail, /the hook confirmed it/);
  store.stop();
  rmSync(h.root, { recursive: true, force: true });
});

test("a WEEKLY wall is two walls, and the item's words are still typed exactly once", async () => {
  // The exemption used to be read off the row's TARGET (`needsSlot`), which the
  // re-aim itself destroys: after wall 1 the target is `{kind:"session"}`, so at
  // wall 2 the row took the ordinary branch — `queued`, "it will run again when
  // the session reopens" — and the tick's `session`-target re-aim then delivered
  // the WHOLE item into S3, the session that had `--continue`d the item's own
  // conversation and was already resuming it.
  //
  // And two walls is the NORMAL shape for a weekly limit, not an edge:
  // `maybeScheduleResurrect` reopens a weekly-limited session at `now + 5_000`
  // ("an upgraded plan continues now"), so S2 opens five seconds later and hits
  // the same wall by construction.
  const dead = new Set();
  const revived = new Map();
  const { store, state, root } = makeStore({
    diedAtLimit: (id) => dead.has(id),
    revivedSessionFor: (id) => {
      let cur = id;
      while (revived.has(cur)) cur = revived.get(cur);
      return cur !== id && state.sessions.some((s) => s.id === cur && s.running) ? cur : null;
    },
    sessionIdleMs: (id) => (state.sessions.some((x) => x.id === id && x.running) ? 0 : null),
    executors: {
      freshSession: async (i) => { state.ran.push({ name: "freshSession", id: i.id }); return { ok: true, sessionId: "S1", watch: "turn", detail: "ran" }; },
      deliver: async (i, sid) => { state.ran.push({ name: "deliver", id: i.id, sid }); return { ok: true, sessionId: sid, watch: "turn", detail: "delivered" }; },
      sweep: async () => ({ ok: true, detail: "" }),
      workItem: async () => ({ ok: true, detail: "" }),
      build: async () => ({ ok: true, detail: "" }),
      assess: async () => ({ ok: true, detail: "" }),
    },
  });
  await store.reconcile();
  store.post(workItem("wk2"));
  store.kick();
  await settle();
  state.sessions.push({ id: "S1", cwd: REPO, running: true });
  assert.equal(store.get("wk2").state, "running");

  // Wall 1.
  state.sessions[0].running = false;
  dead.add("S1");
  store.onSessionExit("S1");
  await settle();
  assert.equal(store.get("wk2").state, "running", "held, following its own session");

  // Five seconds later the weekly resurrection opens S2, and the tick re-aims.
  state.sessions.push({ id: "S2", cwd: REPO, running: true });
  revived.set("S1", "S2");
  store.kick();
  await settle();
  assert.deepEqual(store.get("wk2").target, { kind: "session", sessionId: "S2" });
  assert.equal(store.get("wk2").followed, true, "and the row records that it has followed one");
  assert.equal(rowsOnDisk(root).find((r) => r.id === "wk2").followed, true, "…on disk, because the wait is hours long");

  // Wall 2 — S2 hits the same weekly limit.
  state.sessions[1].running = false;
  dead.add("S2");
  store.onSessionExit("S2");
  await settle();
  assert.equal(store.get("wk2").state, "running", "still following — a requeue here types the item a SECOND time");

  // S3 replaces S2 and is resuming the item's own conversation.
  state.sessions.push({ id: "S3", cwd: REPO, running: true });
  revived.set("S2", "S3");
  store.kick();
  await settle();
  assert.deepEqual(store.get("wk2").target, { kind: "session", sessionId: "S3" });
  assert.equal(state.ran.filter((r) => r.name === "deliver").length, 0, "the words were never typed a second time");
  assert.equal(state.ran.length, 1, "one delivery, all told");

  // And it completes on S3's turn, once.
  store.onTurnEnded("S3", 1);
  await settle();
  assert.equal(store.get("wk2").state, "done");
  // The flag belongs to the run that has now ended.
  store.stop();
  rmSync(root, { recursive: true, force: true });
});

/** A store whose `workItem` executor records what it was asked to mint, so
 *  "which executor ran" is an assertion rather than an inference. */
function childMakingStore() {
  const added = [];
  const ran = [];
  const { store, root } = makeStore({
    executors: {
      freshSession: async (i) => { ran.push(`freshSession:${i.id}`); return { ok: true, detail: "" }; },
      sweep: async () => ({ ok: true, detail: "" }),
      deliver: async () => ({ ok: true, detail: "" }),
      // `main.ts`'s executor, in the one line this is about.
      workItem: async (i) => {
        ran.push(`workItem:${i.id}`);
        added.push(scheduleItemOrigin(i.id));
        return { ok: true, detail: "queued" };
      },
      build: async () => ({ ok: true, detail: "" }),
      assess: async () => ({ ok: true, detail: "" }),
    },
  });
  return { store, root, added, ran };
}

test("a RECURRING schedule's backlog item is stamped with the rule that wrote it", async () => {
  // `lastResult.childId` names the LAST item a rule produced and nothing before
  // it, so a nightly rule that had run four times said "backlog · 1 item". The
  // origin is durable and per-item, which is what widens that to every row the
  // rule ever wrote — and it is read back through `scheduleIdFromOrigin`, never
  // a bare `startsWith`, because `schedule:` already marks the RULE's own row.
  //
  // A standing rule is the whole of what still makes a child: it outlives each
  // occurrence, so each occurrence needs a row of its own to be the account of.
  const { store, root, added, ran } = childMakingStore();
  await store.reconcile();
  store.post({ ...weekly("sch-origin"), origin: "schedule:work" });
  // `post` kicks, and a kick in flight swallows the next one — so let that pass
  // finish before moving the clock under the row.
  await settle();
  store.get("sch-origin").nextAt = Date.now() - 1000;
  store.kick();
  await settle();
  assert.deepEqual(ran, ["workItem:sch-origin"], "a rule mints a child per occurrence");
  assert.deepEqual(added, ["schedule:sch-origin"]);
  // The rule's OWN row keeps its reserved marker and is not mistaken for an item.
  assert.equal(scheduleIdFromOrigin(store.get("sch-origin").origin), undefined);
  store.stop();
  rmSync(root, { recursive: true, force: true });
});

test("a ONE-OFF with the same origin runs itself, and makes no child at all", async () => {
  // The failure this is the fix for: one piece of one-off work was TWO rows,
  // and the first could fail at rung 3 (its grace missed) before the second
  // existed — which is how seven items on this desktop ended up `failed`, in no
  // repo's backlog, and invisible to the smart pick, whose candidates are
  // backlog rows. A one-off has nothing to outlive; it runs itself.
  const { store, root, added, ran } = childMakingStore();
  await store.reconcile();
  store.post(onceAt("sch-once", Date.now() - 60_000, { origin: "schedule:work" }));
  store.kick();
  await settle();
  assert.deepEqual(ran, ["freshSession:sch-once"], "the awaited backlog path, in a session of its own");
  assert.deepEqual(added, [], "no child row — one piece of work, one row, one account of it");
  assert.equal(store.get("sch-once").state, "done");
  assert.equal(store.get("sch-once").result?.childId, undefined, "…and nothing on the row points at one");
  store.stop();
  rmSync(root, { recursive: true, force: true });
});

// ── 10. drop the clock: reviving a FAILED one-off with a new trigger ─────────
//
// `runNow`'s carve-out a keystroke earlier. A spent one-off is the one terminal
// row a person can still MEAN — the words are on the screen in front of them —
// and *this missed its time, run it in turn instead* is a patch rather than a
// fire, because what changes is WHEN it waits for, not that it runs now.

/** Post a one-off whose instant is already long past, and let the ladder fail
 *  it — the exact shape of the seven rows this exists for. */
async function failedTimedRow(store, id) {
  store.post(onceAt(id, Date.now() - 4 * HOUR));
  store.kick();
  await settle();
  assert.equal(store.get(id).state, "failed", "the fixture really is a failed one-off");
  return store.get(id);
}

test("a row still QUEUED that drops its clock sheds the clock's bookkeeping too", async () => {
  // The rescue path cleared `nextAt`/`lastOccurrence`/`clearedOccurrence`, but
  // only while `reviving` — i.e. only for a FAILED row. A row whose clock is
  // dropped while it is still waiting took none of the branches (the arming one
  // asks for `trigger.kind === "at"`, and by then it is `idle`) and kept an
  // armed instant that nothing reads, plus a spent occurrence that would have
  // been a floor if it were ever re-clocked. What decides whether a row has a
  // clock is its TRIGGER, never the state it happens to be in.
  const { store, root } = makeStore();
  await store.reconcile();
  const at = Date.now() + 60 * 60_000;
  store.post({
    id: "dq1", cwd: `${root}/myapp`, payload: { kind: "prompt", steps: ["still waiting"] },
    target: { kind: "repo", fresh: true },
    trigger: { kind: "at", rule: { kind: "once", at }, graceMin: 120 },
  }, Date.now());
  const before = store.get("dq1");
  // `blocked`/`notYet`, not `queued` — the tick runs synchronously on `post` and
  // an instant an hour out is exactly what rung 3 holds. Either is "still
  // waiting"; what this test is about is the bookkeeping, not the lifecycle.
  assert.ok(before.state === "queued" || before.state === "blocked", `still waiting, got ${before.state}`);
  assert.ok(typeof before.nextAt === "number", "armed before the clock is dropped");

  const r = store.update("dq1", { trigger: { kind: "idle" } });
  assert.equal(r.ok, true, r.reason);
  const row = store.get("dq1");
  assert.equal(row.trigger.kind, "idle");
  assert.equal(row.nextAt, undefined, "an untimed row carries no armed instant");
  assert.equal(row.lastOccurrence, undefined);
  assert.equal(row.clearedOccurrence, undefined);
});

test("a queued row re-timed to a new one-off instant is armed at it, even one whose old clock was never armed", async () => {
  const { store, root } = makeStore();
  await store.reconcile();
  // A window rule with no usage reading arms to nothing — the row waits under
  // a clock with no instant. The phone's bulk *re-time these N* names one.
  store.post({
    id: "rt1", cwd: `${root}/myapp`, payload: { kind: "prompt", steps: ["waiting on a reset"] },
    target: { kind: "repo", fresh: true },
    trigger: { kind: "at", rule: { kind: "window", window: "weekly", edge: "after", offsetMin: 0, oneShot: true }, graceMin: 120 },
  }, Date.now());
  assert.equal(store.get("rt1").nextAt ?? null, null, "no reading, nothing armed");
  const at = Date.now() + 2 * HOUR;
  const r = store.update("rt1", { trigger: { kind: "at", rule: { kind: "once", at, offsetMin: 0 }, graceMin: 120 } });
  assert.equal(r.ok, true, r.reason);
  const row = store.get("rt1");
  assert.equal(row.nextAt, at, "armed at the instant the person named");
  assert.equal(row.lastOccurrence, undefined, "the old rule's bookkeeping went with it");
  store.stop();
  rmSync(root, { recursive: true, force: true });
});

test("dropping the clock on a failed one-off puts it back in the queue, and it fires", async () => {
  const { store, state, root } = makeStore();
  await store.reconcile();
  await failedTimedRow(store, "dc1");
  state.ran.length = 0;

  // The exact patch the phone's *drop the clock* sends.
  const r = store.update("dc1", { trigger: { kind: "idle" } });
  assert.equal(r.ok, true, r.reason);
  const row = store.get("dc1");
  assert.equal(row.state, "queued");
  assert.equal(row.trigger.kind, "idle");
  // Everything that was bookkeeping about the clock goes with the clock — a row
  // that waits its turn while still carrying an armed instant and a spent
  // occurrence is two rows' worth of state in one.
  assert.equal(row.nextAt, undefined);
  assert.equal(row.lastOccurrence, undefined);
  assert.equal(row.clearedOccurrence, undefined);
  // …and the same field set `requeue()` clears, or the row is queued and still
  // says it started, failed and was filed away.
  assert.equal(row.settledAt, undefined);
  assert.equal(row.startedAt, undefined);
  assert.equal(row.sessionId, undefined);
  assert.equal(row.attempts, undefined);
  assert.equal(rowsOnDisk(root).find((x) => x.id === "dc1").trigger.kind, "idle", "…on disk, before the ack");

  store.kick();
  await settle();
  assert.deepEqual(state.ran.map((x) => x.name), ["freshSession"], "it waits its turn like any other item");
  assert.equal(store.get("dc1").state, "done");
  store.stop();
  rmSync(root, { recursive: true, force: true });
});

test("a re-clocked failed one-off arms from scratch, and re-fails in words if the new instant is gone too", async () => {
  const { store, root } = makeStore();
  await store.reconcile();
  await failedTimedRow(store, "dc2");

  // Forward: a real new instant.
  const at = Date.now() + 2 * HOUR;
  assert.equal(store.update("dc2", { trigger: { kind: "at", rule: { kind: "once", at, offsetMin: 0 }, graceMin: 120 } }).ok, true);
  assert.equal(store.get("dc2").nextAt, at, "armed from the NEW rule, never floored by the spent occurrence");
  assert.equal(store.get("dc2").blockReason, "notYet", "…and it is simply waiting for the instant the person named");
  assert.equal(store.get("dc2").result?.ok, false, "the failed run it is being rescued from is still its account of itself");

  // Backward: an instant that is still past its grace. It arms to nothing and
  // the ladder fails it again saying so — honest, and not a loop, because
  // nothing here retries on its own.
  const { store: s2, root: r2 } = makeStore();
  await s2.reconcile();
  await failedTimedRow(s2, "dc3");
  assert.equal(s2.update("dc3", { trigger: { kind: "at", rule: { kind: "once", at: Date.now() - 6 * HOUR, offsetMin: 0 }, graceMin: 120 } }).ok, true);
  assert.equal(s2.get("dc3").nextAt, null);
  s2.kick();
  await settle();
  assert.equal(s2.get("dc3").state, "failed");
  assert.match(s2.get("dc3").result.detail, /one-off/);

  store.stop(); s2.stop();
  rmSync(root, { recursive: true, force: true });
  rmSync(r2, { recursive: true, force: true });
});

test("the carve-out is exactly failed + timed + a trigger, and refuses everything else", async () => {
  const { store, root } = makeStore();
  await store.reconcile();

  // A text-only patch on a failed row is refused as it always was: rewording a
  // gravestone quietly turns it back into pending work and nothing says so.
  await failedTimedRow(store, "dc4");
  const words = store.update("dc4", { payload: { kind: "prompt", steps: ["different words"] } });
  assert.equal(words.ok, false);
  assert.match(words.reason, /already failed/);
  assert.equal(store.get("dc4").state, "failed", "and nothing was written");

  // `done` is not a rescue. It ran; there is nothing owed.
  store.post(onceAt("dc5", Date.now() - 5 * 60_000));
  store.kick();
  await settle();
  assert.equal(store.get("dc5").state, "done");
  const done = store.update("dc5", { trigger: { kind: "idle" } });
  assert.equal(done.ok, false);
  assert.match(done.reason, /already done/);

  // Neither is a spent SWEEP: it has no single backlog to be put back into, and
  // the schedule sheet has its own verbs for it.
  store.post(onceSweep("dc6", Date.now() - 4 * HOUR));
  store.kick();
  await settle();
  assert.equal(store.get("dc6").state, "failed");
  const sweepPatch = store.update("dc6", { trigger: { kind: "idle" } });
  assert.equal(sweepPatch.ok, false);
  assert.match(sweepPatch.reason, /already failed/);

  store.stop();
  rmSync(root, { recursive: true, force: true });
});

// ── 11. a `retry` is "provably nothing was typed", so the occurrence comes back ─
//
// The worst failure class this repo has — a prompt that never ran — and it
// landed on exactly the rows `isTimedWorkRow` moved into the backlog. A one-off
// with a clock takes `freshSession`'s AWAITED branch now, which is the one
// executor that can answer `retry` at all (a full pty table, `notready`, an
// ambiguous echo). `fire()` spends the occurrence before the executor is
// invoked, and the retry branch used to hand the row back to the queue with
// nothing left to wait for — so the next tick's rung 3 gravestoned it with
// *"that instant has passed and this was a one-off — post it again"*, about an
// instant that had not passed and a prompt nothing had typed.
//
// `test:unit` and `test:host` were both green while that was live, which is why
// these are here: a suite that green-lights a never-run prompt is as much the
// bug as the branch is.

/** Answer `retry` for the next executor call and `ok` for every one after it. */
const retryOnce = (state) => {
  state.result = { ok: false, retry: true, detail: "not delivered — the session never became typeable" };
};
const thenDeliver = (state) => { state.result = { ok: true, detail: "delivered" }; };

test("a retry on a timed one-off hands the occurrence back, and the row RUNS", async () => {
  const { store, state, root } = makeStore();
  await store.reconcile();
  const due = Date.now() - 1000;
  retryOnce(state);
  store.post(onceAt("rt1", due));
  store.kick();
  await settle();

  const held = store.get("rt1");
  assert.equal(held.state, "queued", "a retry returns the row to the queue — that much always worked");
  assert.equal(held.attempts, 1);
  assert.equal(held.nextAt, due, "…and it is armed at the instant it was due, not at nothing");
  assert.equal(held.lastOccurrence, undefined, "the occurrence is UNspent — nothing was typed, so nothing was used up");
  assert.equal(held.clearedOccurrence, due,
    "rung 3 released this occurrence once by letting it reach `fire()`; the retry is not judged against that grace twice");

  thenDeliver(state);
  store.kick();
  await settle();
  const row = store.get("rt1");
  assert.equal(row.state, "done", "it ran on the second attempt, exactly like an untimed row does");
  assert.equal(state.ran.length, 2, "one refused attempt, one that landed");
  assert.equal(row.nextAt, null, "and NOW it is spent");
  store.stop();
  rmSync(root, { recursive: true, force: true });
});

test("…and the same row with an `idle` trigger is the control: both reach `done`", async () => {
  // The control half of the reproduction. Before the fix the timed row ended
  // `failed` having run ZERO times while this one ran on tick 2 — one executor,
  // one verdict, two outcomes, and the only difference was the clock.
  const { store, state, root } = makeStore();
  await store.reconcile();
  retryOnce(state);
  store.post(workItem("rt2"));
  store.kick();
  await settle();
  assert.equal(store.get("rt2").state, "queued");
  thenDeliver(state);
  store.kick();
  await settle();
  assert.equal(store.get("rt2").state, "done");
  assert.equal(state.ran.length, 2);
  store.stop();
  rmSync(root, { recursive: true, force: true });
});

test("a retry on a one-shot WINDOW rule does not silently reschedule it to the next reset", async () => {
  // The worse-shaped half of the same bug. `armFrom` on a `window` rule finds
  // the FOLLOWING reset perfectly happily, so the spend left a retried row
  // armed an hour (or a week) out: not a gravestone this time, just work that
  // quietly happens at the wrong moment and says nothing about it.
  const usageWindows = () => ({ sessionResetAt: Date.now() + HOUR, sessionPct: 10 });
  const { store, state, root } = makeStore({ usageWindows });
  await store.reconcile();
  store.post(windowOnce("rt3"));
  await settle();
  const due = Date.now() - 1000;
  store.get("rt3").nextAt = due;
  retryOnce(state);
  store.kick();
  await settle();

  const held = store.get("rt3");
  assert.equal(held.state, "queued");
  assert.equal(held.nextAt, due, "still the occurrence it was due at — NOT the reset an hour from now");
  assert.equal(held.lastOccurrence, undefined);

  thenDeliver(state);
  store.kick();
  await settle();
  assert.equal(store.get("rt3").state, "done", "it runs at the instant it was meant to, on the next tick");
  assert.equal(state.ran.length, 2);
  store.stop();
  rmSync(root, { recursive: true, force: true });
});

test("a RECURRING rule keeps standing policy on a retry — its occurrence stays spent", async () => {
  // Deliberately untouched. A recurring rule's occurrence is one of many and
  // `armFrom` has already placed the next one; handing this one back would arm
  // the same instant twice, which is this file firing a schedule twice by
  // another route. Same reading `reconcileOne` and `recordMissed` take.
  const { store, state, root } = makeStore();
  await store.reconcile();
  retryOnce(state);
  store.post({
    id: "rt4", cwd: REPO,
    payload: { kind: "prompt", steps: ["the weekly sweep"] },
    target: { kind: "repo", fresh: true },
    trigger: { kind: "at", rule: { kind: "weekly", hour: 3, minute: 0 }, graceMin: 120 },
    title: "every night at 03:00",
  });
  await settle();
  const due = Date.now() - 1000;
  store.get("rt4").nextAt = due;
  store.kick();
  await settle();
  const row = store.get("rt4");
  assert.equal(row.state, "queued");
  assert.equal(row.lastOccurrence, due, "spent — the standing rule records the occurrence and waits for the next one");
  assert.ok(row.nextAt > Date.now(), "…which is already armed, ahead of us");
  store.stop();
  rmSync(root, { recursive: true, force: true });
});

test("a restart mid-delivery whose log proves nothing was typed re-arms the instant too", async () => {
  // `reconcileOne`'s `absent` verdict is the SAME proof `retry` is — a readable
  // conversation log without the words — and it wrote *"nothing ran, so it is
  // queued again"* onto a one-off whose `nextAt` was already null. The very
  // next tick overwrote that sentence with the "instant has passed" gravestone,
  // so the row said two contradictory things about itself in two seconds and
  // ran neither time.
  const root = mkdtempSync(join(tmpdir(), "waterplane-sched-rt-"));
  mkdirSync(join(root, ".waterplane"), { recursive: true });
  const due = Date.now() - 60_000;
  writeFileSync(join(root, ".waterplane", "intents.json"), JSON.stringify({
    schema: 2,
    intents: [{
      ...onceAt("rt5", due),
      state: "starting", createdAt: due - HOUR, startedAt: due,
      sessionId: "s-dead", nextAt: null, lastOccurrence: due,
    }],
  }));
  // Read off DISK at the first broadcast: `reconcile()` persists and announces
  // what it decided and then kicks the tick, and on this row the tick fires
  // straight away — which is the point, but it also means `store.get()` after
  // the await is already looking at the second life of the row.
  let back;
  const { store, state } = makeStore({
    root,
    logVerdict: () => "absent",
    onChange: () => { back ??= rowsOnDisk(root).find((r) => r.id === "rt5"); },
  });
  await store.reconcile();
  assert.equal(back.state, "queued");
  assert.match(back.result.detail, /nothing ran, so it is queued again/);
  assert.equal(back.nextAt, due, "and there is an instant to be queued FOR");
  assert.equal(back.lastOccurrence, undefined);
  await settle();
  assert.equal(state.ran.length, 1, "so the tick that follows runs it, instead of burying it");
  assert.equal(store.get("rt5").state, "done");
  store.stop();
  rmSync(root, { recursive: true, force: true });
});

// ── 13. a restart while the turn is still running ──────────────────────────
//
// `landed` proves the words were DELIVERED, never that the turn ENDED. A
// restart at 18:51:57 on 2026-09-24 found twelve backlog items mid-turn, each
// alive in its own tmux session, and settled nine of them `done` while their
// conversation logs kept growing. A session that came back is RE-ADOPTED
// (`running`, settled later by its Stop or by silence); one that did not is
// `failed` saying so — never `done`, never run again.

/** A row that was mid-flight when the host went down, written to disk, and a
 *  store booted over it. `sessionIdleMs` defaults to null — a re-attached
 *  session that has printed nothing yet, which is exactly what one is. `over`
 *  may be a function of the root, for a dep that reads the file back. */
function restartOver(rows, over = {}) {
  const root = mkdtempSync(join(tmpdir(), "waterplane-sched-re-"));
  mkdirSync(join(root, ".waterplane"), { recursive: true });
  writeFileSync(join(root, ".waterplane", "intents.json"), JSON.stringify({ schema: 2, intents: rows }));
  const deps = typeof over === "function" ? over(root) : over;
  const made = makeStore({ root, logVerdict: () => "landed", sessionIdleMs: () => null, ...deps });
  made.state.sessions = [{ id: "s-live", cwd: REPO, running: true }];
  // `makeStore` made a root of its own before `over.root` replaced it; the
  // store lives in THIS one.
  rmSync(made.root, { recursive: true, force: true });
  return { ...made, root };
}
const midTurn = (id, extra = {}) => ({
  id, cwd: REPO,
  payload: { kind: "prompt", steps: ["sweep this repo"] },
  target: { kind: "repo", fresh: true },
  trigger: { kind: "idle" },
  title: "backlog · t · sweep",
  origin: "backlog", auto: true,
  state: "running", createdAt: Date.now() - HOUR, startedAt: Date.now() - 5000,
  sessionId: "s-live",
  ...extra,
});

test("a delivered row whose session came back is RE-ADOPTED running, not settled done off the log", async () => {
  const { store, root } = restartOver([midTurn("ra1")]);
  try {
    await store.reconcile();
    await settle();
    const row = rowsOnDisk(root).find((r) => r.id === "ra1");
    assert.equal(row.state, "running", "the log proves delivery — a turn still running writes the same line");
    assert.match(row.blockDetail, /restarted after this was delivered/);
    assert.equal(row.result, undefined, "nothing is claimed about how it ended");
    assert.equal(row.sessionId, "s-live");
  } finally {
    store.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("…and its Stop past the fresh baseline completes it, saying the turn finished AFTER the restart", async () => {
  const { store, root } = restartOver([midTurn("ra2")]);
  try {
    await store.reconcile();
    store.onTurnEnded("s-live", 1);
    const row = store.get("ra2");
    assert.equal(row.state, "done");
    assert.equal(row.result.ok, true);
    assert.match(row.result.detail, /turn finished afterwards/);
    assert.equal(row.nextAt ?? null, null);
  } finally {
    store.stop();
    rmSync(root, { recursive: true, force: true });
  }
  // Control: the baseline is the count the re-attached session already had.
  let count = 4;
  const c = restartOver([midTurn("ra2b")], { stopCount: () => count });
  try {
    await c.store.reconcile();
    c.store.onTurnEnded("s-live", 4);
    assert.equal(c.store.get("ra2b").state, "running", "a Stop AT the baseline is not this turn's");
    count = 5;
    c.store.onTurnEnded("s-live", 5);
    assert.equal(c.store.get("ra2b").state, "done");
  } finally {
    c.store.stop();
    rmSync(c.root, { recursive: true, force: true });
  }
});

test("…or, unhooked, the silence sweep completes it once the session has gone quiet", async () => {
  const { store, root } = restartOver([midTurn("ra3")], { sessionIdleMs: () => 99_000, isHooked: () => false });
  try {
    await store.reconcile();
    store.kick();
    await settle();
    const row = store.get("ra3");
    assert.equal(row.state, "done");
    assert.match(row.result.detail, /gone quiet since/);
  } finally {
    store.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("…and it is LEFT ALONE while busy, at a box, at a dialog nobody could parse, or hooked", async () => {
  const cases = {
    "recently printed": { sessionIdleMs: () => 200 },
    "a choice box": { sessionHasPrompt: () => true },
    "an unparsable dialog": { awaiting: true },
    "hooked (only its Stop may end it)": { isHooked: () => true, sessionIdleMs: () => 99_000 },
  };
  for (const [why, over] of Object.entries(cases)) {
    const { awaiting, ...deps } = over;
    const { store, state, root } = restartOver([midTurn("ra4")], { sessionIdleMs: () => 99_000, ...deps });
    if (awaiting) state.sessions = [{ id: "s-live", cwd: REPO, running: true, awaitingInput: true }];
    try {
      await store.reconcile();
      store.kick(); await settle();
      store.kick(); await settle();
      assert.equal(store.get("ra4").state, "running", why);
      assert.equal(state.ran.length, 0, `${why}: nothing typed again`);
    } finally {
      store.stop();
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("a delivered row whose session did NOT come back fails saying so — never done, never re-run", async () => {
  const { store, state, root } = restartOver([midTurn("ra5")]);
  state.sessions = [];
  const events = [];
  store.on("settled", (r, res) => events.push(res));
  try {
    await store.reconcile();
    await settle();
    const row = store.get("ra5");
    assert.equal(row.state, "failed");
    assert.equal(row.result.ok, false);
    assert.match(row.result.detail, /did not come back/);
    assert.equal(row.nextAt ?? null, null);
    assert.equal(row.sessionId, "s-live", "a failed one-off keeps the record of where its words went");
    assert.equal(state.ran.length, 0);
    assert.equal(events.filter((e) => e.ok).length, 0, "nothing announced as having worked");
  } finally {
    store.stop();
    rmSync(root, { recursive: true, force: true });
  }
  // A standing rule records the occurrence as failed and waits for the next one.
  const rule = midTurn("ra5r", {
    target: { kind: "session", sessionId: "s-live" },
    trigger: { kind: "at", rule: { kind: "weekly", days: [], hour: 4, minute: 0, tz: "UTC", offsetMin: 0 }, graceMin: 120 },
    lastOccurrence: Date.now() - 5000,
  });
  // Read off DISK at reconcile's own broadcast, before the tick has a say.
  let back;
  const r = restartOver([rule], (root) => ({ onChange: () => { back ??= rowsOnDisk(root).find((x) => x.id === "ra5r"); } }));
  r.state.sessions = [];
  try {
    await r.store.reconcile();
    assert.equal(back.state, "queued");
    assert.equal(back.result.ok, false);
    assert.match(back.result.detail, /did not come back/);
    assert.ok(back.nextAt > Date.now(), "re-armed for its next occurrence");
    assert.equal(back.startedAt, undefined);
    assert.equal(back.sessionId, undefined, "a standing rule back in the queue is aimed at nothing yet");
  } finally {
    r.store.stop();
    rmSync(r.root, { recursive: true, force: true });
  }
});

test("a delivered row whose session died AT THE LIMIT follows it to the reopened one", async () => {
  let revived = "s-new";
  const { store, state, root } = restartOver([midTurn("ra6", { sessionId: "s-old" })], {
    diedAtLimit: (id) => id === "s-old",
    revivedSessionFor: (id) => (id === "s-old" ? revived : null),
  });
  state.sessions = [{ id: "s-new", cwd: REPO, running: true }];
  try {
    await store.reconcile();
    store.kick();
    await settle();
    const row = store.get("ra6");
    assert.equal(row.state, "running");
    assert.equal(row.sessionId, "s-new");
    assert.equal(row.followed, true);
    assert.equal(state.ran.length, 0, "never queued, so never typed twice");
  } finally {
    store.stop();
    rmSync(root, { recursive: true, force: true });
  }
  revived = null;
  const n = restartOver([midTurn("ra6b", { sessionId: "s-old" })], {
    diedAtLimit: (id) => id === "s-old",
    revivedSessionFor: () => null,
  });
  n.state.sessions = [];
  try {
    await n.store.reconcile();
    n.store.kick();
    await settle();
    const row = n.store.get("ra6b");
    assert.equal(row.state, "running", "held, following — never queued, never done");
    assert.match(row.blockDetail, /following it to the reopened one/);
  } finally {
    n.store.stop();
    rmSync(n.root, { recursive: true, force: true });
  }
});

test("a STARTING row whose delivery landed takes the same re-adoption", async () => {
  const { store, root } = restartOver([midTurn("ra7", { state: "starting" })]);
  try {
    await store.reconcile();
    const row = store.get("ra7");
    assert.equal(row.state, "running");
    assert.match(row.blockDetail, /restarted after this was delivered/);
    store.onTurnEnded("s-live", 1);
    assert.equal(store.get("ra7").state, "done");
  } finally {
    store.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unreadable log with the session alive is still refused, as before", async () => {
  const { store, root } = restartOver([midTurn("ra8")], { logVerdict: () => "unknown" });
  try {
    await store.reconcile();
    const row = store.get("ra8");
    assert.equal(row.state, "failed");
    assert.match(row.result.detail, /check the session/);
    assert.equal(row.sessionId, "s-live", "a LIVE session keeps its id — it is the one the sentence says to check");
  } finally {
    store.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a re-adopted pane with no honest idle reading (tmux copy-mode ⇒ null) is never read as quiet", async () => {
  // `main.ts` hands the store `null` for a pane in copy-mode: the client shows
  // history and no live bytes arrive, so the silence is a frozen view.
  const { store, state, root } = restartOver([midTurn("rc1")], { sessionIdleMs: () => null, isHooked: () => false });
  try {
    await store.reconcile();
    store.kick(); await settle();
    store.kick(); await settle();
    assert.equal(store.get("rc1").state, "running");
    assert.equal(state.ran.length, 0);
  } finally {
    store.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("hooked by a Notification alone (no turn-shaped hook since attach) still settles on silence", async () => {
  // The `idle_prompt` Notification fires a minute after a turn ends — here,
  // after a turn that ended while the host was down, whose Stop went nowhere.
  // It makes the session `hooked`, and a hooked row used to wait for a Stop
  // for ever.
  const { store, root } = restartOver([midTurn("rn1")], {
    isHooked: () => true, turnHookSeen: () => false, sessionIdleMs: () => 99_000,
  });
  try {
    await store.reconcile();
    store.kick(); await settle();
    const row = store.get("rn1");
    assert.equal(row.state, "done");
    assert.match(row.result.detail, /gone quiet since/);
  } finally {
    store.stop();
    rmSync(root, { recursive: true, force: true });
  }
  // Control: once a turn-shaped hook has reported, only its Stop may end it.
  const c = restartOver([midTurn("rn2")], { isHooked: () => true, turnHookSeen: () => true, sessionIdleMs: () => 99_000 });
  try {
    await c.store.reconcile();
    c.store.kick(); await settle();
    c.store.kick(); await settle();
    assert.equal(c.store.get("rn2").state, "running");
  } finally {
    c.store.stop();
    rmSync(c.root, { recursive: true, force: true });
  }
});

test("a hooked row silent past the reap ceiling is FAILED — a lost Stop, never done", async () => {
  const hooked = { isHooked: () => true, turnHookSeen: () => true, reapCeilingMs: () => HOUR };
  const { store, root } = restartOver([midTurn("rb1")], { ...hooked, sessionIdleMs: () => HOUR + 1000 });
  try {
    await store.reconcile();
    store.kick(); await settle();
    const row = store.get("rb1");
    assert.equal(row.state, "failed");
    assert.equal(row.result.ok, false);
    assert.equal(row.result.detail, "no turn-end signal arrived and the session has been silent for an hour — check the conversation before running it again");
  } finally {
    store.stop();
    rmSync(root, { recursive: true, force: true });
  }
  // A standing rule: its occurrence recorded as failed, the rule kept.
  const rule = midTurn("rb2", {
    trigger: { kind: "at", rule: { kind: "weekly", days: [], hour: 4, minute: 0, tz: "UTC", offsetMin: 0 }, graceMin: 120 },
    lastOccurrence: Date.now() - HOUR, nextAt: Date.now() + 20 * HOUR,
  });
  const r = restartOver([rule], { ...hooked, sessionIdleMs: () => HOUR + 1000 });
  try {
    await r.store.reconcile();
    r.store.kick(); await settle();
    const row = r.store.get("rb2");
    assert.equal(row.state === "queued" || row.state === "blocked", true, `back to waiting, got ${row.state}`);
    assert.equal(row.result.ok, false);
    assert.match(row.result.detail, /no turn-end signal/);
  } finally {
    r.store.stop();
    rmSync(r.root, { recursive: true, force: true });
  }
  // Under the ceiling, or with a question up, it waits.
  for (const [why, over] of Object.entries({
    "under the ceiling": { sessionIdleMs: () => HOUR - 1000 },
    "a box is up": { sessionIdleMs: () => HOUR + 1000, sessionHasPrompt: () => true },
  })) {
    const w = restartOver([midTurn("rb3")], { ...hooked, ...over });
    try {
      await w.store.reconcile();
      w.store.kick(); await settle();
      assert.equal(w.store.get("rb3").state, "running", why);
    } finally {
      w.store.stop();
      rmSync(w.root, { recursive: true, force: true });
    }
  }
});

// ── 12. the legacy two-row shape, folded on boot ────────────────────────────

test("a spent timed parent whose child is still here is set aside, never deleted", async () => {
  // Before `isTimedWorkRow`, a one-off `at` row with `origin: schedule:work`
  // did not run its own words: it made a CHILD and settled itself `done` with
  // the child's id. One piece of work, two rows — and eight of those parents are
  // in the live store. Under the new classification they are BACKLOG rows, so
  // the repo's backlog showed each piece of work twice: the session that ran it,
  // and a parent with a clock chip, no session, no *open*, and a *re-fire* that
  // would type the words a second time.
  const root = mkdtempSync(join(tmpdir(), "waterplane-sched-fold-"));
  mkdirSync(join(root, ".waterplane"), { recursive: true });
  const past = Date.now() - 4 * HOUR;
  writeFileSync(join(root, ".waterplane", "intents.json"), JSON.stringify({
    schema: 2,
    intents: [
      // The parent, and the child that is the account of its work.
      { ...onceAt("legacy-parent", past, { origin: "schedule:work" }), state: "done", createdAt: past,
        settledAt: past, nextAt: null, result: { at: past, ok: true, detail: "queued in the backlog", childId: "legacy-child" } },
      { ...workItem("legacy-child", { origin: "schedule:legacy-parent" }), state: "done", createdAt: past, settledAt: past },
      // A parent whose child has been compacted away is LEFT ALONE: it is the
      // only account of that work left, and setting it aside would hide it.
      { ...onceAt("orphan-parent", past, { origin: "schedule:work" }), state: "done", createdAt: past,
        settledAt: past, nextAt: null, result: { at: past, ok: true, detail: "queued in the backlog", childId: "gone-long-ago" } },
      // A RECURRING rule mints a child per occurrence and must keep standing.
      { id: "weekly-rule", cwd: REPO, payload: { kind: "prompt", steps: ["the weekly sweep"] },
        target: { kind: "repo", fresh: true }, title: "every week",
        trigger: { kind: "at", rule: { kind: "weekly", hour: 3, minute: 0 }, graceMin: 120 },
        state: "queued", createdAt: past, origin: "schedule:work",
        result: { at: past, ok: true, detail: "queued in the backlog", childId: "legacy-child" } },
    ],
  }));
  const { store } = makeStore({ root });
  assert.equal(store.get("legacy-parent").archived, true, "set aside — the child is the account of the work");
  assert.ok(store.get("legacy-parent"), "…and still there: `archived` is rung 1 of the ladder, not a delete");
  assert.equal(store.get("legacy-parent").payload.steps[0], "do the thing", "the words are untouched");
  assert.equal(store.get("legacy-child").archived, undefined, "the child is the row that stays");
  assert.equal(store.get("orphan-parent").archived, undefined, "a childId pointing at nothing is left alone");
  assert.equal(store.get("weekly-rule").archived, undefined, "a standing rule keeps standing");
  assert.equal(rowsOnDisk(root).find((r) => r.id === "legacy-parent").archived, true, "written, not merely believed");

  // Idempotent: a second boot over the same file finds nothing to do, and an
  // archived row that somebody brought BACK is not archived again.
  store.stop();
  const { store: s2 } = makeStore({ root });
  s2.edit("legacy-parent", { archived: false });
  const { store: s3 } = makeStore({ root });
  assert.equal(s3.get("legacy-parent").archived, undefined, "brought back stays back — this runs once per row, not per boot");
  s2.stop(); s3.stop();
  rmSync(root, { recursive: true, force: true });
});

// ── 5. a clock aimed at a session, and the session that has gone ────────────

/**
 * **A schedule may name a session, because the CONVERSATION outlives it.**
 *
 * The phone used to refuse the pair and re-aim the row at its repo, so *reply
 * to that session after the reset* became *open a new, empty session in that
 * repo* — the words landing in a window that had never heard of the work.
 *
 * What makes it sayable is written HERE, on the way in: the conversation the
 * session is driving is snapshotted onto the row while both facts are still
 * known (`snapshotConv`), because at fire time the session is exactly what is
 * gone. Three rules, all of which fail silently if they rot:
 *
 *  1. the snapshot is taken from the live session and never invented;
 *  2. a session that is GONE routes the row to `freshSession` — which reopens
 *     that conversation — instead of typing into a dead id;
 *  3. a session that is still THERE is typed into exactly as before: the
 *     reopen is the fallback, never the plan.
 */
const clockAtSession = (id, at, sessionId = "live-1") => ({
  id,
  cwd: REPO,
  payload: { kind: "prompt", steps: ["yes, carry on"] },
  target: { kind: "session", sessionId },
  trigger: { kind: "at", rule: { kind: "once", at, offsetMin: 0 }, graceMin: 120 },
  pinned: true,
});

test("a session-targeted row snapshots the conversation it is aimed at", async () => {
  const { store, state, root } = makeStore({ convIdFor: (id) => (id === "live-1" ? "conv-1" : null) });
  state.sessions = [{ id: "live-1", cwd: REPO, running: true }];
  await store.reconcile();
  store.post(clockAtSession("c1", Date.now() + HOUR));
  assert.equal(store.get("c1").target.resumeConvId, "conv-1");
  assert.equal(rowsOnDisk(root).find((r) => r.id === "c1").target.resumeConvId, "conv-1",
    "it has to survive a restart — the gap to the instant is days");
  // A session the host cannot name a conversation for keeps the old shape, and
  // therefore the old behaviour: held on `sessionGone`, never reopened.
  store.post(clockAtSession("c2", Date.now() + HOUR, "othercli-1"));
  assert.equal(store.get("c2").target.resumeConvId, undefined);
  store.stop();
  rmSync(root, { recursive: true, force: true });
});

/** Post it while the session is live (that is when the snapshot is taken), let
 *  the session exit, and only THEN let the instant come round — which is the
 *  real sequence and the only one where the verdict is computed with the
 *  session already gone. A row posted already due fires inside `post`'s own
 *  kick, before a test can take the session away. */
async function dueAfterSessionGoes(store, state, id, convId) {
  state.sessions = [{ id: "live-1", cwd: REPO, running: true }];
  store.post(clockAtSession(id, Date.now() + 40));
  if (convId !== undefined) assert.equal(store.get(id).target.resumeConvId, convId);
  state.sessions = [];
  await new Promise((r) => setTimeout(r, 80));
  store.kick();
  await settle();
}

test("when its session has gone, the row opens one on that conversation instead of waiting for ever", async () => {
  const { store, state, root } = makeStore({ convIdFor: () => "conv-1" });
  await store.reconcile();
  await dueAfterSessionGoes(store, state, "c1", "conv-1");
  assert.deepEqual(state.ran, [{ name: "freshSession", id: "c1" }],
    "`freshSession` is the executor that opens a session; `openItemSession` reopens the conversation in it");
  assert.notEqual(store.get("c1").state, "blocked");
  store.stop();
  rmSync(root, { recursive: true, force: true });
});

test("while that session is still there, the words are typed into it", async () => {
  const { store, state, root } = makeStore({ convIdFor: () => "conv-1" });
  state.sessions = [{ id: "live-1", cwd: REPO, running: true }];
  await store.reconcile();
  store.post(clockAtSession("c1", Date.now() - 60_000));
  store.kick();
  await settle();
  assert.deepEqual(state.ran, [{ name: "deliver", id: "c1" }]);
  store.stop();
  rmSync(root, { recursive: true, force: true });
});

test("a row that cannot name a conversation is still held when its session goes", async () => {
  const { store, state, root } = makeStore();
  await store.reconcile();
  await dueAfterSessionGoes(store, state, "c1", undefined);
  assert.deepEqual(state.ran, [], "nothing runs — reopening a conversation nobody wrote down would be a guess");
  assert.equal(store.get("c1").blockReason, "sessionGone");
  store.stop();
  rmSync(root, { recursive: true, force: true });
});

// ── F14, once more: a budget waiver goes to the CHILD, once ─────────────────
//
// A person who lets a recurring rule past the budget means the WORK, and the
// work is the child the rule mints. The rule's own waiver is cleared once the
// fire that minted it returns, so the NEXT occurrence waits for the budget again.

const WAIVER = { until: Date.now() + 3_600_000 };

test("a waived backlog-action rule mints a waived child, and loses its own waiver", async () => {
  const seen = [];
  const { store, root } = makeStore({
    executors: {
      freshSession: async () => ({ ok: true, detail: "x" }),
      sweep: async () => ({ ok: true, detail: "x" }),
      deliver: async () => ({ ok: true, detail: "x" }),
      workItem: async (i) => { seen.push({ id: i.id, pastBudget: i.pastBudget }); return { ok: true, detail: "queued", childId: "kid" }; },
      build: async () => ({ ok: true, detail: "x" }),
      assess: async () => ({ ok: true, detail: "x" }),
    },
  });
  try {
    await store.reconcile();
    store.post({ ...scheduleToIntent(entry({ id: "sch-wv" }), Date.now()), pastBudget: WAIVER });
    assert.deepEqual(store.get("sch-wv").pastBudget, WAIVER);
    await store.runNow("sch-wv");
    await settle();
    assert.deepEqual(seen, [{ id: "sch-wv", pastBudget: WAIVER }], "the child's executor is handed the waiver, window and all");
    assert.equal(store.get("sch-wv").pastBudget, undefined, "the rule's own waiver covered this one occurrence");
    assert.equal(store.get("sch-wv").state, "queued", "a standing rule is back to waiting for its next occurrence");
  } finally {
    store.stop();
    rmSync(root, { recursive: true, force: true });
  }
  // …and the adapter carries it onto the child draft.
  const parent = { ...scheduleToIntent(entry(), Date.now()), pastBudget: WAIVER };
  const child = backlogDraft({ id: "kid4", cwd: REPO, text: "x", order: 0, ...workItemInherits(parent) });
  assert.deepEqual(child.pastBudget, WAIVER, "the same window — the child is let past THAT one and no later");
  const plain = backlogDraft({ id: "kid5", cwd: REPO, text: "x", order: 0, ...workItemInherits(scheduleToIntent(entry(), Date.now())) });
  assert.equal(plain.pastBudget, undefined, "absent = nobody let it past");
});

// ── the before-reset pass, over a real store ────────────────────────────────
//
// Twelve auto rows timed *an hour before the weekly reset* sat held by a weekly
// budget at 97% of 75% and never ran. The store must arm such a row off the
// reset and let rung 2 lift for it — and only for it.

/** The fake usage reading, movable: `at.R` is the weekly reset both the arming
 *  (`usageWindows`) and the tripped ceiling (`budgetOver`) read. */
const beforeReset = (at, over = {}) => makeStore({
  usageWindows: () => ({ weeklyResetAt: at.R, weeklyPct: 97 }),
  budgetBlocked: () => true,
  budgetDetail: () => "paused — 97% of the weekly window used, over the 75% budget",
  budgetOver: () => [{ which: "weekly", pct: 97, max: 75, resetAt: at.R }],
  ...over,
});

test("a before-weekly-reset row saved ahead of its time arms off the reset and is held until then", async () => {
  const at = { R: Date.now() + 2 * HOUR };
  const { store, state, root } = beforeReset(at);
  try {
    await store.reconcile();
    assert.equal(store.post(windowOnce("bp1", { window: "weekly", edge: "before", offsetMin: -60 }, { auto: true })).ok, true);
    assert.equal(store.get("bp1").nextAt, at.R - HOUR, "armed an hour ahead of the reset it is anchored to");
    store.kick();
    await settle();
    assert.equal(state.ran.length, 0, "before its time the ceiling holds it");
    assert.equal(store.get("bp1").blockReason, "budget");
    assert.match(store.get("bp1").blockDetail, /lifted for this row at its time/);
  } finally {
    store.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("…and one saved PAST its instant (the incident: re-timed at 18:50 for an hour before 19:00) arms THIS reset and fires past the ceiling", async () => {
  // It used to arm from `createdAt`, past the instant, so `nextFireAt` said
  // null: *waiting for the first usage reading* with the reading right there,
  // its grace never asked, and next week's reset armed once this one went by.
  const at = { R: Date.now() + 30 * 60_000 };
  const { store, state, root } = beforeReset(at);
  try {
    await store.reconcile();
    assert.equal(store.post(windowOnce("bp1b", { window: "weekly", edge: "before", offsetMin: -60 }, { auto: true })).ok, true);
    assert.equal(store.get("bp1b").nextAt, at.R - HOUR, "armed at the instant half an hour ago, inside its grace");
    store.kick();
    await settle();
    assert.deepEqual(state.ran.map((r) => r.id), ["bp1b"], "the ceiling saves allowance for later in a window that has no later");
  } finally {
    store.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("…the same through `upsert` (schedule.save), for a rule written twenty minutes ago", async () => {
  const at = { R: Date.now() + 30 * 60_000 };
  const { store, state, root } = beforeReset(at);
  try {
    await store.reconcile();
    const e = {
      id: "bp1c", name: "an hour before the weekly reset", enabled: true, graceMin: 120,
      createdAt: Date.now() - 20 * 60_000,
      rule: { kind: "window", window: "weekly", edge: "before", offsetMin: -60, oneShot: true },
      action: { kind: "backlog", repoDir: REPO, text: "spend what is left", autoFire: true },
    };
    assert.ok(store.upsert(scheduleToIntent(e, Date.now())));
    assert.equal(store.get("bp1c").nextAt, at.R - HOUR);
    store.kick();
    await settle();
    assert.deepEqual(state.ran.map((r) => r.id), ["bp1c"]);
  } finally {
    store.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("…but a one-shot whose instant is past its GRACE does not arm this reset", async () => {
  // The grace is what decides, as for a `once`: an instant three hours back
  // against a two-hour grace is behind the floor, so this reset is never
  // offered — the rule waits for the next reading's reset instead.
  const { store, state, root } = beforeReset({ R: Date.now() + 30 * 60_000 });
  try {
    await store.reconcile();
    store.post(windowOnce("bp1d", { window: "weekly", edge: "before", offsetMin: -210 }, { auto: true }));
    assert.equal(store.get("bp1d").nextAt ?? null, null, "3.5 h before a reset 30 min out is 3 h ago — outside a 120-min grace");
    store.kick();
    await settle();
    assert.equal(state.ran.length, 0);
  } finally {
    store.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

// ── a one-shot WEEKLY rule is a one-off too: it arms from the grace floor ────
//
// *Thursday 18:00, once* saved on Thursday at 19:00 with a 120-minute grace
// used to arm next Thursday, like every weekly rule — a run the person's own
// grace said was still wanted, skipped in silence. `!ruleRecurs` is the one
// answer to "one-off", whatever the anchor (decided 2026-09-24).

/** A `weekly` rule, every day (`days: []`), at the host-zone wall clock
 *  `minsAgo` minutes back — so its instant today is that far behind us. */
const weeklyOnce = (id, minsAgo, extra = {}, oneShot = true) => {
  const d = new Date(Date.now() - minsAgo * 60_000);
  return {
    id, cwd: REPO,
    payload: { kind: "prompt", steps: ["the thursday thing"] },
    target: { kind: "repo", fresh: true },
    trigger: {
      kind: "at",
      rule: { kind: "weekly", days: [], hour: d.getHours(), minute: d.getMinutes(), offsetMin: 0, ...(oneShot ? { oneShot: true } : {}) },
      graceMin: 120,
    },
    title: "a one-shot weekly",
    ...extra,
  };
};
/** Within the minute the wall clock was truncated to. */
const nearly = (a, b, what) => assert.ok(Math.abs(a - b) <= 61_000, `${what}: ${new Date(a).toISOString()} vs ${new Date(b).toISOString()}`);

test("a one-shot weekly saved INSIDE its grace runs now, late, like a `once`", async () => {
  const { store, state, root } = makeStore();
  try {
    await store.reconcile();
    const missed = [];
    store.on("missed", (r) => missed.push(r.id));
    store.post(weeklyOnce("wo1", 30));
    store.kick();
    await settle();
    assert.deepEqual(state.ran.map((r) => r.id), ["wo1"], "ran exactly once");
    const row = store.get("wo1");
    assert.equal(row.state, "done");
    assert.equal(row.result.late, true, "and says it ran late");
    assert.equal(row.nextAt, null, "a spent one-off claims no next run");
    nearly(row.lastOccurrence, Date.now() - 30 * 60_000, "the occurrence it spent is today's");
    assert.deepEqual(missed, []);
  } finally {
    store.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("…past its grace it arms the NEXT occurrence, and records no miss", async () => {
  const { store, state, root } = makeStore();
  try {
    await store.reconcile();
    const missed = [];
    store.on("missed", (r) => missed.push(r.id));
    store.post(weeklyOnce("wo2", 180));
    store.kick();
    await settle();
    const row = store.get("wo2");
    assert.ok(row.nextAt > Date.now(), "armed ahead");
    nearly(row.nextAt, Date.now() - 180 * 60_000 + 24 * HOUR, "tomorrow's occurrence");
    assert.notEqual(row.state, "done");
    assert.notEqual(row.state, "failed");
    assert.equal(row.result, undefined, "nothing settled");
    assert.equal(state.ran.length, 0, "nothing ran");
    assert.deepEqual(missed, [], "an occurrence behind the floor was never offered, so it was never missed");
  } finally {
    store.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("…and the same rule WITHOUT oneShot is the control: it arms from now", async () => {
  const { store, state, root } = makeStore();
  try {
    await store.reconcile();
    store.post(weeklyOnce("wo3", 30, {}, false));
    store.kick();
    await settle();
    const row = store.get("wo3");
    nearly(row.nextAt, Date.now() - 30 * 60_000 + 24 * HOUR, "a standing rule's first occurrence is the next one");
    assert.equal(state.ran.length, 0);
  } finally {
    store.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("…the same through `upsert` (schedule.save), for a rule written twenty minutes ago", async () => {
  const { store, state, root } = makeStore();
  try {
    await store.reconcile();
    const d = new Date(Date.now() - 30 * 60_000);
    const e = {
      id: "wo4", name: "thursday, once", enabled: true, graceMin: 120,
      createdAt: Date.now() - 20 * 60_000,
      rule: { kind: "weekly", days: [], hour: d.getHours(), minute: d.getMinutes(), offsetMin: 0, oneShot: true },
      action: { kind: "backlog", repoDir: REPO, text: "the thursday thing", autoFire: true },
    };
    assert.ok(store.upsert(scheduleToIntent(e, Date.now())));
    store.kick();
    await settle();
    assert.deepEqual(state.ran.map((r) => r.id), ["wo4"], "the instant before `createdAt` is still inside the grace");
  } finally {
    store.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("…and toggling `just the next one` ON a queued weekly re-arms it at today's instant; OFF again arms from now", async () => {
  const { store, state, root } = makeStore();
  try {
    await store.reconcile();
    store.post(weeklyOnce("wo5", 30, {}, false));
    assert.ok(store.get("wo5").nextAt > Date.now(), "a standing rule, armed for tomorrow");
    const once = weeklyOnce("x", 30).trigger;
    const r = store.update("wo5", { trigger: once });
    assert.equal(r.ok, true, r.reason);
    // Two passes: the post's own pass may still be in flight when the edit
    // lands, and a kick during a pass is dropped rather than queued.
    await settle();
    store.kick();
    await settle();
    assert.deepEqual(state.ran.map((x) => x.id), ["wo5"], "today's instant, inside the grace, runs");
    assert.equal(store.get("wo5").result.late, true);
  } finally {
    store.stop();
    rmSync(root, { recursive: true, force: true });
  }
  // The reverse: a one-shot held (budget) before it could fire, made standing
  // again, keeps a standing rule's arming — the next occurrence, not the past one.
  const held = makeStore({ budgetBlocked: () => true, budgetDetail: () => "paused — over budget" });
  try {
    await held.store.reconcile();
    held.store.post(weeklyOnce("wo6", 30, { auto: true }));
    held.store.kick();
    await settle();
    assert.equal(held.state.ran.length, 0, "the fixture really is held");
    nearly(held.store.get("wo6").nextAt, Date.now() - 30 * 60_000, "armed at today's instant while one-shot");
    const r = held.store.update("wo6", { trigger: weeklyOnce("x", 30, {}, false).trigger });
    assert.equal(r.ok, true, r.reason);
    nearly(held.store.get("wo6").nextAt, Date.now() - 30 * 60_000 + 24 * HOUR, "standing again ⇒ tomorrow");
  } finally {
    held.store.stop();
    rmSync(held.root, { recursive: true, force: true });
  }
});

test("…and the same row on the AFTER edge stays held by the budget", async () => {
  const { store, state, root } = beforeReset({ R: Date.now() + 30 * 60_000 });
  try {
    await store.reconcile();
    store.post(windowOnce("bp2", { window: "weekly", edge: "after", offsetMin: 0 }, { auto: true }));
    store.kick();
    await settle();
    const row = store.get("bp2");
    assert.equal(state.ran.length, 0);
    assert.equal(row.state, "blocked");
    assert.equal(row.blockReason, "budget");
  } finally {
    store.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("re-saving a child (upsert) keeps the pass it was stamped with", async () => {
  const { store, root } = makeStore();
  try {
    await store.reconcile();
    const pass = { window: "weekly", from: Date.now() - HOUR, until: Date.now() + HOUR };
    const draft = backlogDraft({ id: "kid7", cwd: REPO, text: "x", order: 0, budgetPass: pass });
    store.post(draft);
    assert.deepEqual(store.get("kid7").budgetPass, pass);
    store.upsert({ ...draft, budgetPass: undefined, label: "renamed" });
    assert.deepEqual(store.get("kid7").budgetPass, pass, "a draft that does not mention it is silent, not a request to drop it");
  } finally {
    store.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("workItemInherits stamps the pass from the occurrence being fired — and nothing for a clock rule", () => {
  const occ = Date.now();
  const parent = {
    ...scheduleToIntent(entry({ rule: { kind: "window", window: "weekly", edge: "before", offsetMin: -60 } }), Date.now()),
    lastOccurrence: occ,
  };
  assert.deepEqual(workItemInherits(parent).budgetPass, { window: "weekly", from: occ, until: occ + HOUR });
  const child = backlogDraft({ id: "kid6", cwd: REPO, text: "x", order: 0, ...workItemInherits(parent) });
  assert.deepEqual(child.budgetPass, { window: "weekly", from: occ, until: occ + HOUR });
  const clock = { ...scheduleToIntent(entry(), Date.now()), lastOccurrence: occ };
  assert.equal(workItemInherits(clock).budgetPass, undefined);
});

// ── close-when-done: a per-item answer that every rebuild path keeps ────────

test("closeWhenDone survives the schedule round trip — `false` included, absent stays absent", () => {
  const kept = through(entry({ action: { kind: "backlog", repoDir: REPO, text: "groom", autoFire: true, closeWhenDone: false } }));
  assert.equal(kept.action.closeWhenDone, false, "keep-open is an answer, not 'nobody said'");
  const on = through(entry({ action: { kind: "backlog", repoDir: REPO, text: "groom", autoFire: true, closeWhenDone: true } }));
  assert.equal(on.action.closeWhenDone, true);
  const silent = through(entry());
  assert.equal("closeWhenDone" in silent.action, false, "absent follows the global setting");
});

test("a recurring rule's child inherits closeWhenDone, and the backlog row shows it", () => {
  const draft = backlogDraft({ id: "b1", cwd: REPO, text: "x", order: 1, closeWhenDone: false });
  assert.equal(draft.closeWhenDone, false);
  const { store, root } = makeStore();
  store.post(scheduleToIntent(entry({ action: { kind: "backlog", repoDir: REPO, text: "groom", autoFire: true, closeWhenDone: false } }), Date.now()));
  assert.equal(workItemInherits(store.get("sch-rt")).closeWhenDone, false);
  store.post(draft);
  assert.equal(intentToBacklogItem(store.get("b1")).closeWhenDone, false);
  store.stop();
  rmSync(root, { recursive: true, force: true });
});

test("upsert carries closeWhenDone when the draft is silent; edit sets it on a RUNNING row and null clears it", async () => {
  const { store, root } = makeStore();
  const e = entry({ action: { kind: "backlog", repoDir: REPO, text: "groom", autoFire: true, closeWhenDone: true } });
  store.post(scheduleToIntent(e, Date.now()));
  // An older bundle re-saves the rule without the field: it must not vanish.
  store.upsert(scheduleToIntent(entry({ name: "renamed" }), Date.now()));
  assert.equal(store.get("sch-rt").closeWhenDone, true);
  store.get("sch-rt").state = "running";
  assert.equal(store.edit("sch-rt", { closeWhenDone: false }).ok, true);
  assert.equal(store.get("sch-rt").closeWhenDone, false);
  assert.equal(store.get("sch-rt").state, "running", "an edit about the session never re-queues the work");
  store.edit("sch-rt", { closeWhenDone: null });
  assert.equal(store.get("sch-rt").closeWhenDone, undefined, "null = back to the global setting");
  store.stop();
  rmSync(root, { recursive: true, force: true });
});
