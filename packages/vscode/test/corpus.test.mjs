// The all-sessions overview: the store over the fixture config dir, folded,
// equal to the host's own `foldCostWindow` over all time to the cent.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { FIXTURES, data, pick, tmp } from "./helpers.mjs";

const NOW = Date.UTC(2026, 9, 11);
const tokenTotal = (t) => t.input + t.output + t.cacheRead + t.cacheWrite;

async function scanned() {
  const store = new data.TokenStore(join(tmp("store"), "tokenstore.v5.json"));
  await store.load();
  await store.refresh(FIXTURES);
  return store;
}

test("fold totals, cost and unpriced equal foldCostWindow over all time", async () => {
  const store = await scanned();
  const doc = data.foldCorpus(store.files, NOW, store.stats);
  const win = data.foldCostWindow(store.files, 0, Number.MAX_SAFE_INTEGER, { byConv: new Map() }, NOW);
  assert.deepEqual(pick(doc.totals), pick(win.totals));
  assert.deepEqual(pick(doc.unpriced), pick(win.unpriced));
  assert.ok(doc.cost.total > 0);
  assert.equal(Math.round(doc.cost.total * 100), Math.round(win.cost.total * 100));
  assert.ok(Math.abs(doc.cost.total - win.cost.total) < 1e-9);
  assert.deepEqual(pick(doc.subagents), pick(win.agentTotals));
  assert.ok(Math.abs(doc.subagentCost.total - win.agentCost.total) < 1e-9);
});

test("subagent file is counted in subagents and in the totals; one conversation", async () => {
  const store = await scanned();
  const doc = data.foldCorpus(store.files, NOW, store.stats);
  assert.equal(doc.conversations, 1);
  assert.equal(doc.subagentLogs, 1);
  assert.equal(doc.logs, 2);
  assert.equal(doc.subagents.turns, 2);
  assert.equal(doc.totals.turns, 8, "6 parent requests + 2 agent requests");
  assert.equal(doc.top.length, 1);
  assert.equal(doc.top[0].agents, 1);
  assert.equal(doc.top[0].repo, "/Users/x/repo");
  assert.equal(doc.repos[0].label, "repo");
  assert.ok(doc.models.some((m) => m.label === "claude-haiku-4-5"), "dated id labelled by its alias");
});

test("days ascend and each day's byModel sums to the day", async () => {
  const store = await scanned();
  const doc = data.foldCorpus(store.files, NOW, store.stats);
  assert.ok(doc.days.length >= 1);
  for (let i = 1; i < doc.days.length; i++) assert.ok(doc.days[i - 1].day < doc.days[i].day);
  for (const d of doc.days) {
    const tok = d.byModel.reduce((n, s) => n + tokenTotal(s.totals), 0);
    const usd = d.byModel.reduce((n, s) => n + s.cost.total, 0);
    assert.equal(tok, tokenTotal(d));
    assert.ok(Math.abs(usd - d.cost.total) < 1e-9);
  }
  assert.equal(doc.days.reduce((n, d) => n + tokenTotal(d), 0), tokenTotal(doc.totals));
  assert.equal(typeof doc.firstAt, "number");
  assert.ok(doc.lastAt >= doc.firstAt);
  assert.ok(doc.pricesAsOf);
});

test("store: cache round-trips, an unchanged log is not re-read, a missing projects dir is an empty store", async () => {
  const file = join(tmp("cache"), "nested", "tokenstore.v5.json");
  const a = new data.TokenStore(file);
  const first = await a.refresh(FIXTURES);
  assert.equal(first.reread, 2);
  await a.save();
  const b = new data.TokenStore(file);
  await b.load();
  assert.deepEqual(b.files, a.files);
  const progress = [];
  const again = await b.refresh(FIXTURES, (done, total) => progress.push([done, total]));
  assert.equal(again.reread, 0);
  assert.equal(again.logs, 2);
  assert.deepEqual(progress.at(-1), [2, 2]);
  const empty = await b.refresh(tmp("noprojects"));
  assert.equal(empty.logs, 0);
  assert.deepEqual(b.files, {});
});

test("hours: within the window they sum to the day, the clock folds every hour, hoursFrom is the first row's midnight", async () => {
  const store = await scanned();
  const doc = data.foldCorpus(store.files, NOW, store.stats);
  assert.equal(doc.hourOfDay.length, 24);
  doc.hourOfDay.forEach((s, i) => assert.equal(s.hour, i));
  assert.equal(doc.hourOfDay.reduce((n, s) => n + tokenTotal(s), 0), tokenTotal(doc.totals), "the clock folds every dated record");
  assert.ok(Math.abs(doc.hourOfDay.reduce((n, s) => n + s.cost.total, 0) - doc.cost.total) < 1e-9);
  // Fixture records are on Oct 1; NOW is Oct 11, inside the 14-day window.
  assert.ok(doc.hours.length >= 1);
  for (let i = 1; i < doc.hours.length; i++) assert.ok(doc.hours[i - 1].hour < doc.hours[i].hour);
  for (const d of doc.days) {
    const hs = doc.hours.filter((h) => h.hour.slice(0, 10) === d.day);
    assert.equal(hs.reduce((n, h) => n + tokenTotal(h), 0), tokenTotal(d), `hours of ${d.day} sum to the day`);
    assert.ok(Math.abs(hs.reduce((n, h) => n + h.cost.total, 0) - d.cost.total) < 1e-9);
  }
  for (const h of doc.hours) {
    assert.equal(h.byModel.reduce((n, s) => n + tokenTotal(s.totals), 0), tokenTotal(h));
  }
  const [y, m, d] = doc.hours[0].hour.slice(0, 10).split("-").map(Number);
  assert.equal(doc.hoursFrom, new Date(y, m - 1, d).getTime());
});

test("hours: rows older than the window are cut (hoursFrom null), the clock still holds them", async () => {
  const store = await scanned();
  const later = NOW + 60 * 86_400_000;
  const doc = data.foldCorpus(store.files, later, store.stats);
  assert.deepEqual(doc.hours, []);
  assert.equal(doc.hoursFrom, null);
  assert.equal(doc.hourOfDay.reduce((n, s) => n + tokenTotal(s), 0), tokenTotal(doc.totals));
});

test("week: foldCostWindow over the last seven calendar days — the fixture's day inside it, then outside", async () => {
  const store = await scanned();
  const near = Date.UTC(2026, 9, 4);
  const doc = data.foldCorpus(store.files, near, store.stats);
  const midnight = new Date(near);
  midnight.setHours(0, 0, 0, 0);
  midnight.setDate(midnight.getDate() - 6);
  assert.equal(doc.week.fromHour, midnight.getTime(), "local midnight six days back: the headline's span");
  assert.deepEqual(pick(doc.week.totals), pick(doc.totals), "everything ran within the week");
  assert.equal(doc.week.convos.length, 1);
  const far = data.foldCorpus(store.files, NOW, store.stats);
  assert.equal(tokenTotal(far.week.totals), 0, "Oct 1 is outside the seven days before Oct 11");
  assert.equal(far.week.convos.length, 0);
});

test("spans: the span filter's 30 and 90 calendar days, each folded from local midnight n-1 days back", async () => {
  const store = await scanned();
  const doc = data.foldCorpus(store.files, NOW, store.stats);
  for (const n of [30, 90]) {
    const from = new Date(NOW);
    from.setHours(0, 0, 0, 0);
    from.setDate(from.getDate() - (n - 1));
    // `docFor` matches on `from` exactly — the webview cuts its span at the same midnight.
    assert.equal(doc.spans[n].from, from.getTime(), `${n} days: span.ts' calendarFrom`);
    assert.deepEqual(pick(doc.spans[n].totals), pick(doc.totals), `${n} days hold the fixture's Oct 1`);
  }
  const later = data.foldCorpus(store.files, Date.UTC(2027, 1, 1), store.stats);
  assert.equal(tokenTotal(later.spans[90].totals), 0, "Oct 1 is outside the 90 days before Feb 1");
});
