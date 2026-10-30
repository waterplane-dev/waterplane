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
