/** The health index's chip words and chart geometry, pure (`node --test`). */
import test from "node:test";
import assert from "node:assert/strict";
import {
  healthChip, indexLineGeom, contributionBars, signedWhole, signedTenths, indexExplainWords, gapWords,
  barsCaptionWords, weekChangeWords, HEALTH_ENTRY_NAME, HEALTH_ENTRY_MEASURE,
  weekWhenWords, indexBasketWords, carriedWords, linkSpanWords, sinceBaselineWords, indexVsWords, treeGrowthWords, indexAskLabel,
} from "./healthIndexWords.ts";

test("absent healthIndex draws no chip, never Health 0", () => {
  assert.equal(healthChip(undefined, "r"), null);
  assert.equal(healthChip(null, "r"), null);
  assert.equal(healthChip({ value: NaN, deltaWeek: 1, week: "2026-10-12", move: null }, "r"), null);
});

test("chip rounds, arrows follow the sign, tone follows the called move only", () => {
  const drop = healthChip({ value: 96.6, deltaWeek: -3.4, week: "2026-10-12", move: "drop" }, "r");
  assert.equal(drop.label, "Health 97");
  assert.equal(drop.delta, "3");
  assert.equal(drop.arrow, "down");
  assert.equal(drop.tone, "warn");
  const rise = healthChip({ value: 104, deltaWeek: 2.6, week: "w", move: "rise" }, "r");
  assert.equal(rise.arrow, "up");
  assert.equal(rise.tone, "calm");
  // A fall that was not called is a plain readout.
  const plain = healthChip({ value: 99, deltaWeek: -1, week: "w", move: null }, "r");
  assert.equal(plain.tone, null);
  assert.equal(plain.arrow, "down");
  // A carried week has no delta to state.
  const carried = healthChip({ value: 100, deltaWeek: null, week: "w", move: null }, "r");
  assert.equal(carried.delta, null);
  assert.equal(carried.arrow, null);
  const flat = healthChip({ value: 100, deltaWeek: 0.2, week: "w", move: null }, "r");
  assert.equal(flat.arrow, "flat");
  assert.match(drop.title, /Tap to open the readings/);
});

test("signed numbers use a real minus", () => {
  assert.equal(signedWhole(-3.2), "−3");
  assert.equal(signedWhole(0.2), "±0");
  assert.equal(signedTenths(-0.64), "−0.6");
  assert.equal(signedTenths(1.44), "+1.4");
});

test("line: baseline always inside the box, a gap breaks the run", () => {
  const pts = [
    { index: 100, gap: false }, { index: 104, gap: false }, { index: 104, gap: true }, { index: 98, gap: false },
  ];
  const g = indexLineGeom(pts, 300, 60);
  assert.ok(g.baseY >= 0 && g.baseY <= 60);
  assert.equal((g.d.match(/M/g) ?? []).length, 2, "the carried week starts a new run");
  assert.equal(g.gaps, 1);
  assert.equal(g.pts.length, 4);
  assert.equal(g.endX, 300);
  // Baseline stays on the chart even when every point is above 100.
  const up = indexLineGeom([{ index: 110, gap: false }, { index: 120, gap: false }], 100, 40);
  assert.ok(up.baseY > 0 && up.baseY <= 40);
  assert.equal(indexLineGeom([], 100, 40), null);
  // A flat series at 100 does not produce NaN.
  const flat = indexLineGeom([{ index: 100, gap: false }, { index: 100, gap: false }], 100, 40);
  assert.doesNotMatch(flat.d, /NaN/);
});

test("bars: one scale, fixed order, plain names, absent entries absent", () => {
  const { zeroX, bars } = contributionBars({ untested: -1, size: 2, hatches: 0 }, 200);
  assert.equal(zeroX, 100);
  assert.deepEqual(bars.map((b) => b.key), ["size", "hatches", "untested"]);
  const size = bars[0];
  const untested = bars[2];
  assert.equal(size.name, "File length");
  assert.ok(size.w > untested.w);
  assert.equal(size.x, zeroX);
  assert.equal(untested.x + untested.w, zeroX, "a negative bar grows left from zero");
  assert.equal(bars[1].side, "none");
  assert.deepEqual(contributionBars({}, 200).bars, []);
  assert.equal(HEALTH_ENTRY_NAME.context, "CLAUDE.md + skills");
});

test("sentences name the baseline and avoid verdict words", () => {
  const all = [
    indexExplainWords("2026-08-03", "waterplane"), gapWords(1), gapWords(3), barsCaptionWords("2026-10-12"),
    indexExplainWords("2026-08-03", "waterplane", { disabled: ["untested"], overridden: ["size"] }),
    carriedWords("central"), carriedWords("prereg"), carriedWords("nothing"), linkSpanWords(21),
    treeGrowthWords({ files: 100, loc: 10_000 }, { files: 150, loc: 9_000 }, "2026-08-03"),
    weekChangeWords(-3), weekChangeWords(null),
    healthChip({ value: 90, deltaWeek: -4, week: "w", move: "drop" }, "r").title,
    healthChip({ value: 110, deltaWeek: 4, week: "w", move: "rise" }, "r").title,
    ...Object.values(HEALTH_ENTRY_NAME), ...Object.values(HEALTH_ENTRY_MEASURE),
  ].join("\n");
  assert.match(indexExplainWords("2026-08-03", "waterplane"), /baseline week 2026-08-03/);
  for (const word of ["score", "grade", "healthy", "unhealthy", "good", "bad", "should", "worse", "better"]) {
    assert.doesNotMatch(all, new RegExp(`\\b${word}\\b`, "i"), word);
  }
});

test("'this week' only when the latest measured week IS the current one; otherwise the week is named", () => {
  assert.equal(weekWhenWords("2026-10-12", "2026-10-12"), "this week");
  assert.equal(weekWhenWords("2026-09-28", "2026-10-12"), "in the week of 2026-09-28");
  assert.equal(weekWhenWords("2026-09-28"), "in the week of 2026-09-28", "a caller that did not say gets the week named");
  assert.equal(weekChangeWords(3, "2026-10-12", "2026-10-12"), "+3 this week");
  assert.equal(weekChangeWords(3, "2026-09-28", "2026-10-12"), "+3 in the week of 2026-09-28");
  assert.equal(weekChangeWords(null, "2026-09-28", "2026-10-12"), "no change to state in the week of 2026-09-28");
  const old = healthChip({ value: 98, deltaWeek: 3, week: "2026-09-28", move: null }, "r", "2026-10-12");
  assert.match(old.title, /\(\+3 in the week of 2026-09-28\)/);
  assert.doesNotMatch(old.title, /this week/);
  const now = healthChip({ value: 98, deltaWeek: 3, week: "2026-10-12", move: "drop" }, "r", "2026-10-12");
  assert.match(now.title, /\(\+3 this week\), week of 2026-10-12/);
  assert.doesNotMatch(now.title, /This week's move/);
  assert.equal(indexAskLabel("2026-09-28", false), "ask what moved it in the week of 2026-09-28");
});

test("the basket sentence counts what the repo disabled and names what it overrode; none = null", () => {
  assert.equal(indexBasketWords(null, "P"), null);
  assert.equal(indexBasketWords({ disabled: [], overridden: [] }, "P"), null);
  assert.equal(indexBasketWords({ disabled: ["untested"] }, "P"), "Built from 4 of P's 5 readings; Untested modules is disabled here.");
  assert.equal(
    indexBasketWords({ disabled: ["untested", "size"], overridden: ["hatches"] }, "P"),
    "Built from 3 of P's 5 readings; File length and Untested modules are disabled here; Escape hatches reads this repo's own version.");
  const cap = indexExplainWords("2026-08-03", "P", { disabled: ["untested"] });
  assert.match(cap, /Built from 4 of P's 5 readings; Untested modules is disabled here\./);
  assert.doesNotMatch(cap, /compares across repos/, "a changed basket does not claim cross-repo comparability");
});

test("carried weeks say why; a link over silent weeks says how many", () => {
  assert.equal(carriedWords("central"), "carried: this repo changed which readings it overrides or disables");
  assert.match(carriedWords("prereg"), /definitions changed/);
  assert.match(carriedWords(undefined), /nothing comparable/);
  assert.equal(linkSpanWords(7), null);
  assert.equal(linkSpanWords(null), null);
  assert.equal(linkSpanWords(21), "one link over 3 weeks with no measured week between");
});

test("since baseline, vs a named week, and the tree's growth", () => {
  assert.equal(sinceBaselineWords(112.4), "+12 since baseline");
  assert.equal(indexVsWords({ delta: 18.2, then: { week: "2026-06-22" } }), "+18 vs week of 2026-06-22");
  assert.equal(indexVsWords(null), null);
  assert.equal(
    treeGrowthWords({ files: 100, loc: 10_000 }, { files: 150, loc: 9_000 }, "2026-08-03"),
    "The tree: 150 source files and 9,000 lines, against 100 and 10,000 in the baseline week 2026-08-03 (+50% files, −10% lines).");
  assert.equal(treeGrowthWords(null, { files: 1, loc: 1 }, "w"), null);
});

test("line: a link over more than one week is DASHED, never a measured run, and its ends are no dots", () => {
  const pts = [
    { index: 100, gap: false, spanDays: null }, { index: 102, gap: false, spanDays: 7 },
    { index: 104, gap: false, spanDays: 28 }, { index: 105, gap: false, spanDays: 7 },
  ];
  const g = indexLineGeom(pts, 300, 60);
  assert.equal((g.d.match(/M/g) ?? []).length, 2, "solid runs either side of the dash");
  assert.equal((g.dashed.match(/M/g) ?? []).length, 1);
  assert.deepEqual(g.dots, []);
  // A lone week between two dashes is on the line, not a dot.
  const lone = indexLineGeom([{ index: 100, gap: false }, { index: 101, gap: false, spanDays: 14 }, { index: 99, gap: false, spanDays: 14 }], 100, 40);
  assert.equal(lone.d, "");
  assert.equal((lone.dashed.match(/M/g) ?? []).length, 2);
  assert.deepEqual(lone.dots, []);
  // Without spanDays (an older caller) nothing is dashed.
  assert.equal(indexLineGeom([{ index: 100, gap: false }, { index: 101, gap: false }], 100, 40).dashed, "");
});
