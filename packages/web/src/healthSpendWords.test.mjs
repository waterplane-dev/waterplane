/** The tokens-per-request line beside the health score, pure (`node --test`). */
import test from "node:test";
import assert from "node:assert/strict";
import { healthSpendWeeks } from "@waterplane/shared";
import { ctxPerRequest, SPEND_STEP_WORDS, spendCoverageWords, spendLeadWords, spendLineGeom, spendReadoutWords, spendStepGeom } from "./healthSpendWords.ts";

const weeks = [{ week: "2026-09-28" }, { week: "2026-10-05" }, { week: "2026-10-12" }];

test("the host fold is a ratio of SUMS per ISO week, one repo only, older rows skipped", () => {
  const days = [
    { day: "2026-10-05", byRepo: [{ repo: "/r", turns: 1, ctxTok: 100 }, { repo: "/other", turns: 9, ctxTok: 9 }] },
    { day: "2026-10-07", byRepo: [{ repo: "/r", turns: 3, ctxTok: 900 }] },
    { day: "2026-10-12", byRepo: [{ repo: "/r", turns: 2 }] }, // an older host: no ctxTok
  ];
  const w = healthSpendWeeks(days, ["/r"]);
  assert.deepEqual(w, [{ week: "2026-10-05", requests: 4, ctxTok: 1000 }]);
  assert.equal(ctxPerRequest(w[0]), 250);
  assert.equal(ctxPerRequest({ requests: 0, ctxTok: 0 }), null);
});

test("a week the ledger lacks is a HOLE that cuts the line, never a zero", () => {
  const g = spendLineGeom(weeks, [
    { week: "2026-09-28", requests: 1, ctxTok: 50_000 },
    { week: "2026-10-12", requests: 2, ctxTok: 200_000 },
  ], 200, 100);
  assert.ok(g);
  assert.deepEqual(g.vals, [50_000, null, 100_000]);
  assert.equal(g.d, "");
  assert.equal(g.dots.length, 2);
  assert.equal(g.lo, 50_000);
  assert.equal(g.hi, 100_000);
  assert.ok(g.hiY < g.loY);
});

test("a flat line sits at mid-height, with no NaN", () => {
  const g = spendLineGeom(weeks.slice(0, 2), weeks.slice(0, 2).map((w) => ({ week: w.week, requests: 1, ctxTok: 10 })), 100, 80);
  assert.ok(g?.flat);
  assert.equal(g.hiY, 40);
  assert.doesNotMatch(g.d, /NaN/);
});

test("absent stays absent: no field, no line and no sentence; empty is said", () => {
  assert.equal(spendLineGeom(weeks, undefined, 100, 80), null);
  assert.equal(spendCoverageWords(null, weeks, undefined), null);
  assert.match(spendCoverageWords(null, weeks, []), /no tokens-per-request line/);
  const late = spendLineGeom(weeks, [{ week: "2026-10-05", requests: 1, ctxTok: 1 }], 100, 80);
  assert.match(spendCoverageWords(late, weeks, []), /from the week of 2026-10-05/);
  assert.equal(spendReadoutWords(null), "no Claude request on record");
  assert.equal(spendReadoutWords(84_200), "84k tokens per Claude request");
});

test("the lead is ONE sentence naming money AND wait; the rest folds", () => {
  const { lead, more } = spendLeadWords(25_957);
  assert.equal(lead, "Dotted line: tokens each Claude request here re-sent — paid in money and in wait time.");
  assert.equal(lead.split(/\.\s/).length, 1, "one sentence");
  assert.match(more, /CLAUDE\.md \+ skill descriptions \(25,957 chars now\) is in every request/);
  assert.match(more, /only when the agent opens those files/);
  assert.doesNotMatch(spendLeadWords(null).more, /chars now/);
});

const pts = [
  { week: "2026-09-28" }, { week: "2026-09-28" },
  { week: "2026-10-05" },
  { week: "2026-10-12" }, { week: "2026-10-12" },
];

test("commit steps: one value per week, flat across its commits, vertical halfway to the next week", () => {
  const g = spendStepGeom(pts.slice(0, 3), [
    { week: "2026-09-28", requests: 1, ctxTok: 100 },
    { week: "2026-10-05", requests: 1, ctxTok: 200 },
  ], 200, 100);
  assert.ok(g);
  assert.deepEqual(g.vals, [100, 100, 200]);
  // x = 0, 100, 200; the week changes between 100 and 200 → vertical at 150.
  assert.equal(g.d, `M0.0,${g.loY.toFixed(1)}H150.0V${g.hiY.toFixed(1)}H200.0`);
  assert.match(g.d, /^M[^L]*$/, "steps only — no diagonal");
  assert.equal(g.dots.length, 0);
  assert.equal(SPEND_STEP_WORDS, "one value per week, drawn across that week's commits");
});

test("commit steps: a week without a ledger row is a HOLE; a lone point is a dot; same fit as the week line", () => {
  const spend = [
    { week: "2026-09-28", requests: 1, ctxTok: 50_000 },
    { week: "2026-10-12", requests: 2, ctxTok: 200_000 },
  ];
  const g = spendStepGeom(pts, spend, 400, 100);
  assert.deepEqual(g.vals, [50_000, 50_000, null, 100_000, 100_000]);
  assert.equal((g.d.match(/M/g) ?? []).length, 2, "two runs, cut at the hole");
  assert.equal(g.dots.length, 0);
  const wk = spendLineGeom([{ week: "2026-09-28" }, { week: "2026-10-12" }], spend, 400, 100);
  assert.equal(g.hiY, wk.hiY);
  assert.equal(g.loY, wk.loY);
  assert.equal(g.firstWeek, "2026-09-28");
  const lone = spendStepGeom([{ week: "2026-09-28" }, { week: "2026-10-05" }], spend, 100, 80);
  assert.equal(lone.d, "");
  assert.equal(lone.dots.length, 1);
  assert.equal(spendStepGeom(pts, undefined, 100, 80), null);
  assert.equal(spendStepGeom(pts, [], 100, 80), null);
  assert.doesNotMatch(spendStepGeom(pts.slice(0, 2), spend, 100, 80).d, /NaN/, "flat sits at mid-height");
});
