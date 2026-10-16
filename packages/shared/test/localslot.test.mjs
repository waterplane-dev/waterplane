// The local-model cap (rung 4.55, `localModel`) as pure rules: the ladder's
// rung, its two sentences and the synced setting's one parse. The host's half
// (which sessions are local, the model load) is `packages/host/test/localslot.test.mjs`.
// Asked 2026-10-13 (R-intent-local-001): one active local coding session at a
// time by default, a setting to change it.
import test from "node:test";
import assert from "node:assert/strict";
import {
  INTENT_BLOCK_ORDER,
  LOCAL_SESSIONS_KEY,
  SYNCED_SETTING_KEYS,
  intentReasonText,
  intentVerdict,
  localSessionsSetting,
  localSlotOverText,
  localSlotWaitText,
  serialGroup,
} from "../dist/index.js";

const NOW = 1_700_000_000_000;

const intent = (over = {}) => ({
  id: "i1", cwd: "/repo",
  payload: { kind: "prompt", steps: ["do the thing"] },
  target: { kind: "repo", fresh: true },
  trigger: { kind: "now" },
  state: "queued", createdAt: NOW - 60_000, auto: true,
  ...over,
});

const facts = (over = {}) => ({
  present: new Set(), sessions: [], repoSession: new Map(), busyCwds: new Set(), busySessions: new Set(),
  budgetBlocked: false, autoFire: true, knownDirs: new Set(), hostBusy: false, autoSlotsFree: 3,
  ...over,
});

const local = (free, rows = ["i1"], busy = []) => ({ free, rows: new Set(rows), busy: new Set(busy) });

test("a local row waits while the local cap is full, and goes once it frees", () => {
  const held = intentVerdict(intent(), facts({ local: local(0) }), NOW);
  assert.equal(held.kind, "wait");
  assert.equal(held.reason, "localModel");
  assert.match(held.detail, /waiting for the local model/);
  assert.equal(intentVerdict(intent(), facts({ local: local(1) }), NOW).kind, "go");
});

test("absent facts and rows the host did not name are untouched — the old behaviour", () => {
  assert.equal(intentVerdict(intent(), facts(), NOW).kind, "go");
  // Not in `rows`: a hosted model, an unknown one, or a person's own tap.
  assert.equal(intentVerdict(intent(), facts({ local: local(0, []) }), NOW).kind, "go");
});

test("a row aimed at a local session that is itself the busy one waits on that session, not on the cap", () => {
  const s = { id: "s1", cwd: "/repo", running: true, turnActive: true };
  const row = intent({ target: { kind: "session", sessionId: "s1" } });
  const v = intentVerdict(row, facts({ sessions: [s], local: local(0, ["i1"], ["s1"]) }), NOW);
  assert.equal(v.kind, "wait");
  assert.equal(v.reason, "sessionBusy");
});

test("the order: serial and hostBusy speak first, the local model before the automatic-session slot", () => {
  const world = facts({ busyCwds: new Set([serialGroup("/repo")]), hostBusy: true, autoSlotsFree: 0, local: local(0) });
  const all = intent({ serial: true, holdForHost: true });
  assert.equal(intentVerdict(all, world, NOW).reason, "serial");
  assert.equal(intentVerdict({ ...all, serial: false }, world, NOW).reason, "hostBusy");
  assert.equal(intentVerdict({ ...all, serial: false, holdForHost: false }, world, NOW).reason, "localModel");
  assert.equal(intentVerdict({ ...all, serial: false, holdForHost: false }, { ...world, local: local(1) }, NOW).reason, "noSlot");
  // A known reason: cleanIntentRow keeps it, the activity sort ranks it.
  assert.ok(INTENT_BLOCK_ORDER.includes("localModel"));
  assert.match(intentReasonText("localModel"), /local model/);
});

test("the wait sentence names the count and, for one, the session", () => {
  assert.equal(localSlotWaitText({ max: 1, working: [] }), undefined);
  assert.equal(localSlotWaitText({ max: null, working: [{ id: "a" }, { id: "b" }] }), undefined);
  assert.equal(
    localSlotWaitText({ max: 1, working: [{ id: "a", name: "fix the parser" }] }),
    "waiting for the local model — 1 local session is working (fix the parser); this desktop runs 1 at a time",
  );
  assert.equal(
    localSlotWaitText({ max: 2, working: [{ id: "a" }, { id: "b" }] }),
    "waiting for the local model — 2 local sessions are working; this desktop runs 2 at a time",
  );
});

test("a person's start past the cap is told in words, never refused", () => {
  assert.equal(localSlotOverText({ max: 1, working: [] }), undefined);
  assert.equal(localSlotOverText({ max: null, working: [{ id: "a" }] }), undefined);
  assert.match(localSlotOverText({ max: 1, working: [{ id: "a", name: "nightly" }] }), /^another local-model session is working \(nightly\) — this desktop runs 1 at a time/);
});

test("the setting: whole numbers are the cap, 0 is none, anything else is the desktop default", () => {
  assert.ok(SYNCED_SETTING_KEYS.includes(LOCAL_SESSIONS_KEY));
  assert.equal(localSessionsSetting("2", 1), 2);
  assert.equal(localSessionsSetting(" 3 ", 1), 3);
  assert.equal(localSessionsSetting("0", 1), null);
  assert.equal(localSessionsSetting(undefined, 1), 1);
  assert.equal(localSessionsSetting("", 4), 4);
  assert.equal(localSessionsSetting("two", 1), 1);
  assert.equal(localSessionsSetting("-1", 1), 1);
  assert.equal(localSessionsSetting("1.5", 1), 1);
  assert.equal(localSessionsSetting("99", 1), 1);
  assert.equal(localSessionsSetting(undefined, null), null);
});
