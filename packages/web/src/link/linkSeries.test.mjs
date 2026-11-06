/**
 * The connection history's maths: binning, drops, route moves.
 *
 *     node --test packages/web/src/link/linkSeries.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { RANGES, binDown, binSeries, blankMinute, dropsOf, lostShare, pingCeiling, routeChanges, spanText, sumBins } from "./linkSeries.ts";

const T = 29_000_000; // an epoch minute
const NOW = T * 60_000 + 30_000;
const row = (dt, o = {}) => ({ ...blankMinute(T + dt), ...o });
const range = (id) => RANGES.find((r) => r.id === id);

test("every range covers its span in whole bins, and the newest bin holds now", () => {
  for (const r of RANGES) {
    const bins = binSeries([], r, NOW);
    assert.equal(bins.length, r.spanMin / r.binMin);
    assert.ok(bins.at(-1).from <= NOW && NOW < bins.at(-1).to);
  }
});

test("a minute with no row is not measured, never a zero reading", () => {
  const bins = binSeries([row(-2, { ok: 20, med: 30, worst: 50 })], range("1h"), NOW);
  assert.equal(bins.at(-3).measured, 1);
  const gap = bins.at(-2);
  assert.equal(gap.measured, 0);
  assert.equal(gap.med, null);
  assert.equal(gap.worst, null);
});

test("a row outside the range is left out", () => {
  assert.equal(sumBins(binSeries([row(-61, { ok: 5 })], range("1h"), NOW)).probes, 0);
});

test("a bin sums bytes by source, takes the worst ping and the median of minute medians", () => {
  const rows = [
    row(0, { ok: 1, med: 10, worst: 900, ds: 5, dr: 7, dp: 11 }),
    row(-1, { ok: 1, med: 20, worst: 30, ds: 1 }),
    row(-2, { ok: 1, med: 400, worst: 400 }),
  ];
  const bins = binSeries(rows, { id: "x", spanMin: 60, binMin: 60 }, NOW);
  const b = bins.find((x) => x.measured);
  assert.equal(b.med, 20);
  assert.equal(b.worst, 900);
  assert.deepEqual(b.down, { socket: 6, request: 7, page: 11 });
  assert.equal(binDown(b), 24);
});

test("lost share counts misses and no-socket probes over everything asked", () => {
  const [b] = binSeries([row(0, { ok: 2, miss: 1, off: 1 })], range("1h"), NOW).slice(-1);
  assert.equal(lostShare(b), 0.5);
});

test("adjacent no-socket minutes are one drop, newest first, timed by what was seen", () => {
  const rows = [row(0, { off: 4 }), row(-1, { off: 20 }), row(-2, { ok: 20 }), row(-5, { off: 1 })];
  const d = dropsOf(rows);
  assert.equal(d.length, 2);
  assert.equal(d[0].from, (T - 1) * 60_000);
  assert.equal(d[0].to, (T + 1) * 60_000);
  assert.equal(d[0].offSec, 72);
  assert.equal(d[1].offSec, 3);
});

test("a minute out of sight ends a drop rather than being counted into it", () => {
  assert.equal(dropsOf([row(0, { off: 2 }), row(-30, { off: 2 })]).length, 2);
});

test("route moves are the changes only, across a gap too, and unknown is not a move", () => {
  const rows = [row(-9, { rt: "tailnet" }), row(-8, { rt: "tailnet" }), row(-7), row(-3, { rt: "lan" }), row(0, { rt: "tailnet" })];
  assert.deepEqual(routeChanges(rows).map((c) => c.to), ["tailnet", "lan"]);
});

test("the ping ceiling keeps its floor and survives one awful bin", () => {
  assert.equal(pingCeiling([]), 200);
  const bins = binSeries([...Array(40)].map((_, i) => row(-i, { ok: 1, med: 20, worst: 40 })).concat(row(-41, { ok: 1, med: 9000, worst: 9000 })), range("1h"), NOW);
  assert.equal(pingCeiling(bins), 200);
});

test("a length of time reads in the two units that matter", () => {
  assert.equal(spanText(45), "45 s");
  assert.equal(spanText(192), "3m 12s");
  assert.equal(spanText(3900), "1h 5m");
  assert.equal(spanText(200_000), "2d 7h");
});
