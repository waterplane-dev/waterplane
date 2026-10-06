/**
 * The usage budget rule — the ceiling that stops automatic work before the
 * CLI's own limit banner does.
 *
 * Every case here is one the host cannot easily produce on demand: a reading
 * from before a reset, a scrape that failed, a window that rolled over while
 * nobody was watching. Pinned here rather than in an e2e script because none of
 * it needs a host — and because the two properties that matter most (fails
 * OPEN, resumes on the clock) are exactly the ones a bug would make silent.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  BUDGET_STALE_MS,
  DEFAULT_USAGE_BUDGET,
  budgetCeilings,
  budgetHoldText,
  budgetOtherCapText,
  budgetPassPendingText,
  budgetReasonText,
  budgetResumesText,
  budgetVerdict,
  cleanBudget,
} from "../dist/budget.js";

const NOW = 1_700_000_000_000;
const CFG = { ...DEFAULT_USAGE_BUDGET };

/** A usage reading, fresh by default. */
const u = (o = {}) => ({
  ok: true, sessionPct: 10, weeklyPct: 10,
  sessionResetAt: NOW + 60 * 60_000, weeklyResetAt: NOW + 3 * 24 * 60 * 60_000,
  checkedAt: NOW - 60_000,
  ...o,
});

test("default budget watches the session window at 90%", () => {
  assert.equal(DEFAULT_USAGE_BUDGET.enabled, true);
  assert.equal(DEFAULT_USAGE_BUDGET.sessionMax, 90);
  assert.equal(DEFAULT_USAGE_BUDGET.weeklyMax, null); // days-long pause is never a default
});

test("under the ceiling runs; at the ceiling stops", () => {
  assert.equal(budgetVerdict(CFG, u({ sessionPct: 89 }), NOW).blocked, false);
  const at = budgetVerdict(CFG, u({ sessionPct: 90 }), NOW);
  assert.equal(at.blocked, true);          // AT the ceiling, not just over it
  assert.equal(at.state, "over");
  assert.equal(at.which, "session");
  assert.equal(at.pct, 90);
  assert.equal(at.max, 90);
  assert.equal(at.resumeAt, NOW + 60 * 60_000);
  assert.equal(budgetVerdict(CFG, u({ sessionPct: 97 }), NOW).blocked, true);
});

test("the switch and a 100% ceiling both mean 'watching nothing'", () => {
  assert.equal(budgetVerdict({ ...CFG, enabled: false }, u({ sessionPct: 99 }), NOW).state, "off");
  assert.equal(budgetVerdict({ ...CFG, sessionMax: 100 }, u({ sessionPct: 99 }), NOW).state, "unset");
  // …and neither of them blocks, which is the only thing callers read.
  assert.equal(budgetVerdict({ ...CFG, enabled: false }, u({ sessionPct: 99 }), NOW).blocked, false);
  assert.equal(budgetVerdict({ ...CFG, sessionMax: 100 }, u({ sessionPct: 99 }), NOW).blocked, false);
});

test("an unreadable or stale reading FAILS OPEN", () => {
  // The reading is scraped off a TUI. A parse that breaks upstream must not
  // freeze every queue on every host — the CLI's own banner is still the wall.
  assert.equal(budgetVerdict(CFG, null, NOW).state, "unknown");
  assert.equal(budgetVerdict(CFG, u({ ok: false }), NOW).blocked, false);
  assert.equal(budgetVerdict(CFG, u({ sessionPct: null, weeklyPct: null }), NOW).blocked, false);
  assert.equal(budgetVerdict(CFG, u({ checkedAt: 0 }), NOW).state, "unknown");
  // Three missed polls old — about a window that may already have reset.
  const stale = budgetVerdict(CFG, u({ sessionPct: 99, checkedAt: NOW - BUDGET_STALE_MS - 1 }), NOW);
  assert.equal(stale.blocked, false);
  assert.equal(stale.state, "unknown");
  // …but a reading inside the window is still acted on.
  assert.equal(budgetVerdict(CFG, u({ sessionPct: 99, checkedAt: NOW - BUDGET_STALE_MS + 1 }), NOW).blocked, true);
});

test("past the reset instant the block clears on the clock alone", () => {
  // The auto-continue. No fresh scrape has landed and the cached percentage is
  // still 99 — but it describes a window that ENDED, so holding work back on it
  // is holding it back on something that is no longer true.
  const rolled = u({ sessionPct: 99, sessionResetAt: NOW - 1 });
  assert.equal(budgetVerdict(CFG, rolled, NOW).blocked, false);
  // One millisecond earlier it is still the same window.
  assert.equal(budgetVerdict(CFG, u({ sessionPct: 99, sessionResetAt: NOW + 1 }), NOW).blocked, true);
  // A reading that never named a reset can only be cleared by a fresh scrape.
  assert.equal(budgetVerdict(CFG, u({ sessionPct: 99, sessionResetAt: null }), NOW).blocked, true);
});

test("the weekly ceiling is opt-in, and the session one is reported first", () => {
  const weekOver = u({ sessionPct: 10, weeklyPct: 95 });
  assert.equal(budgetVerdict(CFG, weekOver, NOW).blocked, false);            // not watched by default
  const cfg = { ...CFG, weeklyMax: 80 };
  const v = budgetVerdict(cfg, weekOver, NOW);
  assert.equal(v.blocked, true);
  assert.equal(v.which, "weekly");
  assert.equal(v.resumeAt, NOW + 3 * 24 * 60 * 60_000);
  // Both over ⇒ name the session window: "back in an hour" beats "back Thursday".
  const both = budgetVerdict(cfg, u({ sessionPct: 95, weeklyPct: 95 }), NOW);
  assert.equal(both.which, "session");
});

test("under the ceiling, the window with the least headroom is the one named", () => {
  const cfg = { ...CFG, weeklyMax: 80 };
  const v = budgetVerdict(cfg, u({ sessionPct: 20, weeklyPct: 76 }), NOW);
  assert.equal(v.state, "ok");
  assert.equal(v.which, "weekly");   // 76/80 is tighter than 20/90
  assert.equal(v.pct, 76);
});

test("cleanBudget clamps rather than believes what came off disk", () => {
  // A hand-edited 0 would block every send for ever with no way back.
  assert.equal(cleanBudget({ sessionMax: 0 }).sessionMax, 1);
  assert.equal(cleanBudget({ sessionMax: 400 }).sessionMax, 100);
  assert.equal(cleanBudget({ sessionMax: "85" }).sessionMax, 85);
  assert.equal(cleanBudget({ sessionMax: NaN }).sessionMax, 90);
  assert.equal(cleanBudget({}).enabled, true);
  assert.equal(cleanBudget({ enabled: false }).enabled, false);
  assert.equal(cleanBudget({ weeklyMax: null }).weeklyMax, null);
  assert.equal(cleanBudget({ weeklyMax: 70 }).weeklyMax, 70);
  assert.equal(cleanBudget(null).sessionMax, 90);
  assert.equal(cleanBudget("nonsense").sessionMax, 90);
});

// ── budgetCeilings: every tripped cap, not just the first ─────────────────────
//
// The verdict names the FIRST ceiling over, which is the right sentence for a
// person and the wrong fact for the ladder: a row exempt from the session cap
// must still be held by a weekly one that is also over.

test("budgetCeilings is [] whenever the verdict does not block", () => {
  assert.deepEqual(budgetCeilings({ ...CFG, enabled: false }, u({ sessionPct: 99 }), NOW), []);
  assert.deepEqual(budgetCeilings({ ...CFG, sessionMax: 100, weeklyMax: null }, u({ sessionPct: 99 }), NOW), []);
  assert.deepEqual(budgetCeilings(CFG, null, NOW), []);
  assert.deepEqual(budgetCeilings(CFG, u({ ok: false, sessionPct: 99 }), NOW), []);
  assert.deepEqual(budgetCeilings(CFG, u({ sessionPct: 99, checkedAt: NOW - BUDGET_STALE_MS - 1 }), NOW), []);
  assert.deepEqual(budgetCeilings(CFG, u({ sessionPct: 50 }), NOW), []);
});

test("budgetCeilings names each window over, session first", () => {
  const cfg = { ...CFG, weeklyMax: 75 };
  const R = u().sessionResetAt;
  const W = u().weeklyResetAt;
  assert.deepEqual(budgetCeilings(cfg, u({ sessionPct: 95 }), NOW), [{ which: "session", pct: 95, max: 90, resetAt: R }]);
  assert.deepEqual(budgetCeilings(cfg, u({ weeklyPct: 97 }), NOW), [{ which: "weekly", pct: 97, max: 75, resetAt: W }]);
  assert.deepEqual(budgetCeilings(cfg, u({ sessionPct: 95, weeklyPct: 97 }), NOW).map((c) => c.which), ["session", "weekly"]);
  // Past its own reset a ceiling drops out on the clock alone; the other stays.
  const later = R + 1;
  assert.deepEqual(budgetCeilings(cfg, u({ sessionPct: 95, weeklyPct: 97, checkedAt: later - 60_000 }), later).map((c) => c.which), ["weekly"]);
});

test("budgetVerdict's over branch is budgetCeilings' first entry", () => {
  const cfg = { ...CFG, weeklyMax: 75 };
  const reading = u({ sessionPct: 95, weeklyPct: 97 });
  const first = budgetCeilings(cfg, reading, NOW)[0];
  const v = budgetVerdict(cfg, reading, NOW);
  assert.deepEqual({ which: v.which, pct: v.pct, max: v.max, resetAt: v.resumeAt }, first);
  assert.equal(v.state, "over");
});

// ── the three wordings of a budget hold ──────────────────────────────────────

// Local noon, so "an hour later" is the same local day in any zone the test runs in.
const NOON = new Date(2026, 8, 24, 12, 0).getTime();
const hhmm = (t) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

test("budgetResumesText: nothing when unknown, a time today, a weekday otherwise", () => {
  assert.equal(budgetResumesText(null, NOON), "");
  assert.equal(budgetResumesText(undefined, NOON), "");
  const soon = NOON + 60 * 60_000;
  assert.equal(budgetResumesText(soon, NOON), ` — resumes ${hhmm(soon)}`);
  // A weekly reset days out used to print a bare time, which reads as today.
  const days = NOON + 3 * 24 * 60 * 60_000;
  const wd = new Date(days).toLocaleDateString([], { weekday: "short" });
  assert.equal(budgetResumesText(days, NOON), ` — resumes ${wd} ${hhmm(days)}`);
});

test("budgetHoldText is the over sentence plus when it lifts; the other two build on it", () => {
  const c = { which: "weekly", pct: 97, max: 75, resetAt: NOON + 60 * 60_000 };
  const hold = budgetHoldText(c, NOON);
  assert.equal(hold, budgetReasonText({ blocked: true, state: "over", which: "weekly", pct: 97, max: 75 }) + budgetResumesText(c.resetAt, NOON));
  assert.match(hold, /^paused — 97% of the weekly window used, over the 75% budget — resumes /);
  assert.equal(budgetHoldText({ ...c, resetAt: null }, NOON), "paused — 97% of the weekly window used, over the 75% budget");
  const pending = budgetPassPendingText(c, NOON);
  assert.ok(pending.startsWith(hold));
  assert.match(pending, /lifted for this row at its time/);
  assert.match(pending, /there is no later$/);
  assert.match(pending, /timed before that window resets/);
  assert.match(budgetPassPendingText({ ...c, which: "session" }, NOON, "weekly"), /timed before the weekly window resets/);
  const other = budgetOtherCapText(c, "session", NOON);
  assert.equal(other, `${hold} · exempt from the session ceiling, not from this one`);
});
