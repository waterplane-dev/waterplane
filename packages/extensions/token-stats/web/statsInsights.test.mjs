import test from "node:test";
import assert from "node:assert/strict";

import { statsInsights } from "./statsInsights.ts";

const cost = (cacheWrite, rest = 0) => ({ input: 0, output: 0, cacheRead: rest, cacheWrite, total: cacheWrite + rest });
const tot = (cacheRead, cacheWrite, turns = 0) => ({ input: 0, output: 0, cacheRead, cacheWrite, cacheWrite1h: 0, turns });
const NOW = new Date(2026, 8, 26, 12).getTime();
const day = (back, usd, turns) => {
  const d = new Date(NOW); d.setDate(d.getDate() - back);
  const p = (x) => String(x).padStart(2, "0");
  return { day: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`, ...tot(0, 0, turns), cost: cost(0, usd) };
};
const base = (over = {}) => ({
  totals: tot(960, 40), cost: cost(40, 60), subagentCost: cost(0), subagentLogs: 0,
  conversations: 100, days: [], models: [], repos: [], ...over,
});

test("cache writes: named when their share of money far outruns their tokens", () => {
  const w = statsInsights(base(), NOW).find((i) => i.id === "writes");
  assert.ok(w);
  assert.match(w.head, /4% of tokens, 40% of cost/);
  assert.ok(w.tryThis);
});

test("nothing priced is no insights, never a row of zeros", () => {
  assert.deepEqual(statsInsights(base({ cost: cost(0) }), NOW), []);
});

test("cold rebuilds appear only when they happened and matter", () => {
  assert.equal(statsInsights(base(), NOW).some((i) => i.id === "cold"), false);
  const i = statsInsights(base({ coldStarts: { count: 7, tok: 1, premiumUsd: 10 } }), NOW).find((x) => x.id === "cold");
  assert.match(i.head, /10%/);
  assert.match(i.body, /^7 requests/);
});

test("the trend compares per-request cost and is absent without two real weeks", () => {
  const days = [day(10, 10, 100), day(2, 30, 100)];
  const t = statsInsights(base({ days }), NOW).find((i) => i.id === "trend");
  assert.match(t.head, /200% more than the week before/);
  const thin = statsInsights(base({ days: [day(2, 30, 100)] }), NOW);
  assert.equal(thin.some((i) => i.id === "trend"), false);
});

test("concentration needs the top list, and says how many of how many", () => {
  const top = [0, 1, 2, 3, 4, 5].map((n) => ({ id: `c${n}`, cost: cost(0, 10) }));
  const c = statsInsights(base({ top }), NOW).find((i) => i.id === "concentration");
  assert.match(c.head, /^5 of 100 conversations are 50% of the cost/);
  assert.equal(statsInsights(base(), NOW).some((i) => i.id === "concentration"), false);
});

test("the model line names the model whose money outruns its tokens", () => {
  const models = [
    { key: "a", label: "opus", ...tot(500, 0), cost: cost(0, 80), priced: true },
    { key: "b", label: "haiku", ...tot(500, 0), cost: cost(0, 20), priced: true },
  ];
  const m = statsInsights(base({ totals: tot(1000, 0), cost: cost(0, 100), models }), NOW).find((i) => i.id === "model");
  assert.match(m.head, /^opus: 50% of tokens, 80% of cost/);
});

test("the week-on-week trend is absent where an undated record could fall in its fortnight (design round 4, r4-1 L1)", () => {
  const days = [day(10, 10, 100), day(2, 30, 100)];
  assert.equal(statsInsights(base({ days, undated: 3 }), NOW).some((i) => i.id === "trend"), false);
  const longAgo = NOW - 40 * 86_400_000;
  assert.ok(statsInsights(base({ days, undated: 3, undatedUntil: longAgo }), NOW).some((i) => i.id === "trend"), "every such log is older than the fortnight");
});

import { spanInsights, windowInput } from "./statsInsights.ts";

const win = (over = {}) => ({
  from: 0, to: 1, fromHour: 0, hours: [], convos: [], totals: tot(960, 40, 100), cost: cost(40, 60),
  agentTotals: tot(0, 0), agentCost: cost(0), unpriced: tot(0, 0), pricesAsOf: "", scannedAt: 0, ...over,
});

test("span insights read the span's fold, and say how each share moved on the span before", () => {
  const prev = windowInput(win({ cost: cost(25, 75) }));
  const w = spanInsights(windowInput(win()), prev, "the week before").find((i) => i.id === "writes");
  assert.match(w.head, /40% of cost/);
  assert.equal(w.delta, "Up 15 points on the week before (25%).");
});

test("with no span before, a span insight carries no delta and no trend", () => {
  const out = spanInsights(windowInput(win()), null, "");
  assert.ok(out.find((i) => i.id === "writes"));
  assert.equal(out.some((i) => i.delta), false);
  assert.equal(out.some((i) => i.id === "trend"), false);
});

test("the span's trend compares per-request cost against the span before", () => {
  const prev = windowInput(win({ totals: tot(960, 40, 100), cost: cost(20, 30) }));
  const t = spanInsights(windowInput(win()), prev, "the 30 days before").find((i) => i.id === "trend");
  assert.match(t.head, /100% more than the 30 days before/);
});

test("a span never names re-caching after breaks — its fold does not measure it", () => {
  assert.equal(windowInput(win()).cold, null);
});

test("a span's model mix is summed over its hours and drops unpriced models", () => {
  const h = (model, t, u) => ({ model, totals: tot(t, 0), cost: cost(0, u) });
  const x = windowInput(win({ hours: [{ hour: "", t: 0, totals: tot(0, 0), cost: cost(0), byRepo: [], byModel: [h("opus", 300, 50), h("free", 10, 0)] },
    { hour: "", t: 0, totals: tot(0, 0), cost: cost(0), byRepo: [], byModel: [h("opus", 200, 30)] }] }), new Set(["free"]));
  assert.deepEqual(x.models, [{ label: "opus", tok: 500, usd: 80 }]);
});
