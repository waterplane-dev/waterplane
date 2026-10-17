/** The health index's chip words and chart geometry, pure (`node --test`). */
import test from "node:test";
import assert from "node:assert/strict";
import {
  healthChip, indexLineGeom, contributionBars, signedWhole, signedTenths, indexExplainWords, gapWords,
  barsCaptionWords, weekChangeWords, HEALTH_ENTRY_NAME, HEALTH_ENTRY_MEASURE, HEALTH_GOOD_WORDS, trendWords,
  weekWhenWords, indexBasketWords, carriedWords, linkSpanWords, sinceBaselineWords, indexVsWords, treeGrowthWords, indexAskLabel,
} from "./healthIndexWords.ts";

test("absent healthIndex draws no chip, never Health 0", () => {
  assert.equal(healthChip(undefined, "r"), null);
  assert.equal(healthChip(null, "r"), null);
  assert.equal(healthChip({ value: NaN, deltaWeek: 1, week: "2026-10-12", move: null }, "r"), null);
});

test("chip tone follows the alert first (severe, then warn), a called move second; absent alert says nothing", () => {
  const sev = healthChip({ value: 62, deltaWeek: 0, week: "w", move: "rise", alert: "severe", alertText: "severe: src/a.ts is 5,200 lines (good: under 1,000)" }, "r");
  assert.equal(sev.tone, "severe");
  assert.match(sev.title, /severe: src\/a\.ts is 5,200 lines/);
  assert.equal(healthChip({ value: 62, deltaWeek: 0, week: "w", move: null, alert: "warn" }, "r").tone, "warn");
  assert.equal(healthChip({ value: 90, deltaWeek: 0, week: "w", move: "rise", alert: null }, "r").tone, "calm");
  assert.equal(healthChip({ value: 90, deltaWeek: 0, week: "w", move: null }, "r").tone, null, "an older host's missing alert is not a verdict either way");
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
  assert.equal(flat.arrow, null, "a delta that rounds to 0 shows neither arrow nor number");
  assert.equal(flat.delta, null);
  const calledZero = healthChip({ value: 46, deltaWeek: 0, week: "w", move: "drop", alert: "severe" }, "r");
  assert.equal(calledZero.arrow, null);
  assert.equal(calledZero.delta, null);
  assert.equal(calledZero.tone, "severe");
  assert.match(drop.title, /Tap to open the readings/);
});

test("signed numbers use a real minus", () => {
  assert.equal(signedWhole(-3.2), "−3");
  assert.equal(signedWhole(0.2), "±0");
  assert.equal(signedTenths(-0.64), "−0.6");
  assert.equal(signedTenths(1.44), "+1.4");
});

test("line: a fixed 0-100 axis (no baseline pin), a gap breaks the run", () => {
  const pts = [
    { index: 100, gap: false }, { index: 104, gap: false }, { index: 104, gap: true }, { index: 98, gap: false },
  ];
  const g = indexLineGeom(pts, 300, 60);
  assert.deepEqual(g.rules.map((r) => r.v), [100, 50, 0]);
  assert.ok(g.rules[0].y < g.rules[1].y && g.rules[1].y < g.rules[2].y, "100 is at the top, 0 at the bottom");
  assert.equal((g.d.match(/M/g) ?? []).length, 2, "the carried week starts a new run");
  assert.equal(g.gaps, 1);
  assert.equal(g.pts.length, 4);
  assert.equal(g.endX, 300);
  // The axis is not fitted: the same score sits at the same height whatever else is plotted.
  const a = indexLineGeom([{ index: 40, gap: false }, { index: 42, gap: false }], 100, 40);
  const b = indexLineGeom([{ index: 40, gap: false }, { index: 90, gap: false }], 100, 40);
  assert.equal(a.pts[0].y, b.pts[0].y);
  assert.ok(a.pts[1].y > b.pts[1].y, "a higher score is drawn higher");
  assert.equal(indexLineGeom([], 100, 40), null);
  // A flat series does not produce NaN.
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

test("sentences name the first scored week and avoid verdict words", () => {
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
  const explain = indexExplainWords("2026-08-03", "waterplane");
  assert.match(explain, /first scored week, 2026-08-03/);
  assert.match(explain, /out of 100/);
  assert.match(explain, /within 30 of its worst entry/);
  assert.doesNotMatch(explain, /baseline|chained|carried|average change/i);
  // "score" and "good" are the intended words now; the rest stay banned.
  for (const word of ["grade", "healthy", "unhealthy", "bad", "should", "worse", "better"]) {
    assert.doesNotMatch(all, new RegExp(`\\b${word}\\b`, "i"), word);
  }
});

test("the explain sentence lists every fixed good value, pinned to shared's HEALTH_GOOD", async () => {
  const { HEALTH_GOOD, HEALTH_CONTEXT_GOOD_SHARE, HEALTH_SCORE_CAP_GAP, HEALTH_INDEX_DEFAULT_WARN_CHARS } = await import("@waterplane/shared");
  const n = (x) => x.toLocaleString("en-US");
  assert.match(HEALTH_GOOD_WORDS.size, new RegExp(`under ${HEALTH_GOOD.lineMean} lines.*under ${n(HEALTH_GOOD.max)}`));
  assert.match(HEALTH_GOOD_WORDS.retouch, new RegExp(`under ${Math.round(HEALTH_GOOD.retouch * 100)}%`));
  assert.match(HEALTH_GOOD_WORDS.hatches, new RegExp(`under ${HEALTH_GOOD.hatches} `));
  assert.match(HEALTH_GOOD_WORDS.untested, new RegExp(`under ${Math.round(HEALTH_GOOD.untested * 100)}%`));
  assert.match(HEALTH_GOOD_WORDS.context, new RegExp(`${n(HEALTH_CONTEXT_GOOD_SHARE * HEALTH_INDEX_DEFAULT_WARN_CHARS)} characters`));
  assert.match(indexExplainWords("w", "p"), new RegExp(`within ${HEALTH_SCORE_CAP_GAP} of its worst`));
});

test("the trend line: since the first scored week, then this week; a lone week has none", () => {
  const first = { index: 70, week: "2026-08-03" };
  assert.equal(trendWords(65, first, false, 0, "2026-10-12", "2026-10-12"), "−5 since 2026-08-03, ±0 this week");
  assert.equal(trendWords(65, first, false, null, "2026-10-05", "2026-10-12"), "−5 since 2026-08-03, no change to state in the week of 2026-10-05");
  assert.equal(trendWords(70, first, true, null), null);
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

test("the size entry says it blends the average line's file with the longest file", () => {
  assert.match(HEALTH_ENTRY_MEASURE.size, /line-weighted mean file length.*longest file/);
  assert.doesNotMatch(HEALTH_ENTRY_MEASURE.size, /percentile/);
});

test("weeks whose move is not compared say why; a link over silent weeks says how many", () => {
  assert.equal(carriedWords("central"), "move not compared: this repo changed which readings it overrides or disables that week");
  assert.match(carriedWords("prereg"), /definitions changed that week/);
  assert.match(carriedWords(undefined), /not compared with the week before/);
  assert.match(gapWords(1), /definition changed that week.*score is still measured/);
  assert.doesNotMatch(gapWords(2) + carriedWords("prereg"), /carried|not measured/);
  assert.equal(linkSpanWords(7), null);
  assert.equal(linkSpanWords(null), null);
  assert.equal(linkSpanWords(21), "one link over 3 weeks with no measured week between");
});

test("since baseline, vs a named week, and the tree's growth", () => {
  assert.equal(sinceBaselineWords(52.4, 40, "2026-08-03"), "+12 since 2026-08-03");
  assert.equal(indexVsWords({ delta: 18.2, then: { week: "2026-06-22" } }), "+18 vs week of 2026-06-22");
  assert.equal(indexVsWords(null), null);
  assert.equal(
    treeGrowthWords({ files: 100, loc: 10_000 }, { files: 150, loc: 9_000 }, "2026-08-03"),
    "The tree: 150 source files and 9,000 lines, against 100 and 10,000 in the first scored week 2026-08-03 (+50% files, −10% lines).");
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

test("a series from a host before the absolute score is recognised by the missing mean, never drawn as a score", async () => {
  const { olderHostSeries, olderHostWords } = await import("./healthIndexWords.ts");
  assert.equal(olderHostSeries([{ index: 100 }, { index: 96 }]), true);
  assert.equal(olderHostSeries([{ index: 70, mean: 72 }]), false);
  assert.equal(olderHostSeries([]), false);
  assert.equal(olderHostSeries(undefined), false);
  assert.match(olderHostWords("Acme"), /older Acme.*restart/);
});

// ── commits mode, the area, and the region's axis words ─────────────────────

import {
  areaD, indexCommitGeom, indexReadoutWords, thinnedWords, NAV_LABELS, SCRUB_HINT, axisModeWords,
  commitsAbsentWords, barsWeeksOnlyWords,
} from "./healthIndexWords.ts";

const cp = (sha7, day, week, index, gap = false) => ({ sha7, day, week, index, gap });
const commits = [
  cp("a000001", "2026-09-28", "2026-09-28", 40),
  cp("a000002", "2026-09-30", "2026-09-28", 42),
  cp("a000003", "2026-10-05", "2026-10-05", 44),
  cp("a000004", "2026-10-06", "2026-10-05", 50, true),
  cp("a000005", "2026-10-13", "2026-10-12", 52),
];

test("commit geometry: fixed 0–100 y, x by position, a gap starts a new run", () => {
  const g = indexCommitGeom(commits, 400, 101);
  assert.ok(g);
  assert.deepEqual(g.rules.map((r) => r.v), [100, 50, 0]);
  assert.equal(g.rules[0].y, 0.5);
  assert.equal(g.rules[2].y, 100.5);
  assert.deepEqual(g.pts.map((p) => p.x), [0, 100, 200, 300, 400]);
  assert.equal((g.d.match(/M/g) ?? []).length, 2, "cut at the gap point");
  assert.equal(g.dashed, "", "a commit series bridges nothing with dashes");
  assert.equal(g.endX, 400);
  assert.equal(g.gaps, 1);
});

test("commit geometry: a week rule at each new week's first point, the first week skipped", () => {
  const g = indexCommitGeom(commits, 400, 100);
  assert.deepEqual(g.weekRules, [{ x: 200, week: "2026-10-05" }, { x: 400, week: "2026-10-12" }]);
});

test("commit geometry: three day ticks at READING positions — first, middle, last", () => {
  const g = indexCommitGeom(commits, 400, 100);
  assert.deepEqual(g.ticks, [
    { x: 0, day: "2026-09-28", anchor: "start" },
    { x: 200, day: "2026-10-05", anchor: "middle" },
    { x: 400, day: "2026-10-13", anchor: "end" },
  ]);
  assert.equal(indexCommitGeom(commits.slice(0, 2), 400, 100).ticks.length, 2);
  assert.deepEqual(indexCommitGeom(commits.slice(0, 1), 400, 100).ticks, [{ x: 400, day: "2026-09-28", anchor: "end" }]);
  assert.equal(indexCommitGeom([], 400, 100), null);
  assert.equal(indexCommitGeom([cp("x", "d", "w", NaN)], 400, 100), null);
});

test("the area closes each solid run to the 0 rule; dots and dashes get none", () => {
  const g = indexCommitGeom(commits, 400, 101);
  const a = areaD(g);
  assert.equal((a.match(/Z/g) ?? []).length, 2);
  assert.match(a, /^M0\.0,100\.5L0\.0,[\d.]+L100\.0,[\d.]+L200\.0,[\d.]+L200\.0,100\.5Z/);
  assert.doesNotMatch(a, /NaN|LM/);
  const weeks = indexLineGeom([{ index: 50, gap: false }, { index: 60, gap: true }], 100, 50);
  assert.equal(areaD(weeks), "", "two lone dots: nothing to fill");
  assert.equal(areaD(indexLineGeom([{ index: 50, gap: false }, { index: 60, gap: false }], 100, 50)).split("Z").length, 2);
});

test("readout heads name the week or the commit, rounded", () => {
  assert.equal(indexReadoutWords("weeks", { week: "2026-09-28", index: 45.6 }), "Week of 2026-09-28: 46");
  assert.equal(indexReadoutWords("commits", { week: "2026-09-28", index: 46.2, sha7: "a1b2c3d", day: "2026-09-28" }), "Commit a1b2c3d, 2026-09-28: 46");
  assert.equal(indexReadoutWords("commits", { week: "2026-09-28", index: 46 }), "Week of 2026-09-28: 46", "no sha: say the week, never an empty commit");
});

test("thinning is said with both counts; nothing left out says nothing", () => {
  assert.equal(thinnedWords(142, 1526), "142 of 1,526 commits drawn");
  assert.equal(thinnedWords(30, 30), null);
});

test("the region's fixed words", () => {
  assert.deepEqual(Object.keys(NAV_LABELS), ["score", "longest", "tiles", "weight", "size", "table", "own"]);
  for (const v of Object.values(NAV_LABELS)) assert.ok(v.length <= 8, `${v} fits a chip`);
  assert.equal(SCRUB_HINT, "Drag across a chart to read a value.");
  assert.equal(axisModeWords("weeks"), "weeks: one point per week, its last reading");
  assert.match(axisModeWords("commits"), /^commits: /);
  assert.match(axisModeWords("commits"), /per day, its last commit/);
  assert.match(commitsAbsentWords("waterplane"), /older waterplane/);
  assert.match(barsWeeksOnlyWords("2026-10-12"), /per week.*week of 2026-10-12/);
});
