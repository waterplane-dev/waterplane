import test from "node:test";
import assert from "node:assert/strict";
import { firstRequestWords, headline, headlineDaysWords, headlineSpan, headlineSpanWords } from "./headline.ts";

const C = (usd) => ({ input: usd / 4, output: usd / 4, cacheRead: usd / 4, cacheWrite: usd / 4, total: usd });
const D = (day, n, usd) => ({ day, input: n, output: n, cacheRead: n * 10, cacheWrite: n, cacheWrite1h: 0, turns: 1, cost: C(usd) });
const NOW = new Date(2026, 9, 2, 15, 0).getTime(); // Fri 2 Oct 2026, local

test("the span is seven calendar days ending today, oldest first", () => {
  const s = headlineSpan(NOW);
  assert.equal(s.length, 7);
  assert.equal(s[0].day, "2026-09-26");
  assert.equal(s[6].day, "2026-10-02");
});

test("the total IS the sum of its split, and the money is summed with it", () => {
  const h = headline([D("2026-09-01", 5, 9), D("2026-09-28", 1, 2), D("2026-10-02", 2, 3)], NOW);
  assert.equal(h.total, 13 + 26, "two days in the span, the September 1 day outside it");
  assert.equal(h.total, h.split.input + h.split.output + h.split.cacheRead + h.split.cacheWrite);
  assert.equal(h.cost.total, 5);
  assert.equal(h.active, 2);
  assert.equal(h.peak, 26);
  assert.equal(h.days.find((d) => d.day === "2026-09-29").tok, 0, "a day inside the record with no turns is a measured zero");
});

test("before the record begins a day is unknown, never zero, and the caption says so", () => {
  const h = headline([D("2026-09-30", 1, 1)], NOW);
  assert.equal(h.days[0].tok, null);
  assert.equal(h.days[4].tok, 13);
  assert.match(headlineSpanWords(h), /the 3 days on record, out of the last 7/);
  // The one line drawn in the open names the absence itself: the span sentence folds.
  assert.equal(headlineDaysWords(h), "3 of the last 7 days on record, 1 with work in them · busiest day 13");
});

test("the line under the split is the days and the busiest one — the span and the money fold", () => {
  const h = headline([D("2026-09-20", 1, 1), D("2026-09-28", 1, 2), D("2026-10-02", 2, 3)], NOW);
  assert.equal(headlineDaysWords(h), "2 of 7 days with work in them · busiest day 26");
  assert.doesNotMatch(headlineDaysWords(h), /bill|list price|today included/);
});

test("no days at all is no headline (the screen's Empty speaks), not a zero", () => {
  assert.equal(headline([], NOW), null);
});

test("first request words appear only for a measured figure", () => {
  assert.equal(firstRequestWords(undefined), null);
  assert.equal(firstRequestWords(0), null);
  assert.match(firstRequestWords(61000), /^first request 61.*tokens$/);
});
