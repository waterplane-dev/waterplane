/**
 * **What the backlog's edit form is entitled to change — and the silence that
 * swallowed all of it.**
 *
 * `BacklogManager.update()` builds an `IntentPatch` and hands it to
 * `IntentManager.update()`, which SPREADS it over the row. A key carrying
 * `undefined` is not "leave this alone" in a spread — it deletes the field. The
 * builder emitted four such keys unconditionally (`payload`, `label`, `cwd`,
 * `target`), so a text-only edit arrived with the row's checkout removed,
 * `cleanIntentRow` found nothing runnable, and the edit was refused. Every
 * combination the form could make was dropped except the one that changed the
 * words AND the repo — and nothing said so: the verdict was discarded at the
 * call site and the phone closed its editor over words that never landed.
 *
 * It survived review because `IntentPatch`'s contract — *absent leaves the
 * row's own value alone* — is true over the WIRE, where `JSON.stringify` drops
 * an undefined-valued key before anyone spreads it. `intent.update` (*drop the
 * clock*, the schedule sheet) therefore never carried one. The in-process call
 * is the seam, which is why both ends are pinned here: the builder emits no
 * such key, and the store strips one if a future caller does.
 *
 * Harness: `requeue.test.mjs`'s — fake deps, a temp root, the store as the
 * thing under test.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { IntentManager } = await import("../dist/intents/manager.js");
const { BacklogManager } = await import("../dist/backlog.js");

const REPO = "/tmp/waterplane-bledit-repo";
const OTHER = "/tmp/waterplane-bledit-other";

function makeStore() {
  const root = mkdtempSync(join(tmpdir(), "waterplane-bledit-"));
  const exec = () => async () => ({ ok: true, detail: "delivered" });
  const store = new IntentManager({
    root,
    sessions: () => [],
    sessionAlive: () => false,
    repoSession: () => null,
    repoAnySession: () => false,
    // No free slot: every row here stays where the verb left it rather than
    // being fired by the tick `update()` kicks.
    autoSlotsFree: () => 0,
    autoSlotsDetail: () => "waiting for a free slot",
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
      freshSession: exec(), sweep: exec(), deliver: exec(),
      workItem: exec(), build: exec(), assess: exec(),
    },
    onChange: () => {},
  });
  const backlog = new BacklogManager(root, {}, store, {});
  return { store, backlog, root };
}

/** The row this was found on: a schedule's child, waiting on a weekly window,
 *  aimed at a session of its own. Nothing about the shape matters except that
 *  it is what a person had in front of them when Save did nothing. */
const post = (store, extra = {}) => store.post({
  id: "e1",
  cwd: REPO,
  payload: { kind: "prompt", steps: ["the words that were there"] },
  target: { kind: "repo", fresh: true },
  trigger: { kind: "idle" },
  serial: true,
  holdForHost: true,
  auto: true,
  title: "a work item",
  ...extra,
});

test("a text-only edit lands — the regression", () => {
  const { store, backlog, root } = makeStore();
  post(store);
  const res = backlog.update("e1", { text: "the words a person typed" });
  assert.deepEqual(res, {}, "no refusal — this is the ordinary edit");
  const row = store.get("e1");
  assert.equal(row.payload.steps[0], "the words a person typed");
  assert.equal(row.cwd, REPO, "and the checkout the patch never mentioned is still on the row");
  rmSync(root, { recursive: true, force: true });
});

test("…and a repo-only edit lands without taking the words with it", () => {
  const { store, backlog, root } = makeStore();
  post(store);
  assert.deepEqual(backlog.update("e1", { repoDir: OTHER }), {});
  const row = store.get("e1");
  assert.equal(row.cwd, OTHER);
  assert.equal(row.payload.steps[0], "the words that were there", "nobody asked about the words");
  rmSync(root, { recursive: true, force: true });
});

test("…and taking the aim off a row aimed at a session leaves everything else alone", () => {
  const { store, backlog, root } = makeStore();
  post(store, { target: { kind: "session", sessionId: "gone" } });
  assert.deepEqual(backlog.update("e1", { targetSessionId: "" }), {});
  const row = store.get("e1");
  assert.equal(row.target.kind, "repo", "back to a session of its own");
  assert.equal(row.cwd, REPO);
  assert.equal(row.payload.steps[0], "the words that were there");
  assert.equal(row.serial, true, "a flag nobody mentioned is not a flag anybody cleared");
  assert.equal(row.holdForHost, true);
  rmSync(root, { recursive: true, force: true });
});

test("an undefined-valued key IS a delete — which is why the builder must not emit one by accident", () => {
  // The other half of the rule, pinned from the store's side so the fix cannot
  // be "un-fixed" by filtering undefined out down there: two taps mean exactly
  // this and have no other way to say it (`queuehere.test.mjs` holds the
  // un-queue). The wire cannot carry such a key at all — `JSON.stringify` drops
  // it — so the asymmetry belongs to the in-process caller, and the answer is a
  // conditional spread at the call site, never a filter here.
  const { store, root } = makeStore();
  post(store);
  assert.equal(store.update("e1", { cwd: undefined }).ok, false, "the row lost its checkout");
  assert.equal(store.get("e1").cwd, REPO, "…and the refused edit changed nothing");
  rmSync(root, { recursive: true, force: true });
});

test("a refused edit comes back as words instead of being dropped", () => {
  const { store, backlog, root } = makeStore();
  post(store);
  store.settle(store.get("e1"), "done", { at: Date.now(), ok: true, detail: "ran" });
  const res = backlog.update("e1", { text: "too late" });
  assert.match(res.refused ?? "", /already done/, "the editor must not close over words that never landed");
  rmSync(root, { recursive: true, force: true });
});

// ── R-automation-044: the session budget of a row that is still waiting ────────

test("a queued row's budget can be set, changed and cleared — and nothing else moves", () => {
  const { store, backlog, root } = makeStore();
  post(store);
  assert.deepEqual(backlog.update("e1", { budget: { unit: "usd", max: 5, interrupt: true } }), {});
  assert.deepEqual(store.get("e1").budget, { unit: "usd", max: 5, interrupt: true });
  assert.equal(store.get("e1").state, "queued", "a budget is not an edit to the work: it never moves the row");
  assert.equal(store.get("e1").payload.steps[0], "the words that were there");
  assert.deepEqual(backlog.update("e1", { budget: { unit: "weeklyPct", max: 10, interrupt: false } }), {});
  assert.deepEqual(store.get("e1").budget, { unit: "weeklyPct", max: 10, interrupt: false });
  assert.deepEqual(backlog.update("e1", { budget: null }), {});
  assert.equal(store.get("e1").budget, undefined, "null clears it");
  rmSync(root, { recursive: true, force: true });
});

test("a patch that says nothing about the budget leaves it alone", () => {
  const { store, backlog, root } = makeStore();
  post(store, { budget: { unit: "usd", max: 2, interrupt: true } });
  backlog.update("e1", { text: "new words" });
  assert.deepEqual(store.get("e1").budget, { unit: "usd", max: 2, interrupt: true });
  rmSync(root, { recursive: true, force: true });
});

test("a row that has started is refused in words and keeps what it had", () => {
  const { store, backlog, root } = makeStore();
  post(store, { budget: { unit: "usd", max: 2, interrupt: true } });
  store.settle(store.get("e1"), "done", { at: Date.now(), ok: true, detail: "ran" });
  const res = backlog.update("e1", { budget: null });
  assert.match(res.refused ?? "", /already open/);
  assert.deepEqual(store.get("e1").budget, { unit: "usd", max: 2, interrupt: true });
  rmSync(root, { recursive: true, force: true });
});

test("the route's validator refuses garbage before the store sees it", async () => {
  const { cleanSessionBudget } = await import("@waterplane/shared");
  assert.equal(cleanSessionBudget({ unit: "usd", max: -1 }), null);
  assert.equal(cleanSessionBudget({ unit: "bogus", max: 3 }), null);
  assert.equal(cleanSessionBudget({ unit: "sessionPct", max: 400 }), null);
  assert.deepEqual(cleanSessionBudget({ unit: "usd", max: 3 }), { unit: "usd", max: 3, interrupt: true });
});
