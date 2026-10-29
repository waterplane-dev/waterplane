/**
 * C12: a plugin session that EXITS at its own source wall (`sources.usage.wall`, the `limits`
 * fact as `{source:true}`) is reopened at the reset like claude's limit exit — on the last
 * verdict the source gave (`info.limit`, written by `wall.ts`'s `applySourceWall`), by the
 * conversation's exact `backendSessionId`. An undated wall (`needsYou`) schedules nothing; so
 * does an unknown conversation id (a bare continue would pick the newest, maybe someone else's).
 *
 * Stubbed: no plugin, no PTY, no model call. `ResumeSlice` over a core proxy.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { ResumeSlice } = await import("../dist/sessions/resume.js");

const root = mkdtempSync(join(tmpdir(), "wp-sourceresurrect-"));
after(() => rmSync(root, { recursive: true, force: true }));

const CAPS = { turns: true, slash: "none", remoteControl: false, permissionModes: [] };
const UUID = "0b8a52a4-6a0e-4c1e-9f55-3c3f6f0b2d11";

function acme({ limits = [{ source: true }], wall = () => null } = {}) {
  const usage = { source: "acme", label: "Acme", windows: async () => [], wall };
  return { id: "acme", plugin: "acme", label: "Acme", caps: CAPS, facts: { turns: [{ source: true }], limits }, sources: { usage, attach: async () => ({}) } };
}

function harness(backend, { limit, backendSessionId = UUID, auto = true, retry } = {}) {
  const events = [];
  const created = [];
  const gaveUp = [];
  const sessions = new Map();
  const base = {
    root, sessions,
    emit: (ev, _id, _info, phase) => { events.push(ev === "limit" ? `limit:${phase}` : ev); return true; },
    limitAuto: () => auto,
    limitRetry: retry ?? ((_s, now, resetAt) => ({ kind: "at", at: resetAt ?? now + 60_000 })),
    noteGaveUp: (_s, why) => { gaveUp.push(why); },
    resumeMode: () => "one",
    limitLog: () => { throw new Error("a source-walled session must never be asked claude's log"); },
    create: async (cwd, opts) => { created.push({ cwd, opts }); const info = { id: "s2", cwd, running: true }; sessions.set("s2", { info, backend }); return info; },
    closedRow: () => null,
  };
  const core = new Proxy(base, { get: (t, k) => (k in t ? t[k] : () => undefined) });
  const resume = new ResumeSlice(core);
  const s = {
    info: { id: "s1", cwd: root, running: false, title: "demo", ...(backendSessionId ? { backendSessionId } : {}), ...(limit ? { limit } : {}) },
    backend, scrollback: "", limitTimer: null, resurrectTimer: null, spawnedAt: Date.now(), launch: { model: "m" },
  };
  sessions.set("s1", s);
  after(() => resume.clearResurrectTimer(s));
  return { resume, s, events, created, gaveUp };
}

const blocked = (extra = {}) => ({ blocked: true, attempts: 0, blockedSince: Date.now() - 1000, resetAt: null, weekly: false, nextAttemptAt: null, ...extra });

test("a dated source wall at exit ⇒ a resurrect armed for the reset, the row follows it", () => {
  const resetAt = Date.now() + 3 * 3_600_000;
  const asked = [];
  const h = harness(acme(), { limit: blocked({ resetAt }), retry: (_s, now, r) => { asked.push(r); return { kind: "at", at: r ?? now }; } });
  assert.equal(h.resume.diedAtLimit("s1"), true, "the backlog requeues: a revival is coming");
  h.resume.maybeScheduleResurrect(h.s);
  assert.deepEqual(asked, [resetAt], "the source's instant is the one handed to the cadence");
  assert.ok(h.s.resurrectTimer, "a resurrect is armed");
  assert.equal(h.s.info.limit.nextAttemptAt, resetAt);
  assert.deepEqual(h.events, ["updated", "limit:scheduled"]);
});

test("an UNDATED source wall at exit (needsYou) ⇒ nothing scheduled, and the work is not held for it", () => {
  const h = harness(acme(), { limit: blocked({ needsYou: "Acme has no credit left" }) });
  assert.equal(h.resume.diedAtLimit("s1"), false);
  h.resume.maybeScheduleResurrect(h.s);
  assert.equal(h.s.resurrectTimer, null);
  assert.equal(h.s.info.limit.nextAttemptAt, null);
  assert.deepEqual(h.events, []);
});

test("no conversation id known ⇒ nothing scheduled (a bare continue picks the newest, maybe not this one)", () => {
  const h = harness(acme(), { limit: blocked({ resetAt: Date.now() + 60_000 }), backendSessionId: null });
  assert.equal(h.resume.diedAtLimit("s1"), false);
  h.resume.maybeScheduleResurrect(h.s);
  assert.equal(h.s.resurrectTimer, null);
  assert.deepEqual(h.events, []);
});

test("not blocked when it went, auto-continue off, or a person's close ⇒ just an exit", () => {
  for (const [name, opts, mut] of [
    ["clear", { limit: { ...blocked(), blocked: false, resetAt: Date.now() + 60_000 } }],
    ["auto off", { limit: blocked({ resetAt: Date.now() + 60_000 }), auto: false }],
    ["killed", { limit: blocked({ resetAt: Date.now() + 60_000 }) }, (s) => { s.killed = true; }],
  ]) {
    const h = harness(acme(), opts);
    mut?.(h.s);
    h.resume.maybeScheduleResurrect(h.s);
    assert.equal(h.s.resurrectTimer, null, name);
    assert.deepEqual(h.events, [], name);
  }
});

test("a backend whose limits are not a source never resurrects, whatever its last state", () => {
  const h = harness(acme({ limits: [] }), { limit: blocked({ resetAt: Date.now() + 60_000 }) });
  assert.equal(h.resume.diedAtLimit("s1"), false);
  h.resume.maybeScheduleResurrect(h.s);
  assert.equal(h.s.resurrectTimer, null);
});

test("the cadence giving up ⇒ said, nothing armed", () => {
  const h = harness(acme(), { limit: blocked({ resetAt: Date.now() + 60_000 }), retry: () => ({ kind: "giveup", why: "attempts spent" }) });
  h.resume.maybeScheduleResurrect(h.s);
  assert.equal(h.s.resurrectTimer, null);
  assert.deepEqual(h.gaveUp, ["attempts spent"]);
});

test("at the reset the conversation is reopened by its exact plugin id, continue mode, launch carried", async () => {
  const h = harness(acme(), { limit: blocked({ resetAt: Date.now() + 1 }), retry: (_s, now) => ({ kind: "at", at: now + 10 }) });
  h.resume.maybeScheduleResurrect(h.s);
  for (let i = 0; i < 50 && !h.created.length; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(h.created.length, 1, "reopened once");
  const { opts } = h.created[0];
  assert.equal(opts.resumeMode, "continue");
  assert.equal(opts.resumeSessionId, UUID, "the plugin's own id, never claude's (absent) one");
  assert.deepEqual(opts.launch, { model: "m" });
  assert.equal(opts.origin.kind, "resurrect");
  assert.equal(h.resume.revivedSessionFor("s1"), "s2");
});
