/**
 * **A resend that does not change the rule does not change the clock.**
 *
 * The Send sheet's edit of a waiting row (`useSend.tsx`, the `intent.update`
 * branch) always sends the FULL trigger, even when only the words changed.
 * `update()` read any one-off trigger in a patch as "the person named a new
 * instant": it dropped `lastOccurrence` and `clearedOccurrence` and armed from
 * scratch. On a `once` that rung 3 had already released and a lower rung was
 * holding past its grace, the scratch arm is `null` — and the ladder then
 * failed the row as a one-off whose instant had passed, for an edit to its
 * words. (Review D3 (a), pre-existing.)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { IntentManager } = await import("../dist/intents/manager.js");

const REPO = "/tmp/waterplane-resend-repo";
const HOUR = 3_600_000;
const settle = () => new Promise((r) => setTimeout(r, 30));

function makeStore() {
  const root = mkdtempSync(join(tmpdir(), "waterplane-resend-"));
  const ran = [];
  const exec = async (i) => { ran.push(i.id); return { ok: true, detail: "" }; };
  const store = new IntentManager({
    root, sessions: () => [], sessionAlive: () => false, repoSession: () => null, repoAnySession: () => false,
    autoSlotsFree: () => 3, autoSlotsDetail: () => undefined, revivedSessionFor: () => null, diedAtLimit: () => false,
    stopCount: () => 0, isHooked: () => false, sessionIdleMs: () => 99_000, sessionHasPrompt: () => false,
    idleWindowMs: () => 1000, groupConcurrency: () => 6, knownDirs: async () => new Set([REPO]),
    budgetBlocked: () => false, autoFire: () => true, logVerdict: () => "unknown",
    executors: { freshSession: exec, sweep: exec, deliver: exec, workItem: exec, build: exec, scheduledBuild: exec, assess: exec },
    onChange: () => {},
  });
  return { store, ran, done: () => { store.stop(); rmSync(root, { recursive: true, force: true }); } };
}

const onceTrigger = (at, graceMin = 30) => ({ kind: "at", rule: { kind: "once", at, offsetMin: 0 }, graceMin });

/** A `once` released by rung 3 and held by a lower rung until past its grace. */
function heldPastGrace(store, id, due) {
  assert.equal(store.post({ id, cwd: REPO, payload: { kind: "prompt", steps: ["old words"] }, target: { kind: "repo", fresh: true }, trigger: onceTrigger(due), auto: true }).ok, true);
  const row = store.get(id);
  row.nextAt = due;
  row.clearedOccurrence = due;
  return row;
}

test("a words-only resend of a held `once` keeps its clock state, and the row still runs", async () => {
  const { store, ran, done } = makeStore();
  try {
    const due = Date.now() - 3 * HOUR;
    heldPastGrace(store, "o1", due);
    const r = store.update("o1", { payload: { kind: "prompt", steps: ["new words"] }, trigger: onceTrigger(due) });
    assert.equal(r.ok, true);
    const row = store.get("o1");
    assert.deepEqual(row.payload.steps, ["new words"]);
    assert.equal(row.clearedOccurrence, due, "the release rung 3 gave is not taken back by an edit to the words");
    assert.equal(row.nextAt, due, "…nor the armed instant");
    // The tick starts with reconcile (the store's boot), so the ladder judges
    // the row only now — after the edit.
    await store.reconcile();
    store.kick();
    await settle();
    assert.deepEqual(ran, ["o1"], "it runs");
    assert.equal(store.get("o1").state, "done");
  } finally { done(); }
});

test("a resend that DOES move the instant re-arms from scratch, as before", () => {
  const { store, done } = makeStore();
  try {
    const due = Date.now() - 3 * HOUR;
    heldPastGrace(store, "o2", due);
    const later = Date.now() + HOUR;
    assert.equal(store.update("o2", { trigger: onceTrigger(later) }).ok, true);
    const row = store.get("o2");
    assert.equal(row.clearedOccurrence, undefined, "a new instant is not covered by the old release");
    assert.equal(row.nextAt, later);
  } finally { done(); }
});

test("a resend that changes only the grace is a new clock too", () => {
  const { store, done } = makeStore();
  try {
    const due = Date.now() - 3 * HOUR;
    heldPastGrace(store, "o3", due);
    assert.equal(store.update("o3", { trigger: onceTrigger(due, 0) }).ok, true);
    assert.equal(store.get("o3").clearedOccurrence, undefined);
  } finally { done(); }
});

const weeklyTrigger = (over = {}) => ({
  kind: "at", graceMin: 30,
  rule: { kind: "weekly", days: [1, 3], hour: 9, minute: 0, tz: "Europe/Berlin", offsetMin: 0, ...over },
});

/** A queued weekly row whose armed instant is a sentinel only a KEPT clock would still hold. */
function weeklyRow(store, id) {
  assert.equal(store.post({ id, cwd: REPO, payload: { kind: "prompt", steps: ["w"] }, target: { kind: "repo", fresh: true }, trigger: weeklyTrigger(), auto: true }).ok, true);
  const row = store.get(id);
  assert.equal(typeof row.nextAt, "number", "a weekly row is armed at post");
  row.nextAt = Date.now() + 40 * HOUR;
  return row.nextAt;
}

test("a weekly resend with the same rule keeps its armed instant", () => {
  const { store, done } = makeStore();
  try {
    const sentinel = weeklyRow(store, "w0");
    assert.equal(store.update("w0", { trigger: weeklyTrigger() }).ok, true);
    assert.equal(store.get("w0").nextAt, sentinel);
  } finally { done(); }
});

test("a weekly resend that changes only the zone re-arms", () => {
  const { store, done } = makeStore();
  try {
    const sentinel = weeklyRow(store, "w1");
    assert.equal(store.update("w1", { trigger: weeklyTrigger({ tz: "Asia/Tokyo" }) }).ok, true);
    assert.notEqual(store.get("w1").nextAt, sentinel, "the zone is part of the clock");
    assert.equal(typeof store.get("w1").nextAt, "number");
  } finally { done(); }
});

test("a weekly resend that changes only the weekdays re-arms", () => {
  const { store, done } = makeStore();
  try {
    const sentinel = weeklyRow(store, "w2");
    assert.equal(store.update("w2", { trigger: weeklyTrigger({ days: [5] }) }).ok, true);
    assert.notEqual(store.get("w2").nextAt, sentinel, "the weekdays are part of the clock");
    assert.equal(typeof store.get("w2").nextAt, "number");
  } finally { done(); }
});

test("a failed row is revived by a words-only resend of its own trigger", () => {
  const { store, done } = makeStore();
  try {
    const due = Date.now() - 3 * HOUR;
    const row = heldPastGrace(store, "f1", due);
    row.state = "failed";
    // the phone always resends the trigger; here it is the SAME one, so only the words changed
    const r = store.update("f1", { payload: { kind: "prompt", steps: ["again"] }, trigger: onceTrigger(due) });
    assert.equal(r.ok, true, r.reason);
    const back = store.get("f1");
    assert.notEqual(back.state, "failed", "revived, not kept as a gravestone");
    assert.deepEqual(back.payload.steps, ["again"]);
    assert.notEqual(back.nextAt, due, "a revival is re-clocked (armed from scratch), not kept as the sameClock path would");
  } finally { done(); }
});
