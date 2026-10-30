/**
 * **An edit is a PATCH over the stored rule, never a replace from the form.**
 *
 * `schedule.save` → `scheduleToIntent` → `upsert()` is the one path every
 * schedule kind is edited through (a build rule from the Build sheet, a backlog
 * rule and a sweep from the Send sheet). Both sheets always send
 * `enabled: true`, and neither ever sends `keepAfterRun` — so a draft silent
 * about a field must leave the stored one alone: a PAUSED rule stays paused (its
 * `nextAt: null`), and a kept-after-run one-off stays kept. Un-pausing is the
 * pause switch's (`schedule.setEnabled`), never a side effect of re-timing:
 * "nothing applies itself" (CLAUDE.md). bughunt 2026-10-29 BLD-1.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { IntentManager } = await import("../dist/intents/manager.js");
const { scheduleToIntent, intentToSchedule, schedulesToDrafts } = await import("../dist/intents/adapters.js");

const REPO = "/tmp/waterplane-schededit-repo";
const HOUR = 3_600_000;

function makeStore(extra = {}) {
  const root = extra.root ?? mkdtempSync(join(tmpdir(), "waterplane-schededit-"));
  const ran = [];
  const exec = (name) => async (i) => { ran.push({ name, id: i.id }); return { ok: true, detail: "" }; };
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
    knownDirs: async () => new Set([REPO]),
    budgetBlocked: () => false,
    autoFire: () => true,
    logVerdict: () => "unknown",
    executors: {
      freshSession: exec("freshSession"), sweep: exec("sweep"), deliver: exec("deliver"),
      workItem: exec("workItem"), build: exec("build"), scheduledBuild: exec("scheduledBuild"), assess: exec("assess"),
    },
    onChange: () => {},
    ...extra,
  });
  return { store, ran, done: () => { store.stop(); if (!extra.root) rmSync(root, { recursive: true, force: true }); } };
}

const WEEKLY = { kind: "weekly", days: [], hour: 4, minute: 0, tz: "UTC", offsetMin: 0 };
const ACTIONS = {
  build: { kind: "build", repoDir: REPO, buildId: "apk" },
  backlog: { kind: "backlog", repoDir: REPO, text: "groom the notes", autoFire: true },
  fanout: { kind: "fanout", dirs: [REPO], text: "sweep the repos" },
};
/** What a sheet sends: `enabled: true` always, `keepAfterRun` never. */
const sent = (kind, over = {}) => ({
  id: `r-${kind}`, name: `the ${kind} rule`, enabled: true, rule: WEEKLY, action: ACTIONS[kind],
  createdAt: Date.now() - HOUR, nextAt: Date.now() + HOUR, graceMin: 120, ...over,
});
const save = (store, e) => store.upsert(scheduleToIntent(e, Date.now()));

for (const kind of Object.keys(ACTIONS)) {
  test(`${kind}: editing a PAUSED rule saves it still paused`, () => {
    const { store, done } = makeStore();
    try {
      assert.ok(save(store, sent(kind)));
      assert.equal(store.setArmed(`r-${kind}`, false), true);
      assert.equal(store.get(`r-${kind}`).nextAt, null);
      // The edit: a new hour and a new name, `enabled: true` as every sheet sends.
      const saved = save(store, sent(kind, { name: "renamed", rule: { ...WEEKLY, hour: 6 } }));
      assert.ok(saved);
      assert.equal(saved.nextAt, null, "a re-time is not a resume — the pause switch is the only way back");
      assert.equal(saved.title, "renamed", "…while the fields the form DOES own are saved");
      assert.equal(saved.trigger.rule.hour, 6);
      assert.equal(intentToSchedule(saved)?.enabled ?? false, false);
    } finally { done(); }
  });

  test(`${kind}: editing an ARMED rule keeps it armed, from the new clock`, () => {
    const { store, done } = makeStore();
    try {
      assert.ok(save(store, sent(kind)));
      const saved = save(store, sent(kind, { rule: { ...WEEKLY, hour: 6 } }));
      assert.ok(saved.nextAt > Date.now());
      assert.equal(new Date(saved.nextAt).getUTCHours(), 6);
    } finally { done(); }
  });

  test(`${kind}: keepAfterRun is carried when the draft is silent, cleared only by an explicit false`, () => {
    const { store, done } = makeStore();
    try {
      assert.ok(save(store, sent(kind, { keepAfterRun: true })));
      assert.equal(store.get(`r-${kind}`).trigger.keepAfterRun, true);
      save(store, sent(kind, { name: "renamed" }));
      assert.equal(store.get(`r-${kind}`).trigger.keepAfterRun, true, "silent ⇒ unchanged, never the default");
      save(store, sent(kind, { keepAfterRun: false }));
      assert.equal(store.get(`r-${kind}`).trigger.keepAfterRun, undefined, "a draft that SAYS false means it");
    } finally { done(); }
  });
}

test("a save's `enabled` is not a switch — un-pausing is the pause switch's alone", () => {
  // `enabled` is derived from `nextAt` on the way out, and every sheet sends
  // `true` back, so reading it as "arm" would re-arm every paused rule on any
  // edit. The pause switch (`setArmed`) is the one verb that moves it.
  const { store, done } = makeStore();
  try {
    assert.ok(save(store, sent("build")));
    store.setArmed("r-build", false);
    assert.equal(save(store, sent("build", { enabled: true })).nextAt, null);
    assert.equal(store.setArmed("r-build", true), true);
    assert.ok(store.get("r-build").nextAt > Date.now());
    assert.ok(save(store, sent("build", { enabled: false })).nextAt > Date.now(), "nor does a stale `false` pause an armed rule");
  } finally { done(); }
});

test("a SPENT one-off re-timed is armed again — spent is not paused", () => {
  const { store, done } = makeStore();
  try {
    const once = sent("backlog", { id: "spent", rule: { kind: "once", at: Date.now() - 3 * HOUR, offsetMin: 0 } });
    assert.ok(save(store, once));
    const row = store.get("spent");
    row.lastOccurrence = Date.now() - 3 * HOUR;
    row.nextAt = null;
    const later = Date.now() + 2 * HOUR;
    const saved = save(store, { ...once, rule: { kind: "once", at: later, offsetMin: 0 } });
    assert.equal(saved.nextAt, later, "the person gave it a new instant — that is the edit");
  } finally { done(); }
});

// ── The pause has ONE owner: `trigger.paused`, written by the pause switch ──
//
// `nextAt: null` used to be both "paused" (a recurring rule switched off) and
// "spent" (a one-off that has run), and `upsert()` inferred the first from the
// stored rule while the verdict read the second off the DRAFT's rule. A paused
// weekly rule re-timed as "once, Friday 18:00" was saved with `nextAt: null`
// and failed on the next tick as "that instant has passed" though it was days
// ahead (bughunt 2026-10-29 review D F1).
const { intentVerdict, BRAND } = await import("@waterplane/shared");
const FACTS = { autoFire: true, sessions: [], busyCwds: new Set(), knownDirs: new Set([REPO]) };

for (const kind of Object.keys(ACTIONS)) {
  test(`${kind}: the pause switch writes trigger.paused, and resuming clears it`, () => {
    const { store, done } = makeStore();
    try {
      assert.ok(save(store, sent(kind)));
      store.setArmed(`r-${kind}`, false);
      assert.equal(store.get(`r-${kind}`).trigger.paused, true);
      assert.equal(store.get(`r-${kind}`).nextAt, null, "a paused rule is also not armed");
      save(store, sent(kind, { name: "renamed" }));
      assert.equal(store.get(`r-${kind}`).trigger.paused, true, "a re-save is silent about the pause ⇒ carried");
      store.setArmed(`r-${kind}`, true);
      assert.equal(store.get(`r-${kind}`).trigger.paused, undefined);
      assert.ok(store.get(`r-${kind}`).nextAt > Date.now());
    } finally { done(); }
  });

  test(`${kind}: a PAUSED weekly rule re-timed as a future one-off is armed at that instant, never failed as spent`, () => {
    const { store, done } = makeStore();
    try {
      assert.ok(save(store, sent(kind)));
      store.setArmed(`r-${kind}`, false);
      const later = Date.now() + 3 * 24 * HOUR;
      const saved = save(store, sent(kind, { rule: { kind: "once", at: later, offsetMin: 0 } }));
      assert.equal(saved.nextAt, later, "picking one instant is choosing when it runs");
      assert.equal(saved.trigger.paused, undefined, "a one-off has no pause to carry from a standing rule");
      const v = intentVerdict(saved, FACTS, Date.now());
      assert.notEqual(v.kind, "fail", `verdict: ${JSON.stringify(v)}`);
    } finally { done(); }
  });
}

// ── The older host's pause is a MIGRATION, read off DISK only ──────────────
//
// An older host's pause switch wrote only `nextAt: null`; for a recurring
// weekly rule nothing else on that host wrote it, so the store's disk load
// stamps `trigger.paused`. That inference is about the FILE: run on a live
// edit, it read a failed one-off's settled `nextAt: null`, riding under a new
// weekly trigger, as a pause (bughunt 2026-10-29 review D2 F1).

/** Write `intents.json` the way an older host left it, then boot a store on it. */
function bootOnDisk(rows) {
  const root = mkdtempSync(join(tmpdir(), "waterplane-schededit-disk-"));
  mkdirSync(join(root, BRAND.stateDirName), { recursive: true });
  writeFileSync(join(root, BRAND.stateDirName, "intents.json"), JSON.stringify({ schema: 3, intents: rows }));
  const s = makeStore({ root });
  return { ...s, root, done: () => { s.done(); rmSync(root, { recursive: true, force: true }); } };
}
const diskRow = (over = {}) => ({
  id: "old-rule", cwd: REPO, origin: "schedule:backlog", title: "groom", auto: true,
  payload: { kind: "prompt", steps: ["groom the notes"] }, target: { kind: "repo", fresh: true },
  trigger: { kind: "at", rule: WEEKLY, graceMin: 120 },
  state: "queued", createdAt: Date.now() - 48 * HOUR, nextAt: null, ...over,
});

test("an older host's pause on disk (recurring weekly, nextAt null, no flag) LOADS as paused, and resumes", async () => {
  const { store, done } = bootOnDisk([diskRow()]);
  try {
    const row = store.get("old-rule");
    assert.ok(row, "the row loaded");
    assert.equal(row.trigger.paused, true, "the load stamps the pause switch's flag");
    assert.equal(row.nextAt, null);
    await store.pass();
    assert.equal(store.get("old-rule").nextAt, null, "the tick leaves a paused rule alone");
    assert.match(intentVerdict(store.get("old-rule"), FACTS, Date.now()).detail ?? "", /switched off/);
    // …an edit keeps it paused (the flag is carried) …
    const saved = save(store, { ...sent("backlog"), id: "old-rule", name: "renamed" });
    assert.equal(saved.trigger.paused, true);
    assert.equal(saved.nextAt, null);
    // …and the pause switch is the way back.
    assert.equal(store.setArmed("old-rule", true), true);
    assert.ok(store.get("old-rule").nextAt > Date.now());
  } finally { done(); }
});

test("a legacy schedules.json `enabled: false` standing rule migrates PAUSED; `enabled: true` armed", () => {
  const root = mkdtempSync(join(tmpdir(), "waterplane-schededit-legacy-"));
  mkdirSync(join(root, BRAND.stateDirName), { recursive: true });
  writeFileSync(join(root, BRAND.stateDirName, "schedules.json"), JSON.stringify([
    { ...sent("backlog"), id: "L-off", enabled: false },
    { ...sent("backlog"), id: "L-on", enabled: true },
  ]));
  const { store, done } = makeStore({ root });
  try {
    store.migrateLegacy({ launches: () => [], schedules: schedulesToDrafts });
    const off = store.get("L-off"), on = store.get("L-on");
    assert.equal(off.trigger.paused, true);
    assert.equal(off.nextAt, null);
    assert.equal(intentToSchedule(off)?.enabled, false);
    assert.equal(on.trigger.paused, undefined);
    assert.ok(on.nextAt > Date.now());
  } finally { done(); rmSync(root, { recursive: true, force: true }); }
});

test("a FAILED one-off re-timed (intent.update) to a recurring weekly rule is ARMED, not stamped paused", async () => {
  const { store, done } = makeStore();
  try {
    const past = Date.now() - 10 * 24 * HOUR;
    assert.ok(store.post({ id: "o1", cwd: REPO, payload: { kind: "prompt", steps: ["hi"] }, target: { kind: "repo", fresh: true },
      trigger: { kind: "at", rule: { kind: "once", at: past, offsetMin: 0 }, graceMin: 10 } }).ok);
    await store.pass();
    await store.pass();
    assert.equal(store.get("o1").state, "failed");
    assert.equal(store.get("o1").nextAt, null, "settle wrote the spent one-off's null");
    const u = store.update("o1", { trigger: { kind: "at", rule: { ...WEEKLY, days: [1] }, graceMin: 120 } });
    assert.equal(u.ok, true);
    const g = store.get("o1");
    assert.equal(g.state, "queued");
    assert.equal(g.trigger.paused, undefined, "nobody pressed the pause switch");
    assert.ok(typeof g.nextAt === "number" && g.nextAt > Date.now(), `armed: ${g.nextAt}`);
    assert.doesNotMatch(intentVerdict(g, FACTS, Date.now()).detail ?? "", /switched off/);
  } finally { done(); }
});

test("a QUEUED row at nextAt null re-timed to a recurring weekly rule is armed — the old nextAt does not ride under the new clock", () => {
  const { store, done } = makeStore();
  try {
    // A one-off already past its grace arms to null and waits for the tick to fail it.
    const past = Date.now() - 10 * 24 * HOUR;
    assert.ok(store.post({ id: "q1", cwd: REPO, payload: { kind: "prompt", steps: ["hi"] }, target: { kind: "repo", fresh: true },
      trigger: { kind: "at", rule: { kind: "once", at: past, offsetMin: 0 }, graceMin: 10 } }).ok);
    assert.equal(store.get("q1").state, "queued");
    assert.equal(store.get("q1").nextAt, null);
    assert.equal(store.update("q1", { trigger: { kind: "at", rule: WEEKLY, graceMin: 120 } }).ok, true);
    const g = store.get("q1");
    assert.equal(g.trigger.paused, undefined);
    assert.ok(typeof g.nextAt === "number" && g.nextAt > Date.now(), `armed: ${g.nextAt}`);
    assert.doesNotMatch(intentVerdict(g, FACTS, Date.now()).detail ?? "", /switched off/);
  } finally { done(); }
});

// ── A paused WINDOW rule stays paused ──────────────────────────────────────
//
// The ladder's window-arming loop let every `nextAt: null` window row through
// and re-armed it on the next tick once a usage reading existed, so the pause
// switch did nothing for a window rule; and resuming one with no reading wrote
// `null` (the pause's old spelling) where "not read yet" is `undefined`
// (bughunt 2026-10-29 review D F2).
const WINDOW = { kind: "window", window: "session", edge: "after", offsetMin: 0 };

test("a paused recurring WINDOW rule is not re-armed by the tick once a reading exists", async () => {
  let usage;
  const { store, done } = makeStore({ usageWindows: () => usage });
  try {
    assert.ok(save(store, sent("fanout", { rule: WINDOW, nextAt: null })));
    assert.equal(store.setArmed("r-fanout", false), true);
    usage = { sessionResetAt: Date.now() + HOUR, sessionPct: 10 };
    await store.pass();
    await store.pass();
    const row = store.get("r-fanout");
    assert.equal(row.nextAt, null, "the pause switch must hold for a window rule too");
    assert.equal(row.trigger.paused, true);
    const v = intentVerdict(row, FACTS, Date.now());
    assert.match(v.detail ?? "", /switched off/, "and the row SAYS paused, not 'waiting for a reading'");
    // Resuming arms it at the reset the reading names.
    assert.equal(store.setArmed("r-fanout", true), true);
    assert.equal(store.get("r-fanout").nextAt, usage.sessionResetAt);
  } finally { done(); }
});

test("resuming a WINDOW rule with no reading yet leaves it unread (undefined), and the tick arms it later", async () => {
  let usage;
  const { store, done } = makeStore({ usageWindows: () => usage });
  try {
    assert.ok(save(store, sent("fanout", { rule: WINDOW, nextAt: null })));
    store.setArmed("r-fanout", false);
    assert.equal(store.setArmed("r-fanout", true), true);
    const row = store.get("r-fanout");
    assert.equal(row.trigger.paused, undefined);
    assert.equal(row.nextAt, undefined, "no reading ⇒ not computed, never null");
    usage = { sessionResetAt: Date.now() + HOUR, sessionPct: 10 };
    await store.pass();
    assert.equal(store.get("r-fanout").nextAt, usage.sessionResetAt, "the first reading arms it");
  } finally { done(); }
});

test("an ARMED window rule is armed by the tick exactly as before", async () => {
  let usage;
  const { store, done } = makeStore({ usageWindows: () => usage });
  try {
    assert.ok(save(store, sent("fanout", { rule: WINDOW, nextAt: null })));
    assert.equal(store.get("r-fanout").nextAt, undefined);
    usage = { sessionResetAt: Date.now() + HOUR, sessionPct: 10 };
    await store.pass();
    assert.equal(store.get("r-fanout").nextAt, usage.sessionResetAt);
  } finally { done(); }
});

// ── Only the pause switch writes the pause ─────────────────────────────────
//
// `trigger.paused` is `setArmed`'s (and the disk migration's) to write. A
// client's `intent.post` / `intent.update` / `schedule.save` that carries one
// would switch a rule off with no pause switch pressed — and on a row aimed at
// one place no switch is drawn to undo it (review D2 note).

test("a client cannot write trigger.paused: post, update and upsert strip it", () => {
  const { store, done } = makeStore();
  try {
    const trig = { kind: "at", rule: WEEKLY, graceMin: 120, paused: true };
    const p = store.post({ id: "c1", cwd: REPO, payload: { kind: "prompt", steps: ["hi"] }, target: { kind: "repo", fresh: true }, trigger: trig });
    assert.equal(p.ok, true);
    assert.equal(store.get("c1").trigger.paused, undefined, "post");
    assert.ok(store.get("c1").nextAt > Date.now());

    assert.equal(store.update("c1", { trigger: trig }).ok, true);
    assert.equal(store.get("c1").trigger.paused, undefined, "update");
    assert.ok(store.get("c1").nextAt > Date.now());

    const draft = scheduleToIntent(sent("backlog"), Date.now());
    const saved = store.upsert({ ...draft, trigger: { ...draft.trigger, paused: true } });
    assert.equal(saved.trigger.paused, undefined, "upsert");
    assert.ok(saved.nextAt > Date.now());

    // …while the pause switch still writes it, and an edit still carries it.
    assert.equal(store.setArmed("r-backlog", false), true);
    assert.equal(store.get("r-backlog").trigger.paused, true);
    assert.equal(save(store, sent("backlog", { name: "renamed" })).trigger.paused, true);
  } finally { done(); }
});
