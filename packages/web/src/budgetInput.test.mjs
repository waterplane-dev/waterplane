/**
 * What a typed session budget means (`budgetInput.ts`).
 *
 *     node --test packages/web/src/budgetInput.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { BUDGET_UNITS, budgetPreview, budgetSpentLine, budgetStateLine, budgetText, calibrationWords, parseBudgetInput, presetLabel } from "./budgetInput.ts";

const ok = (unit, text) => { const r = parseBudgetInput(unit, text); assert.equal(r.ok, true, `${unit} ${text}: ${r.reason}`); return r.max; };
const no = (unit, text) => { const r = parseBudgetInput(unit, text); assert.equal(r.ok, false, `${unit} ${text}`); return r.reason; };

test("tokens take plain numbers and k/m/b suffixes", () => {
  assert.equal(ok("tok", "500000"), 500000);
  assert.equal(ok("tok", "500k"), 500000);
  assert.equal(ok("tok", " 1.5M "), 1500000);
  assert.equal(ok("tok", "2,000,000"), 2000000);
  assert.equal(ok("tok", "1_000"), 1000);
});

test("dollars take a $ and a decimal comma", () => {
  assert.equal(ok("usd", "$2"), 2);
  assert.equal(ok("usd", "0.50"), 0.5);
  assert.equal(ok("usd", "2,50"), 2.5);
  assert.equal(ok("usd", "1,000"), 1000);
});

test("a percent takes an optional % and refuses past 100", () => {
  assert.equal(ok("sessionPct", "2%"), 2);
  assert.equal(ok("weeklyPct", "0.5"), 0.5);
  assert.equal(ok("weeklyPct", "100"), 100);
  assert.match(no("weeklyPct", "101"), /more than 100/);
});

test("a refusal is a sentence: blank, not a number, zero, negative", () => {
  assert.equal(no("usd", ""), "type a number");
  assert.match(no("usd", "two"), /not a number/);
  assert.match(no("tok", "lots"), /try 500k or 2m/);
  assert.match(no("usd", "0"), /more than zero/);
  assert.match(no("usd", "-3"), /not a number/);
  // The suffix means nothing on a dollar field — refused, never guessed at.
  assert.match(no("usd", "5k"), /not a number/);
});

test("the field text round-trips a cap the person typed", () => {
  for (const [unit, text] of [["tok", "500k"], ["tok", "2m"], ["usd", "2.5"], ["sessionPct", "0.5"]]) {
    const max = ok(unit, text);
    assert.equal(ok(unit, budgetText({ unit, max, interrupt: true })), max);
  }
});

test("four units, dollars first — the default, and the one a person reasons in", () => {
  assert.deepEqual(BUDGET_UNITS.map((u) => u.unit), ["usd", "tok", "sessionPct", "weeklyPct"]);
});

test("every quick pick parses in its own unit, and its chip says the unit", () => {
  for (const u of BUDGET_UNITS) {
    assert.ok(u.presets.length >= 3, u.unit);
    for (const p of u.presets) ok(u.unit, p);
  }
  assert.equal(presetLabel("usd", "2"), "$2");
  assert.equal(presetLabel("tok", "1m"), "1m");
  assert.equal(presetLabel("weeklyPct", "10"), "10%");
});

const spark = { usageTok: 1_200_000, agentTok: 300_000, costUsd: 0.48, agentCostUsd: 0.12 };
const NOW = 10_000_000;
const cal = { checkedAt: NOW - 60_000, sessionUsdPerPct: 0.1, weeklyUsdPerPct: null };

test("spent so far: never a total without its subagent split", () => {
  assert.equal(budgetSpentLine("usd", spark, null, NOW), "$0.48 so far — $0.36 in this conversation, $0.12 in subagents");
  assert.equal(budgetSpentLine("tok", spark, null, NOW), "1.2M tokens so far — 900k tokens in this conversation, 300k tokens in subagents");
  assert.match(budgetSpentLine("usd", { ...spark, agentCostUsd: 0 }, null, NOW), /none of it in subagents/);
  assert.match(budgetSpentLine("usd", { ...spark, agentCostUsd: undefined }, null, NOW), /subagent share is not logged/);
  assert.match(budgetSpentLine("sessionPct", spark, cal, NOW), /^≈4\.8% of the 5-hour window so far — ≈3\.6% .*≈1\.2% in subagents$/);
  // No session (a launch): nothing to orient by, so nothing is said.
  assert.equal(budgetSpentLine("usd", undefined, undefined, NOW), null);
});

test("a percent that cannot be converted still says the dollars", () => {
  // No budget yet: the host sent no calibration because it sends one only with a budget.
  assert.match(budgetSpentLine("weeklyPct", spark, undefined, NOW), /^in dollars, \$0\.48 so far — .*\$0\.12 in subagents$/);
  // A budget, but the week cannot be converted: shared's sentence, then the dollars.
  const w = budgetSpentLine("weeklyPct", spark, cal, NOW);
  assert.match(w, /nothing is held\. In dollars: \$0\.48 so far/);
  assert.match(budgetSpentLine("usd", { ...spark, costUsd: undefined }, null, NOW), /no list price/);
});

test("the preview puts the typed cap against the spend", () => {
  assert.equal(budgetPreview({ unit: "usd", max: 2 }, spark, null, NOW), "$0.48 of $2.00 — 24% used");
  assert.equal(budgetPreview({ unit: "tok", max: 3e6 }, spark, null, NOW), "1.2M of 3M — 40% used");
  assert.equal(budgetPreview({ unit: "sessionPct", max: 10 }, spark, cal, NOW), "≈4.8% of 10% — 48% used");
  assert.match(budgetPreview({ unit: "usd", max: 0.4 }, spark, null, NOW), /already past it: .* held as soon as it is set/);
  assert.equal(budgetPreview({ unit: "usd", max: 1000 }, spark, null, NOW), "$0.48 of $1,000 — under 1% used");
  // Unknown spend or no session: no preview (the spent line says why).
  assert.equal(budgetPreview({ unit: "weeklyPct", max: 5 }, spark, cal, NOW), null);
  assert.equal(budgetPreview({ unit: "usd", max: 2 }, null, null, NOW), null);
});

test("no budget, but a spark: the state line says what was spent, split", () => {
  assert.equal(budgetStateLine(undefined, NOW), "No budget on this session.");
  // With a spark the caller is the context card, whose TITLE says "no budget on
  // this session": the line is the spend alone, never that sentence a second time.
  assert.equal(budgetStateLine(undefined, NOW, spark), "Spent: $0.48 so far — $0.36 in this conversation, $0.12 in subagents.");
  assert.match(budgetStateLine(undefined, NOW, { ...spark, costUsd: undefined }), /^Spent: 1\.2M tokens so far/);
  // Nothing known: no line at all — the card is its title and its door.
  assert.equal(budgetStateLine(undefined, NOW, null), null);
});

test("calibration: dollars and tokens need none; a percent says what one point costs or why it cannot", () => {
  const now = 10_000_000;
  assert.equal(calibrationWords("usd", null, now), null);
  assert.equal(calibrationWords("tok", null, now), null);
  assert.match(calibrationWords("sessionPct", null, now), /no usage reading/);
  const cal = { checkedAt: now - 5 * 60_000, sessionUsdPerPct: 0.5, weeklyUsdPerPct: null };
  assert.match(calibrationWords("sessionPct", cal, now), /^1% of the 5-hour window ≈ \$0\.50 .* 5 min ago/);
  // The direction of the error is said where the rate is: other use of the account reads high.
  assert.match(calibrationWords("sessionPct", cal, now), /other use of the account makes it read high\)$/);
  assert.match(calibrationWords("weeklyPct", cal, now), /has not run enough/);
  assert.match(calibrationWords("sessionPct", { ...cal, checkedAt: now - 40 * 60_000 }, now), /40 min old/);
  // Every unknown ends on what it means for the person.
  for (const w of [calibrationWords("weeklyPct", cal, now), calibrationWords("sessionPct", null, now)]) assert.match(w, /nothing is held/);
});
