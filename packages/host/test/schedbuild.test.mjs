/**
 * A schedule that runs a BUILD (`ScheduleAction.build`).
 *
 * The rule's own row holds which build and which values, never a command; each
 * occurrence posts ONE ordinary build run through `BuildManager.run()` (the
 * same validation, containment and snapshot a tap gets), stamped
 * `scheduleItemOrigin(rule id)` so the run links back to its rule, and the
 * rule's `result.childId` names that run. A build entry deleted since the save,
 * or a parameter without a value, FAILS the occurrence in words — never a
 * guess. The real store and the real BuildManager over a temp repo; only the
 * build's own spawn is a stub.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { IntentManager } = await import("../dist/intents/manager.js");
const { BuildManager } = await import("../dist/builds.js");
const { scheduleToIntent, intentToSchedule } = await import("../dist/intents/adapters.js");
const { scheduleIdFromOrigin, isBuildRow, isScheduleRow, intentKind, postsScheduledBuild } = await import("@waterplane/shared");

const settle = () => new Promise((r) => setTimeout(r, 30));

function makeWorld(builds) {
  const root = mkdtempSync(join(tmpdir(), "waterplane-schedbuild-"));
  const repo = join(root, "app");
  mkdirSync(join(repo, ".waterplane-shared"), { recursive: true });
  const writeBuilds = (list) => writeFileSync(join(repo, ".waterplane-shared", "builds.json"), JSON.stringify(list));
  writeBuilds(builds);
  const spawned = [];
  let mgr;
  const store = new IntentManager({
    root,
    sessions: () => [],
    sessionAlive: () => false,
    repoSession: () => null,
    repoAnySession: () => false,
    autoSlotsFree: () => 3,
    autoSlotsDetail: () => undefined,
    revivedSessionFor: () => null,
    diedAtLimit: () => false,
    stopCount: () => 0,
    isHooked: () => false,
    sessionIdleMs: () => 99_000,
    sessionHasPrompt: () => false,
    idleWindowMs: () => 1000,
    groupConcurrency: () => 6,
    knownDirs: async () => new Set([repo]),
    budgetBlocked: () => false,
    autoFire: () => true,
    logVerdict: () => "unknown",
    executors: {
      freshSession: async () => ({ ok: true, detail: "" }),
      sweep: async () => ({ ok: true, detail: "" }),
      deliver: async () => ({ ok: true, detail: "" }),
      workItem: async () => ({ ok: true, detail: "" }),
      // The run itself: recorded, never spawned — the subject is the posting.
      build: async (i) => { spawned.push(i); return { ok: true, detail: "build succeeded" }; },
      scheduledBuild: (i) => mgr.fireScheduled(i),
      assess: async () => ({ ok: true, detail: "" }),
    },
    onChange: () => {},
  });
  mgr = new BuildManager(store, root);
  const done = () => { store.stop(); rmSync(root, { recursive: true, force: true }); };
  return { store, mgr, repo, root, spawned, writeBuilds, done };
}

const entry = (repo, extra = {}) => ({
  id: "nightly",
  name: "",
  enabled: true,
  rule: { kind: "weekly", days: [], hour: 4, minute: 0, tz: "UTC", offsetMin: 0 },
  action: { kind: "build", repoDir: repo, buildId: "apk", params: { flavour: "debug" } },
  graceMin: 120,
  createdAt: 1,
  nextAt: null,
  ...extra,
});

/** Make the rule due now and let one pass run. */
async function fireOnce(store, id) {
  await settle();
  store.get(id).nextAt = Date.now() - 1000;
  store.kick();
  await settle();
}

const APK = { id: "apk", name: "Release APK", cmd: "echo {{flavour}}", params: [{ id: "flavour", kind: "text" }] };

test("a build action round-trips through the store — renaming keeps the build and its values", () => {
  const draft = scheduleToIntent(entry("/r/app"), 0);
  assert.equal(draft.payload.kind, "build");
  assert.equal(draft.payload.cmd, undefined, "the rule holds no command — it is read at each occurrence");
  assert.equal(draft.target.kind, "shell");
  assert.equal(draft.title, "run build apk", "no typed name ⇒ the build is what the rule is called");
  const row = { ...draft, state: "queued", nextAt: 5, trigger: draft.trigger };
  assert.equal(postsScheduledBuild(row), true);
  assert.equal(isScheduleRow(row), true);
  assert.equal(isBuildRow(row), false, "the RULE is not a run, so the build history never lists it");
  assert.equal(intentKind(row), "schedule");
  const back = intentToSchedule(row);
  assert.deepEqual(back.action, { kind: "build", repoDir: "/r/app", buildId: "apk", params: { flavour: "debug" } });
  const renamed = scheduleToIntent({ ...back, name: "nightly APK" }, 0);
  assert.equal(renamed.title, "nightly APK");
  assert.deepEqual(renamed.payload, draft.payload);
});

test("each occurrence posts exactly ONE ordinary run, stamped with the rule, and the rule names it", async () => {
  const w = makeWorld([APK]);
  try {
    await w.store.reconcile();
    w.store.post(scheduleToIntent(entry(w.repo), Date.now()));
    await fireOnce(w.store, "nightly");
    const runs = w.store.list().filter((i) => isBuildRow(i));
    assert.equal(runs.length, 1, "one occurrence, one run");
    const run = runs[0];
    assert.match(run.id, /^br_/);
    assert.equal(scheduleIdFromOrigin(run.origin), "nightly", "the run links back to the rule that posted it");
    assert.equal(run.payload.cmd, "echo debug", "run()'s own snapshot: the values substituted at fire time");
    assert.equal(run.title, "Release APK · flavour=debug");
    const rule = w.store.get("nightly");
    assert.equal(rule.result.ok, true);
    assert.equal(rule.result.childId, run.id);
    assert.equal(rule.state, "queued", "a standing rule re-arms");
    assert.ok(rule.nextAt > Date.now());
    assert.equal(w.mgr.runsFor(w.repo).length, 1, "the build history holds the run and not the rule");
    // A second pass with nothing newly due posts nothing — and the run, posted
    // mid-pass, starts on it like any tapped run.
    w.store.kick();
    await settle();
    assert.deepEqual(w.spawned.map((i) => i.id), [run.id], "the RUN executed, never the rule's own row");
    assert.equal(w.store.list().filter((i) => isBuildRow(i)).length, 1, "at most once per occurrence");
    // The next occurrence is a second run, a second child.
    await fireOnce(w.store, "nightly");
    const after = w.store.list().filter((i) => isBuildRow(i));
    assert.equal(after.length, 2);
    assert.equal(w.store.get("nightly").result.childId, after.find((r) => r.id !== run.id).id);
  } finally { w.done(); }
});

test("a deleted build entry fails the occurrence in words and posts nothing", async () => {
  const w = makeWorld([APK]);
  try {
    await w.store.reconcile();
    w.store.post(scheduleToIntent(entry(w.repo), Date.now()));
    w.writeBuilds([]);
    await fireOnce(w.store, "nightly");
    const rule = w.store.get("nightly");
    assert.equal(rule.result.ok, false);
    assert.equal(rule.result.detail, "build apk no longer exists in app");
    assert.equal(w.store.list().filter((i) => isBuildRow(i)).length, 0);
  } finally { w.done(); }
});

test("a parameter that lost its value fails the occurrence by name, never a guess", async () => {
  const w = makeWorld([APK]);
  try {
    await w.store.reconcile();
    w.store.post(scheduleToIntent(entry(w.repo, { action: { kind: "build", repoDir: w.repo, buildId: "apk" } }), Date.now()));
    await fireOnce(w.store, "nightly");
    const rule = w.store.get("nightly");
    assert.equal(rule.result.ok, false);
    assert.match(rule.result.detail, /Release APK in app was not started: needs a value for “flavour”/);
    assert.equal(w.store.list().filter((i) => isBuildRow(i)).length, 0);
  } finally { w.done(); }
});

test("checkScheduled: the save-time refusals, in words", () => {
  const w = makeWorld([APK, { id: "plain", name: "Plain", cmd: "true" }, { id: "def", name: "Def", cmd: "echo {{x}}", params: [{ id: "x", kind: "text", default: "a" }] }]);
  try {
    assert.deepEqual(w.mgr.checkScheduled(w.repo, "gone"), { error: "build gone does not exist in app" });
    assert.match(w.mgr.checkScheduled(w.repo, "apk").error, /needs a value for “flavour”/);
    assert.match(w.mgr.checkScheduled(w.repo, "apk", { flavour: "a;rm" }).error, /^build Release APK: /);
    assert.deepEqual(w.mgr.checkScheduled(w.repo, "apk", { flavour: "debug" }), { name: "Release APK" });
    assert.deepEqual(w.mgr.checkScheduled(w.repo, "plain"), { name: "Plain" });
    assert.deepEqual(w.mgr.checkScheduled(w.repo, "def"), { name: "Def" }, "a stored default is a value");
  } finally { w.done(); }
});
