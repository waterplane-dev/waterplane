import test from "node:test";
import assert from "node:assert/strict";
import { weekCalKey, WEEK_MS } from "./logic.ts";

const now = Date.UTC(2026, 9, 1, 12);
const u = (over = {}) => ({
  ok: true, sessionPct: 2, weeklyPct: 94, sessionResetAt: null,
  weeklyResetAt: now + 86_400_000, checkedAt: now - 60_000, ...over,
});

test("weekCalKey: a live weekly reading is keyed by itself", () => {
  assert.equal(weekCalKey(u(), now), `${now + 86_400_000}:${now - 60_000}:94`);
});

test("weekCalKey: no key where a share would be a wrong number", () => {
  assert.equal(weekCalKey(null, now), null);
  assert.equal(weekCalKey(u({ weeklyPct: null }), now), null);
  assert.equal(weekCalKey(u({ weeklyPct: 3 }), now), null);          // ±0.5 of 3%
  assert.equal(weekCalKey(u({ weeklyResetAt: null }), now), null);
  assert.equal(weekCalKey(u({ weeklyResetAt: now - 1 }), now), null); // rolled
  assert.equal(weekCalKey(u({ weeklyResetAt: now + WEEK_MS, checkedAt: now - 1 }), now), null); // week just opened
});

import { usageFace } from "./logic.ts";
import { periodStates } from "@waterplane/shared";

const monthP = { id: "month", kind: "calendar", unit: "usd", cycle: "month", anchorDay: 1, tz: "UTC" };
const when = Date.UTC(2026, 9, 11, 12);
const view = (spentUsd) => ({
  budget: { enabled: true, sessionMax: 90, weeklyMax: null, leftoverMax: 20, periods: [monthP], ceilings: [{ periodId: "month", max: 2000, unit: "usd" }] },
  periods: periodStates([monthP], when).map((s) => ({ ...s, ...(spentUsd == null ? {} : { spentUsd }) })),
});

test("usageFace: subscription, unknown and an old host keep the two windows", () => {
  for (const s of [null, { profile: "unknown", source: "probe" }, { profile: "subscription", source: "probe" }]) {
    assert.deepEqual(usageFace(s, view(412), when), { kind: "windows" });
  }
});

test("usageFace: an API or cloud account reads dollars, or a bare door, never windows", () => {
  const api = { profile: "api", source: "probe" };
  assert.match(usageFace(api, view(412), when).chip.text, /^Oct \$412 \/ \$2000/);
  assert.deepEqual(usageFace({ profile: "cloud", source: "setting" }, view(null), when), { kind: "door" });
  assert.deepEqual(usageFace(api, null, when), { kind: "door" });
});

// ── usage readings per source ───────────────────────────────────────────────
import { claudeFigures, figuresHot, headerReadings, hiddenNote, infoFigures, launcherReadings, readingsOf } from "./logic.ts";

const copilot = { source: "copilot", label: "Copilot", backend: "copilot", checkedAt: now, windows: [{ id: "chat", unit: "mo", pct: 5, resetAt: null }] };

test("readingsOf: an older host sends none, so claude's is derived; a failed scrape is an empty list", () => {
  const r = readingsOf(undefined, u());
  assert.equal(r.length, 1);
  assert.equal(r[0].source, "claude");
  assert.deepEqual(readingsOf(undefined, u({ ok: false, sessionPct: null, weeklyPct: null })), []);
  assert.deepEqual(readingsOf(undefined, null), []);
});

test("readingsOf: the host's list wins, as sent", () => {
  assert.deepEqual(readingsOf([copilot], u()), [copilot]);
  assert.deepEqual(readingsOf([], u()), []);
});

test("claudeFigures of the derived reading equal the scrape's own figures (the chip is unchanged)", () => {
  for (const o of [{}, { sessionPct: 91 }, { weeklyPct: 85, sessionResetAt: now + 3600_000 }, { sessionPct: 0, weeklyPct: 0 }]) {
    const info = u({ sessionResetAt: now + 1800_000, ...o });
    assert.deepEqual(claudeFigures(readingsOf(undefined, info)[0]), infoFigures(info));
  }
});

test("figuresHot: today's rule, either window at 80", () => {
  assert.equal(figuresHot({ sess: 79, sessResetAt: null, wk: 79 }), false);
  assert.equal(figuresHot({ sess: 80, sessResetAt: null, wk: null }), true);
  assert.equal(figuresHot({ sess: null, sessResetAt: null, wk: 80 }), true);
});

test("headerReadings: this backend's own account, else only account-only readings, never another binary's quota", () => {
  const claude = readingsOf(undefined, u())[0];
  assert.deepEqual(headerReadings([claude, copilot], "claude"), [claude]);
  assert.deepEqual(headerReadings([claude, copilot], "copilot"), [copilot]);
  // claude's scrape failed (no claude reading) beside Copilot's, which names its backend: the claude
  // session's strip falls through to today's `sess ?% · wk ?%`, never Copilot's figure.
  assert.deepEqual(headerReadings([copilot], "claude"), []);
  assert.deepEqual(headerReadings([claude, copilot], null), []);
  const acct = { ...copilot, source: "acct", backend: undefined };
  assert.deepEqual(headerReadings([copilot, acct], "claude"), [acct]);
});

test("launcherReadings: another backend's quota only while a session of it runs", () => {
  const claude = readingsOf(undefined, u())[0];
  const acct = { ...copilot, source: "acct", backend: undefined };
  assert.deepEqual(launcherReadings([claude, copilot, acct], []), [claude, acct]);
  assert.deepEqual(launcherReadings([claude, copilot], [{ running: true }]), [claude]);
  assert.deepEqual(launcherReadings([claude, copilot], [{ backend: "copilot", running: false }]), [claude]);
  assert.deepEqual(launcherReadings([claude, copilot], [{ backend: "copilot", running: true }]), [claude, copilot]);
});

test("hiddenNote names the cut sources, nothing when none", () => {
  assert.equal(hiddenNote(undefined), "");
  assert.equal(hiddenNote([]), "");
  assert.equal(hiddenNote(["Gemini", "Codex"]), "\n+ Gemini, Codex not shown here");
});
