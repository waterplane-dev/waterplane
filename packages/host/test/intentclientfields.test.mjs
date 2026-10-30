/**
 * **A client states only what `INTENT_FIELD_WRITER` lets it state** — at every
 * entry that takes an intent off the wire:
 *
 * - `intent.update` (socket) — `workintent.ts`, `clientIntentFields(…, "edit")`
 * - `intent.post` (socket), `POST /api/agent/intents`, a peer's job — all
 *   `postClientDraft`, `clientIntentFields(…, "post")`
 * - `schedule.save` — `scheduleToIntent` builds the draft field by field, so
 *   nothing it was not told about reaches `upsert()`.
 *
 * The case that made it a contract: an `intent.update` frame carrying
 * `nextAt: null` was spread over a recurring row, which nothing then re-armed
 * and whose verdict called a standing rule a one-off (review D3 (d)).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { IntentManager } = await import("../dist/intents/manager.js");
const { scheduleToIntent } = await import("../dist/intents/adapters.js");
const { postClientDraft } = await import("../dist/agentintents.js");
const { workRoutes } = await import("../dist/routes/work.js");

const REPO = "/tmp/waterplane-clientfields-repo";
const HOUR = 3_600_000;
const WEEKLY = { kind: "weekly", days: [], hour: 4, minute: 0, tz: "UTC", offsetMin: 0 };

/** Every host-owned field, each with a value that would matter if it landed. */
const HOST_FIELDS = {
  nextAt: null, lastOccurrence: 1, clearedOccurrence: 2, state: "done", attempts: 4,
  blockReason: "budget", blockDetail: "x", blockSessionId: "s", startedAt: 5, settledAt: 6,
  sessionId: "s1", result: { ok: true, detail: "faked" }, requeues: [{ at: 1, by: "hand" }], requeueCount: 7,
  missing: ["a"], dismissedAt: 8, followed: true, handOrdered: true, createdAt: 9,
};

function makeStore() {
  const root = mkdtempSync(join(tmpdir(), "waterplane-clientfields-"));
  const exec = async () => ({ ok: true, detail: "" });
  const store = new IntentManager({
    root, sessions: () => [], sessionAlive: () => false, repoSession: () => null, repoAnySession: () => false,
    autoSlotsFree: () => 3, autoSlotsDetail: () => undefined, revivedSessionFor: () => null, diedAtLimit: () => false,
    stopCount: () => 0, isHooked: () => false, sessionIdleMs: () => 99_000, sessionHasPrompt: () => false,
    idleWindowMs: () => 1000, groupConcurrency: () => 6, knownDirs: async () => new Set([REPO]),
    budgetBlocked: () => false, autoFire: () => false, logVerdict: () => "unknown",
    executors: { freshSession: exec, sweep: exec, deliver: exec, workItem: exec, build: exec, scheduledBuild: exec, assess: exec },
    onChange: () => {},
  });
  return { store, done: () => { store.stop(); rmSync(root, { recursive: true, force: true }); } };
}
const ctx = (store) => ({ intents: store, send: () => {}, containRepoDir: async (d) => d });
const draft = (id) => ({ id, cwd: REPO, payload: { kind: "prompt", steps: ["sweep"] }, trigger: { kind: "at", rule: WEEKLY, graceMin: 30 } });

test("intent.update: a frame's host fields never reach the row — a `nextAt: null` cannot disarm a weekly rule", async () => {
  const { store, done } = makeStore();
  try {
    assert.equal(store.post(draft("w1")).ok, true);
    const armed = store.get("w1").nextAt;
    assert.ok(armed > Date.now(), "armed");
    const r = await workRoutes["intent.update"].run({
      msg: { t: "intent.update", id: "w1", patch: { label: "renamed", ...HOST_FIELDS, id: "hijack", origin: "agent" } },
      ws: {}, c: ctx(store),
    });
    assert.equal(r.ok, true);
    const row = store.get("w1");
    assert.equal(row.label, "renamed", "the fields a client owns are applied");
    assert.equal(row.nextAt, armed, "nextAt is the host's");
    assert.equal(row.state, "queued");
    for (const k of ["lastOccurrence", "clearedOccurrence", "result", "requeueCount", "followed", "handOrdered", "dismissedAt", "sessionId", "missing"]) {
      assert.equal(row[k], undefined, `${k} is the host's`);
    }
    assert.equal(store.get("hijack"), undefined, "an edit cannot rename the row's id");
    assert.equal(row.origin, undefined, "provenance is stated at the post, never patched");
  } finally { done(); }
});

test("intent.post: a draft's host fields never reach the row", async () => {
  const { store, done } = makeStore();
  try {
    const r = await workRoutes["intent.post"].run({
      msg: { t: "intent.post", intent: { ...draft("p1"), ...HOST_FIELDS } }, ws: {}, c: ctx(store),
    });
    assert.equal(r.ok, true);
    const row = store.get("p1");
    assert.equal(row.state, "queued");
    assert.ok(row.nextAt > Date.now(), "armed by the host, not nulled by the client");
    assert.ok(row.createdAt > 9, "the host's clock");
    for (const k of ["lastOccurrence", "clearedOccurrence", "result", "requeues", "requeueCount", "followed", "handOrdered", "blockReason", "missing", "dismissedAt"]) {
      assert.equal(row[k], undefined, `${k} is the host's`);
    }
  } finally { done(); }
});

test("postClientDraft (the agent and peer routes' path too) hands the store no host field", async () => {
  const posted = [];
  const deps = { containRepoDir: async (d) => d, intents: { post: (d) => { posted.push(d); return { ok: true, intent: d }; } } };
  for (const origin of [undefined, "agent", "peer:box"]) {
    await postClientDraft(deps, { ...draft("a1"), ...HOST_FIELDS }, origin ? { origin } : {});
    const d = posted.at(-1);
    for (const k of Object.keys(HOST_FIELDS)) assert.equal(k in d, false, `${k} dropped (origin ${origin})`);
    assert.equal(d.trigger.kind, "at", "the client's own fields arrive");
  }
});

test("schedule.save: the draft is built field by field, so an entry's host fields are never read", () => {
  const d = scheduleToIntent({
    id: "s1", name: "n", enabled: true, rule: WEEKLY, graceMin: 30,
    action: { kind: "backlog", repoDir: REPO, text: "x", autoFire: true },
    nextAt: null, lastOccurrence: 1, clearedOccurrence: 2, state: "done", requeueCount: 3, followed: true,
  }, Date.now() - HOUR);
  for (const k of ["nextAt", "lastOccurrence", "clearedOccurrence", "state", "requeueCount", "followed"]) {
    assert.equal(k in d, false, `${k} not in the draft`);
  }
});
