/** A session's own budget: what may trip it and, above all, what may not. */
import test from "node:test";
import assert from "node:assert/strict";
import {
  BUDGET_STALE_MS,
  cleanAction,
  cleanSessionBudget,
  sessionBudgetCal,
  sessionBudgetChip,
  sessionBudgetHeld,
  sessionBudgetLabel,
  sessionBudgetText,
  sessionBudgetUnknownText,
  sessionBudgetVerdict,
  sessionSpend,
  windowUsdPerPct,
  sourceSpendSpark,
  budgetSparkOf,
  sessionBudgetWindowsOffText,
} from "../dist/index.js";

const NOW = 1_700_000_000_000;
const MIN = 60_000;
const spark = { usageTok: 2_000_000, agentTok: 500_000, costUsd: 0.52, agentCostUsd: 0.12 };
const usage = (o = {}) => ({
  ok: true, sessionPct: 10, weeklyPct: 20,
  sessionResetAt: NOW + 3600_000, weeklyResetAt: NOW + 86_400_000, checkedAt: NOW - MIN, ...o,
});
const cal = { checkedAt: NOW - MIN, sessionUsdPerPct: 0.26, weeklyUsdPerPct: 0.052 };

test("cleanSessionBudget keeps a real cap and refuses everything else whole", () => {
  assert.deepEqual(cleanSessionBudget({ unit: "usd", max: 2 }), { unit: "usd", max: 2, interrupt: true });
  assert.equal(cleanSessionBudget({ unit: "tok", max: 5e5, interrupt: false }).interrupt, false);
  for (const bad of [null, "x", {}, { unit: "eur", max: 1 }, { unit: "usd", max: 0 }, { unit: "usd", max: -1 },
    { unit: "usd", max: NaN }, { unit: "usd", max: "2" }, { unit: "sessionPct", max: 101 }, { unit: "weeklyPct", max: 250 }]) {
    assert.equal(cleanSessionBudget(bad), null, JSON.stringify(bad));
  }
  assert.equal(cleanSessionBudget({ unit: "weeklyPct", max: 100 }).max, 100);
});

test("cleanSessionBudget: hard is opt-in, only `true` counts, and it always interrupts", () => {
  assert.equal("hard" in cleanSessionBudget({ unit: "usd", max: 2 }), false, "absent = soft, the default");
  assert.equal("hard" in cleanSessionBudget({ unit: "usd", max: 2, hard: "yes" }), false, "garbage is soft, never hard");
  assert.deepEqual(cleanSessionBudget({ unit: "usd", max: 2, hard: true, interrupt: false }), { unit: "usd", max: 2, interrupt: true, hard: true });
});

test("windowUsdPerPct needs real money and a real percent", () => {
  assert.equal(windowUsdPerPct(10, 10), 1);
  assert.equal(windowUsdPerPct(0.5, 10), null, "under the dollar floor");
  assert.equal(windowUsdPerPct(10, 4), null, "under the percent floor");
  assert.equal(windowUsdPerPct(null, 10), null);
});

test("sessionBudgetCal: stale, unread and rolled windows calibrate nothing", () => {
  const c = sessionBudgetCal(usage(), { session: 5, weekly: 10 }, NOW);
  assert.deepEqual(c, { checkedAt: NOW - MIN, sessionUsdPerPct: 0.5, weeklyUsdPerPct: 0.5 });
  assert.equal(sessionBudgetCal(null, { session: 5, weekly: 10 }, NOW), null);
  assert.equal(sessionBudgetCal(usage({ ok: false }), { session: 5, weekly: 10 }, NOW), null);
  assert.equal(sessionBudgetCal(usage({ checkedAt: NOW - BUDGET_STALE_MS - 1 }), { session: 5, weekly: 10 }, NOW), null);
  assert.equal(sessionBudgetCal(usage({ sessionResetAt: NOW - 1, weeklyResetAt: NOW - 1 }), { session: 5, weekly: 10 }, NOW), null);
  const half = sessionBudgetCal(usage({ sessionResetAt: NOW - 1 }), { session: 5, weekly: 10 }, NOW);
  assert.equal(half.sessionUsdPerPct, null);
  assert.equal(half.weeklyUsdPerPct, 0.5);
  assert.equal(sessionBudgetCal(usage({ sessionPct: 2 }), { session: 5, weekly: 10 }, NOW).sessionUsdPerPct, null);
  assert.equal(sessionBudgetCal(usage({ sessionPct: null }), { session: 5, weekly: 10 }, NOW).sessionUsdPerPct, null);
});

test("spend in each unit, with the subagent share", () => {
  assert.deepEqual(sessionSpend("tok", spark, null, NOW), { value: 2_000_000, agent: 500_000 });
  assert.deepEqual(sessionSpend("usd", spark, null, NOW), { value: 0.52, agent: 0.12 });
  const s = sessionSpend("sessionPct", spark, cal, NOW);
  assert.ok(Math.abs(s.value - 2) < 1e-9 && Math.abs(s.agent - 0.12 / 0.26) < 1e-9);
  assert.ok(Math.abs(sessionSpend("weeklyPct", spark, cal, NOW).value - 10) < 1e-9);
});

test("every unknown reason is unknown, never over", () => {
  const cfg = (unit) => ({ unit, max: 0.0001, interrupt: true });
  const cases = [
    ["tok", undefined, undefined, "noSpark"],
    ["usd", {}, undefined, "unpriced"],
    ["usd", { usageTok: 1 }, undefined, "unpriced"],
    ["sessionPct", spark, undefined, "noReading"],
    ["sessionPct", spark, { ...cal, checkedAt: NOW - BUDGET_STALE_MS - 1 }, "stale"],
    ["sessionPct", spark, { ...cal, sessionUsdPerPct: null }, "noCalibration"],
    ["weeklyPct", spark, { ...cal, weeklyUsdPerPct: null }, "noCalibration"],
  ];
  for (const [unit, sp, c, why] of cases) {
    const v = sessionBudgetVerdict(cfg(unit), sp, c, NOW);
    assert.equal(v.state, "unknown", why);
    assert.equal(v.why, why);
    assert.equal(v.spent, null);
    assert.equal(sessionBudgetHeld({ budget: { cfg: cfg(unit), verdict: v } }), false);
  }
  const idle = sessionBudgetVerdict({ unit: "usd", max: 0.01, interrupt: true }, spark, null, NOW, false);
  assert.equal(idle.state, "unknown");
  assert.equal(idle.why, "notRunning");
});

test("at the cap trips; under it does not; held is the one predicate", () => {
  const at = sessionBudgetVerdict({ unit: "usd", max: 0.52, interrupt: true }, spark, null, NOW);
  assert.equal(at.state, "over");
  assert.equal(sessionBudgetHeld({ budget: { cfg: {}, verdict: at } }), true);
  const under = sessionBudgetVerdict({ unit: "usd", max: 0.53, interrupt: true }, spark, null, NOW);
  assert.equal(under.state, "ok");
  assert.equal(sessionBudgetHeld({ budget: { cfg: {}, verdict: under } }), false);
  assert.equal(sessionBudgetHeld({}), false);
  assert.equal(sessionBudgetVerdict({ unit: "tok", max: 2_000_000, interrupt: true }, spark, null, NOW).state, "over");
  assert.equal(sessionBudgetVerdict({ unit: "sessionPct", max: 2.5, interrupt: true }, spark, cal, NOW).state, "ok");
  assert.equal(sessionBudgetVerdict({ unit: "sessionPct", max: 1.5, interrupt: true }, spark, cal, NOW).state, "over");
});

test("the wording is pinned", () => {
  const over = sessionBudgetVerdict({ unit: "usd", max: 0.5, interrupt: true }, spark, null, NOW);
  assert.equal(sessionBudgetText(over), "$0.52 so far, $0.12 of it in subagents — over the $0.50 budget");
  assert.equal(sessionBudgetChip(over), "$0.52 / $0.50");
  const ok = sessionBudgetVerdict({ unit: "usd", max: 1, interrupt: true }, { costUsd: 0.31 }, null, NOW);
  assert.equal(sessionBudgetText(ok), "$0.31 so far — within the $1.00 budget");
  assert.equal(sessionBudgetUnknownText("stale", 40 * MIN), "can't tell: the usage reading is 40 min old — nothing is held");
  assert.match(sessionBudgetUnknownText("noCalibration"), /nothing is held$/);
  assert.equal(sessionBudgetChip({ state: "unknown", unit: "usd", max: 2, spent: null }), "? / $2.00");
  assert.equal(sessionBudgetLabel({ unit: "sessionPct", max: 2, interrupt: true }), "≤ 2% of this 5-hour window");
  assert.equal(sessionBudgetLabel({ unit: "weeklyPct", max: 10, interrupt: true }), "≤ 10% of this week");
  assert.equal(sessionBudgetLabel({ unit: "tok", max: 500_000, interrupt: true }), "≤ 500k tokens");
  const pct = sessionBudgetVerdict({ unit: "sessionPct", max: 1, interrupt: true }, spark, cal, NOW);
  assert.match(sessionBudgetText(pct), /^≈2% of the 5-hour window so far, ≈0\.5% of the 5-hour window of it in subagents — over the 1% of the 5-hour window budget \(≈, from this desktop's spend — other use of the account makes it read high\)$/);
});

test("a schedule action's budget is three answers: a cap, an explicit clear (null), or nobody said", () => {
  const cap = { unit: "usd", max: 2, interrupt: true };
  assert.deepEqual(cleanAction({ kind: "backlog", repoDir: "/r", text: "x", budget: cap }).budget, cap);
  const cleared = cleanAction({ kind: "backlog", repoDir: "/r", text: "x", budget: null });
  assert.ok("budget" in cleared && cleared.budget === null, "null survives cleaning: it is the person clearing the cap");
  assert.equal("budget" in cleanAction({ kind: "backlog", repoDir: "/r", text: "x" }), false, "absent stays absent");
  assert.equal("budget" in cleanAction({ kind: "backlog", repoDir: "/r", text: "x", budget: { unit: "usd", max: -1 } }), false,
    "a malformed cap is nobody said — never a clear that deletes a cap somebody set");
  assert.equal(cleanAction({ kind: "fanout", dirs: ["/a"], text: "x", budget: null }).budget, null, "a sweep too");
});

// ── P2: a backend's own spend ────────────────────────────────────────────────

test("sourceSpendSpark: a source's tok EXCLUDES its agents, so the total is the sum and the split rides", () => {
  assert.deepEqual(sourceSpendSpark({ at: 1, tok: 100, agentTok: 40, usd: 1, agentUsd: 0.5 }),
    { source: true, usageTok: 140, agentTok: 40, costUsd: 1.5, agentCostUsd: 0.5 });
  assert.deepEqual(sourceSpendSpark({ at: 1, tok: 100 }), { source: true, usageTok: 100 }, "no agent figure: a floor, no split claimed");
  assert.deepEqual(sourceSpendSpark({ at: 1, agentTok: 40 }), { source: true }, "agents alone are no total");
  assert.deepEqual(sourceSpendSpark({ at: 1, native: { amount: 300, unit: "AI credits" } }), { source: true, native: { amount: 300, unit: "AI credits" } }, "native rides as itself — never a token or dollar figure");
  assert.deepEqual(sourceSpendSpark(null), { source: true });
  assert.deepEqual(sourceSpendSpark({ at: 1, tok: -5, usd: 2 }), { source: true }, "a refused reading is dropped WHOLE");
  assert.deepEqual(sourceSpendSpark({ at: 1, usd: 2, native: { amount: 2, unit: "$" } }), { source: true }, "dollars in native are refused whole");
});

test("budgetSparkOf: sourceSpend present ⇒ the source; absent ⇒ claude's spark, untouched", () => {
  const spark = { usageTok: 9, costUsd: 0.1, windowTok: null };
  assert.equal(budgetSparkOf({ contextSpark: spark }), spark);
  assert.equal(budgetSparkOf({}), null);
  assert.deepEqual(budgetSparkOf({ contextSpark: spark, sourceSpend: { at: 1, tok: 5 } }), { source: true, usageTok: 5 });
});

test("a source spend: tok and usd judge where stated, unstated and percents never trip", () => {
  const cal = { checkedAt: NOW, sessionUsdPerPct: 1, weeklyUsdPerPct: 1 };
  const both = sourceSpendSpark({ at: 1, tok: 2000, usd: 3 });
  assert.equal(sessionBudgetVerdict({ unit: "tok", max: 1000, interrupt: true }, both, null, NOW).state, "over");
  assert.equal(sessionBudgetVerdict({ unit: "usd", max: 5, interrupt: true }, both, null, NOW).state, "ok");
  const tokOnly = sourceSpendSpark({ at: 1, tok: 2000 });
  const v = sessionBudgetVerdict({ unit: "usd", max: 0.01, interrupt: true }, tokOnly, null, NOW);
  assert.equal(v.state, "unknown");
  assert.equal(v.why, "unstated", "never 'unpriced': nothing prices another backend's tokens");
  assert.equal(sessionBudgetHeld({ budget: { cfg: { unit: "usd", max: 0.01, interrupt: true }, verdict: v } }), false);
  for (const unit of ["sessionPct", "weeklyPct"]) {
    const p = sessionBudgetVerdict({ unit, max: 1, interrupt: true }, both, cal, NOW);
    assert.equal(p.state, "unknown");
    assert.equal(p.why, "notClaude", "dollars are never converted into claude's window");
  }
  assert.equal(sessionSpend("tok", sourceSpendSpark(null), null, NOW).why, "unstated");
});

test("the source sentences: unstated names the unit, notClaude names claude's windows, both end on nothing held", () => {
  assert.match(sessionBudgetUnknownText("unstated", undefined, "tok"), /has not stated what it spent in tokens — nothing is held$/);
  assert.match(sessionBudgetUnknownText("unstated", undefined, "usd"), /in dollars — nothing is held$/);
  assert.match(sessionBudgetUnknownText("notClaude"), /claude's account.*nothing is held$/);
  const v = sessionBudgetVerdict({ unit: "usd", max: 1, interrupt: true }, sourceSpendSpark({ at: 1, tok: 1 }), null, NOW);
  assert.match(sessionBudgetText(v), /in dollars/);
  assert.equal(sessionBudgetWindowsOffText("Copilot"), "No ≈% of a window here: the 5-hour and weekly windows are claude's account, and Copilot does not spend from it.");
});

test("claude's spark is unchanged by the source rules (no `source` ⇒ noSpark / unpriced as before)", () => {
  assert.equal(sessionSpend("tok", {}, null, NOW).why, "noSpark");
  assert.equal(sessionSpend("usd", { usageTok: 5 }, null, NOW).why, "unpriced");
  assert.equal(sessionSpend("weeklyPct", { costUsd: 1 }, null, NOW).why, "noReading");
});

import { sessionBudgetChip as chipN, sessionBudgetLabel as labelN, sessionBudgetText as textN } from "../dist/index.js";

test("native: a cap needs its unit's name; the name is dropped on any other unit", () => {
  assert.equal(cleanSessionBudget({ unit: "native", max: 50 }), null);
  assert.equal(cleanSessionBudget({ unit: "native", max: 50, nativeUnit: "x".repeat(33) }), null);
  assert.deepEqual(cleanSessionBudget({ unit: "native", max: 50, nativeUnit: " AI credits " }), { unit: "native", max: 50, interrupt: true, nativeUnit: "AI credits" });
  assert.deepEqual(cleanSessionBudget({ unit: "tok", max: 5, nativeUnit: "AI credits" }), { unit: "tok", max: 5, interrupt: true });
});

test("native: judged on the source's own unit, by NAME, never converted", () => {
  const cfg = { unit: "native", max: 50, interrupt: true, nativeUnit: "AI credits" };
  const spark = sourceSpendSpark({ at: 1, tok: 100, native: { amount: 40, unit: "AI credits", agentAmount: 12 } });
  const v = sessionBudgetVerdict(cfg, spark, null, 2);
  assert.deepEqual({ state: v.state, spent: v.spent, agent: v.agentShare }, { state: "over", spent: 52, agent: 12 });
  assert.equal(textN(v), "52 AI credits so far, 12 AI credits of it in subagents — over the 50 AI credits budget");
  assert.equal(chipN(v), "52 / 50 AI credits");
  assert.equal(labelN(cfg), "≤ 50 AI credits");
  // Another unit's name is not a smaller number: unstated.
  const other = sessionBudgetVerdict(cfg, sourceSpendSpark({ at: 1, native: { amount: 3, unit: "premium requests" } }), null, 2);
  assert.deepEqual({ state: other.state, why: other.why }, { state: "unknown", why: "unstated" });
  assert.match(textN(other), /in AI credits — nothing is held$/);
  // Claude's spark has no native figure.
  assert.equal(sessionBudgetVerdict(cfg, { usageTok: 5, costUsd: 1 }, null, 2).why, "unstated");
});
