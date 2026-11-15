/**
 * The score-over-time chart's geometry and words (`historyPlot.ts`, read straight off the TypeScript).
 *
 *     node --test packages/extensions/scorecard/web/historyPlot.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { absentWords, changes, geom, pickIndex, readout, spanWords } from "./historyPlot.ts";

const pt = (date, score, checks = {}, commit = "1234567890") => ({ date, score, checks, commit });
const P = [pt("2026-10-20T00:00:00Z", 5, { A: 0, B: 10 }), pt("2026-10-22T00:00:00Z", 6, { A: 5, B: 10 }), pt("2026-10-26T00:00:00Z", 6, { A: 5, B: 10 })];

test("the y axis is fixed 0–10, never fitted to the data", () => {
  const g = geom(P, 300);
  assert.deepEqual(g.rules.map((r) => r.v), [0, 5, 10]);
  const g2 = geom([pt("2026-10-20T00:00:00Z", 7.4), pt("2026-10-21T00:00:00Z", 7.7)], 300);
  assert.ok(Math.abs(g2.pts[0].y - g2.pts[1].y) < 5, "a 0.3 move stays small");
});

test("one point is a sentence, not a line; none says so", () => {
  assert.equal(geom(P.slice(0, 1), 300), null);
  assert.match(absentWords(1, false, P[0]), /a line needs two/);
  assert.match(absentWords(0, true), /Reading past runs back/);
  assert.equal(absentWords(3, false), null);
});

test("x is reading order; dates at three positions; the pick snaps to a drawn run", () => {
  const g = geom(P, 300);
  assert.deepEqual(g.ticks.map((t) => t.label), ["10-20", "10-22", "10-26"]);
  assert.equal(pickIndex(g, 0), 0);
  assert.equal(pickIndex(g, 1000), 2);
});

test("the readout names what moved since the run before", () => {
  assert.deepEqual(changes(P[0], P[1]), ["A 0→5"]);
  assert.match(readout(P, 1).moved, /^\+1 since 2026-10-20: A 0→5$/);
  assert.match(readout(P, 2).moved, /no check changed/);
  assert.equal(readout(P, 0).head, "2026-10-20 · 5/10 · 1234567");
  assert.equal(spanWords(3, false), "3 runs");
  assert.match(spanWords(3, true), /scored locally/);
  const same = [pt("2026-10-30T10:00:00Z", 6.8, {}, "aaaaaaa111"), pt("2026-10-30T20:00:00Z", 6.9, {}, "bbbbbbb222")];
  assert.match(readout(same, 1).moved, /^\+0\.1 since the run before \(aaaaaaa\)/);
});
