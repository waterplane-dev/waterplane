// The startup summary: folded from a finished scan's corpus, equal to the headline's week, and
// absent (never $0) when nothing was priced.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { FIXTURES, data, tmp } from "./helpers.mjs";

const NOW = Date.UTC(2026, 9, 11);

async function corpus() {
  const store = new data.TokenStore(join(tmp("summary"), "tokenstore.v5.json"));
  await store.load();
  await store.refresh(FIXTURES);
  return data.foldCorpus(store.files, NOW, store.stats);
}

test("the week total and cost are the headline's, and the repos add up to no more than the week", async () => {
  const doc = await corpus();
  const s = data.summaryOf(doc, "/cfg");
  assert.equal(s.v, 1);
  assert.equal(s.configDir, "/cfg");
  assert.equal(s.scannedAt, doc.scannedAt);
  assert.equal(s.conversations, doc.conversations);
  assert.equal(s.allCost.total, doc.cost.total);
  assert.equal(s.week.days.length, 7);
  // The headline the All sessions view prints over the same days, compared field for field.
  const h = data.headline(doc.days, doc.scannedAt);
  assert.ok(h, "the fixture has days");
  assert.equal(s.week.total, h.total);
  assert.deepEqual(s.week.split, h.split);
  assert.equal(s.week.requests, h.split.turns);
  assert.deepEqual(s.week.days, h.days);
  if (h.cost.total > 0) assert.deepEqual(s.week.cost, h.cost); else assert.equal(s.week.cost, null);
  const repoUsd = s.weekByRepo.reduce((n, r) => n + r.usd, 0);
  if (s.week.cost) assert.ok(repoUsd <= s.week.cost.total + 1e-9);
  assert.ok(s.weekByRepo.every((r, i, a) => i === 0 || a[i - 1].usd >= r.usd), "dearest first");
});

test("thisRepoWeek matches the exact repo key, sums keys, and is null for none", () => {
  const s = { v: 1, configDir: "", scannedAt: 0, conversations: 1, allCost: null,
    week: { total: 0, split: {}, cost: null, requests: 0, days: [] },
    weekByRepo: [{ repo: "/a/repo", usd: 2, tok: 10 }, { repo: "/b/other", usd: 3, tok: 5 }] };
  assert.deepEqual(data.thisRepoWeek(s, ["/a/repo"]), { usd: 2, tok: 10 });
  assert.deepEqual(data.thisRepoWeek(s, ["/a/repo", "/b/other"]), { usd: 5, tok: 15 });
  assert.equal(data.thisRepoWeek(s, ["/a/repo/sub"]), null, "no prefix matching");
  assert.equal(data.thisRepoWeek(s, []), null);
});

test("nothing priced: cost is null, never $0", async () => {
  const doc = await corpus();
  const bare = { ...doc, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    days: doc.days.map((d) => ({ ...d, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, byRepo: d.byRepo.map((r) => ({ ...r, pricedTurns: 0, usd: 0 })) })) };
  const s = data.summaryOf(bare, "/cfg");
  assert.equal(s.allCost, null);
  assert.equal(s.week.cost, null);
  assert.deepEqual(s.weekByRepo, []);
  assert.equal(data.thisRepoWeek(s, ["/Users/x/repo"]), null);
});

const DAY = 86_400_000;
const week = (over) => ({ v: 1, configDir: "", scannedAt: NOW, conversations: 1, allCost: null,
  week: { total: 0, split: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, turns: 0 }, cost: null, requests: 0, days: [] },
  weekByRepo: [], ...over });

test("weekFigure: dollars when priced, tokens when not, null (never $0) when the week is empty", () => {
  const cost = { input: 1.2, output: 3.4, cacheRead: 0.5, cacheWrite: 0.9, total: 6 };
  assert.equal(data.weekFigure(week({ week: { ...week().week, total: 10, cost } })), "$6.00");
  assert.equal(data.weekFigure(week({ week: { ...week().week, total: 12_000 } })), "12k tokens");
  assert.equal(data.weekFigure(week()), null);
});

test("weekSplit: the four kinds in dollars, or in tokens when nothing was priced", () => {
  const cost = { input: 1.2, output: 3.4, cacheRead: 0.5, cacheWrite: 0.9, total: 6 };
  assert.equal(data.weekSplit(week({ week: { ...week().week, cost } })), "input $1.20 · output $3.40 · cache read $0.50 · cache write $0.90");
  const split = { input: 1000, output: 2000, cacheRead: 3000, cacheWrite: 4000, cacheWrite1h: 0, turns: 2 };
  assert.equal(data.weekSplit(week({ week: { ...week().week, total: 10_000, split } })), "input 1k · output 2k · cache read 3k · cache write 4k tokens");
});

test("currentSummary: a scan more than seven days old is absent, not a stale 'last 7 days'", () => {
  const s = week();
  assert.equal(data.currentSummary(s, NOW + 3 * DAY), s);
  assert.equal(data.currentSummary(s, NOW + 7 * DAY), s);
  assert.equal(data.currentSummary(s, NOW + 7 * DAY + 1), null);
  assert.equal(data.currentSummary(null, NOW), null);
});
