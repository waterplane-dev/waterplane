/**
 * `trigger.paused` is the ONE owner of "paused", and `cleanIntentRow` — which
 * runs on EVERY write, not only on load — never infers it. The older host's
 * spelling (a recurring weekly rule at `nextAt: null`, no flag) is a fact
 * about a FILE, so it is stamped by the store's disk load (the host's
 * `intents/disk.ts`), never here: run on a live edit, the inference read a
 * failed one-off's settled `nextAt: null`, riding under a new weekly trigger,
 * as a pause nobody pressed (bughunt 2026-10-29 review D2 F1).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { cleanIntentRow, intentPaused } from "../dist/index.js";

const NOW = Date.UTC(2026, 9, 29, 12);
const WEEKLY = { kind: "weekly", days: [1], hour: 9, minute: 0, offsetMin: 0 };
const row = (trigger, over = {}) => ({
  id: "r1", cwd: "/repo", payload: { kind: "prompt", steps: ["go"] }, target: { kind: "repo", fresh: true },
  trigger, state: "queued", createdAt: NOW - 1000, ...over,
});

test("cleanIntentRow never stamps a pause off a recurring weekly nextAt: null", () => {
  const r = cleanIntentRow(row({ kind: "at", rule: WEEKLY, graceMin: 60 }, { nextAt: null }), NOW);
  assert.equal(r.trigger.paused, undefined, "the flag is written by the pause switch, never inferred");
  assert.equal(r.nextAt, null, "…and null survives as the explicit nothing-armed");
});

test("cleanIntentRow keeps the pause switch's flag and keeps a paused row disarmed", () => {
  const r = cleanIntentRow(row({ kind: "at", rule: WEEKLY, graceMin: 60, paused: true }, { nextAt: NOW + 5000 }), NOW);
  assert.equal(r.trigger.paused, true);
  assert.equal(r.nextAt, null, "a paused row is never armed");
});

test("cleanIntentRow leaves an armed unflagged rule armed", () => {
  const r = cleanIntentRow(row({ kind: "at", rule: WEEKLY, graceMin: 60 }, { nextAt: NOW + 5000 }), NOW);
  assert.equal(r.trigger.paused, undefined);
  assert.equal(r.nextAt, NOW + 5000);
});

test("intentPaused reads only the flag: a recurring weekly nextAt: null is NOT paused", () => {
  const live = row({ kind: "at", rule: WEEKLY, graceMin: 60 }, { nextAt: null });
  assert.equal(intentPaused(live), false, "no person paused it; null is only nothing-armed");
  assert.equal(intentPaused(row({ kind: "at", rule: WEEKLY, graceMin: 60, paused: true }, { nextAt: null })), true);
  assert.equal(intentPaused(row({ kind: "at", rule: WEEKLY, graceMin: 60 }, { nextAt: NOW + 5000 })), false);
});
