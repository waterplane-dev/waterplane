/**
 * "Flag for follow up when done" on a launched row (R-sessions-043).
 *
 * The rule, which fails silently if wrong: the session a row opened is flagged
 * ONCE, when the row is done+ok and nothing is running under the session —
 * never for a failed row, never while busy, never again after a person clears
 * it (nor after a restart), and before the linger sweep can close it.
 *
 * A fake `SessionManager` and store, like backlogsessions.test.mjs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.WATERPLANE_BACKLOG_REAP_IDLE_MS = "1000";
process.env.WATERPLANE_BACKLOG_LINGER_MS = "5000";
const { BacklogManager, backlogTitle } = await import("../dist/backlog.js");
const { forgetAppliedCache } = await import("../dist/backlog/backlogfollowup.js");

const REPO = "/tmp/waterplane-fu-repo";

function make(root = mkdtempSync(join(tmpdir(), "waterplane-fu-"))) {
  const state = { sessions: [], rows: [], flags: [], removed: [] };
  const sessions = {
    list: () => state.sessions.map((s) => ({ ...s, running: true })),
    get: (id) => { const s = state.sessions.find((x) => x.id === id); return s ? { ...s, running: true } : undefined; },
    remove: (id) => { state.removed.push(id); state.sessions = state.sessions.filter((x) => x.id !== id); return true; },
    idleMs: (id) => state.sessions.find((x) => x.id === id)?.idle ?? null,
    autoFireBlocker: (id) => (state.sessions.find((x) => x.id === id)?.turnActive ? "the session is working" : null),
    setFollowUp: (id, f) => { state.flags.push({ id, f }); return true; },
  };
  const intents = { list: () => state.rows, kick: () => {}, get: (id) => state.rows.find((r) => r.id === id), edit: () => ({ ok: true }) };
  const backlog = new BacklogManager(root, sessions, intents, { get: () => undefined, drop: () => {} });
  backlog.setCloseWhenDoneDefault(() => true);
  return { backlog, state, root, make: () => make(root) };
}

const session = (state, id, over = {}) => state.sessions.push({ id, cwd: REPO, title: `${backlogTitle(REPO)} · item`, createdAt: 0, idle: 99_000, ...over });
const row = (state, id, over = {}) => state.rows.push({
  id, cwd: REPO, state: "done", result: { ok: true, detail: "done" }, sessionId: "s1", createdAt: 1, label: "fix the flaky test",
  payload: { kind: "prompt", steps: ["fix it"] }, flagWhenDone: true, ...over,
});

test("a done+ok row that asked flags its session once, with the item label", () => {
  const { backlog, state } = make();
  session(state, "s1"); row(state, "r1");
  assert.deepEqual(backlog.followUpSweep(), ["s1"]);
  assert.equal(state.flags.length, 1);
  assert.equal(state.flags[0].f.by, "launch");
  assert.equal(state.flags[0].f.item, "fix the flaky test");
  backlog.followUpSweep(); backlog.followUpSweep();
  assert.equal(state.flags.length, 1, "once per row, not once per tick");
});

test("a row that did not ask, failed, or is still running never flags", () => {
  const { backlog, state } = make();
  session(state, "s1"); session(state, "s2"); session(state, "s3"); session(state, "s4");
  row(state, "a", { sessionId: "s1", flagWhenDone: undefined });
  row(state, "b", { sessionId: "s2", state: "failed", result: { ok: false, detail: "nope" } });
  row(state, "c", { sessionId: "s3", state: "running", result: undefined });
  row(state, "d", { sessionId: "s4", state: "done", result: { ok: false, detail: "usage limit" } });
  assert.deepEqual(backlog.followUpSweep(), []);
  assert.equal(state.flags.length, 0);
});

test("never while the session is busy; flags once it is free", () => {
  const { backlog, state } = make();
  session(state, "s1", { turnActive: true, idle: 0 }); row(state, "r1");
  assert.deepEqual(backlog.followUpSweep(), []);
  state.sessions[0].turnActive = false;
  state.sessions[0].agents = [{ what: "a subagent" }];
  assert.deepEqual(backlog.followUpSweep(), [], "a background agent under it is busy");
  state.sessions[0].agents = [];
  assert.deepEqual(backlog.followUpSweep(), ["s1"]);
});

test("a later row typed into the same session does not flag it; the opener decides", () => {
  const { backlog, state } = make();
  session(state, "s1");
  row(state, "opener", { flagWhenDone: undefined, createdAt: 1 });
  row(state, "later", { createdAt: 2 });
  assert.deepEqual(backlog.followUpSweep(), []);
});

test("not again after a person cleared it (same process) or after a restart", () => {
  const first = make();
  session(first.state, "s1"); row(first.state, "r1");
  first.backlog.followUpSweep();
  assert.equal(first.state.flags.length, 1);
  // The person clears it: the sweep must not put it back.
  first.backlog.followUpSweep();
  assert.equal(first.state.flags.length, 1);
  // A restart: a new manager over the same state dir, same row still done.
  forgetAppliedCache();
  const again = first.make();
  session(again.state, "s1"); row(again.state, "r1");
  again.backlog.followUpSweep();
  assert.equal(again.state.flags.length, 0, "the applied ids are on disk");
});

test("lingerSweep flags a session before it can close it", () => {
  const { backlog, state } = make();
  session(state, "s1"); row(state, "r1");
  const gone = backlog.lingerSweep(() => false);
  assert.equal(state.flags.length, 1, "flagged in the same pass");
  assert.deepEqual(gone, ["s1"]);
});
