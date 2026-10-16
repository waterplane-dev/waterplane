// The demo's token ledger: one set of synthetic records, every figure a fold of it. These pin the
// identities the real host's `aggregate()` holds, so a number that looks wrong cannot ship.
import test from "node:test";
import assert from "node:assert/strict";
import { addCost, addTotals, costOf, tokenTotal, zeroCost, zeroTotals } from "@waterplane/shared";
import { demoCostWindow, demoTokenStats, demoTokenWindows, demoTopConvos, demoUsageLog, parseWindowSpecs, windowCells } from "./ledger.ts";
import { demoHttp } from "./demohttp.ts";

const NOW = new Date(2026, 9, 2, 15, 20).getTime();
const HOUR = 3_600_000;
const KINDS = ["input", "output", "cacheRead", "cacheWrite", "cacheWrite1h", "turns"];
const sumT = (xs) => xs.reduce((a, x) => addTotals(a, x), zeroTotals());
const sumC = (xs) => xs.reduce((a, x) => addCost(a, x), zeroCost());
const near = (a, b, msg) => assert.ok(Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a), Math.abs(b)), `${msg}: ${a} vs ${b}`);
const sameT = (a, b, msg) => { for (const k of KINDS) assert.equal(a[k], b[k], `${msg}: ${k}`); };
const sameC = (a, b, msg) => { for (const k of Object.keys(zeroCost())) near(a[k], b[k], `${msg}: ${k}`); };
const finite = (v, path = "") => {
  if (typeof v === "number") assert.ok(Number.isFinite(v) && v >= 0, `${path} = ${v}`);
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) finite(x, `${path}.${k}`);
};
const hourMs = (h) => new Date(`${h.slice(0, 10)}T${h.slice(11)}:00`).getTime();

test("deterministic: the same hour gives the same document, whatever the minute", () => {
  const a = JSON.stringify({ ...demoTokenStats(NOW), scannedAt: 0 });
  const b = JSON.stringify({ ...demoTokenStats(NOW + 7 * 60_000), scannedAt: 0 });
  assert.equal(a, b);
  assert.notEqual(a, JSON.stringify({ ...demoTokenStats(NOW + 30 * 24 * HOUR), scannedAt: 0 }));
});

test("shape: a fortnight of heavy use — hundreds of conversations, long ones and their agents carrying the bill", () => {
  const d = demoTokenStats(NOW);
  assert.ok(d.days.length >= 12 && d.days.length <= 14, `days ${d.days.length}`);
  assert.ok(d.conversations >= 200 && d.conversations <= 400, `conversations ${d.conversations}`);
  assert.ok(d.subagentLogs > 200 && tokenTotal(d.subagents) > 0);
  assert.ok(d.coldStarts.count > 50 && d.coldStarts.premiumUsd > 0);
  assert.ok(d.fastTurns > 0);
  assert.equal(d.top.length, 12, "the host's TOP_CONVOS");
  // The shapes of real heavy use, which are what the insights are about (the magnitudes are a
  // measured desktop's, scaled to a fortnight): reads dwarf output, writes are a sliver of the tokens
  // and a large share of the money, agents and expired caches are visible, a few conversations lead.
  assert.ok(d.totals.cacheRead > 0.95 * tokenTotal(d.totals), "cache reads dominate, as in real use");
  assert.ok(d.totals.cacheRead > 300 * d.totals.output, "reads dwarf output");
  assert.ok(d.cost.total > 3_000 && d.cost.total < 10_000, `a heavy fortnight at list price: ${d.cost.total}`);
  assert.ok(d.cost.cacheWrite > 0.2 * d.cost.total && d.totals.cacheWrite < 0.05 * tokenTotal(d.totals), "writes: few tokens, much money");
  assert.ok(d.subagentCost.total > 0.25 * d.cost.total, "agents are a large share");
  assert.ok(d.coldStarts.premiumUsd > 0.03 * d.cost.total, "the cold-start premium is visible");
  assert.ok(d.top[0].cost.total > 0.08 * d.cost.total, "one conversation is a big slice of the fortnight");
  assert.ok(d.top[0].agentCost.total > 0.5 * d.top[0].cost.total, "and most of it was its agents");
  assert.ok(d.models.every((m) => m.priced));
  assert.equal(d.unpriced.turns, 0);
  assert.equal(d.hourOfDay.length, 24);
  for (const day of d.days) assert.ok(day.byModel.length && day.byRepo.length && Array.isArray(day.agents));
  const dow = (s) => new Date(`${s}T12:00`).getDay();
  const weekday = d.days.filter((x) => dow(x.day) % 6 !== 0);
  const weekend = d.days.filter((x) => dow(x.day) % 6 === 0);
  const mean = (xs) => xs.reduce((a, x) => a + tokenTotal(x), 0) / Math.max(1, xs.length);
  assert.ok(mean(weekday) > mean(weekend), "weekday-heavy");
  assert.ok(demoTopConvos(NOW).every((x) => x.title && x.title !== x.convo.label));
});

test("identities: totals == days == models == repos == hourOfDay == hours, cost likewise", () => {
  const d = demoTokenStats(NOW);
  for (const [name, rows] of [["days", d.days], ["hours", d.hours], ["hourOfDay", d.hourOfDay], ["models", d.models], ["repos", d.repos]]) {
    sameT(sumT(rows), d.totals, name);
    sameC(sumC(rows.map((r) => r.cost)), d.cost, name);
  }
  assert.equal(d.hoursFrom, new Date(`${d.hours[0].hour.slice(0, 10)}T00:00`).getTime());
  for (const day of d.days) {
    sameT(sumT(day.byModel.map((x) => x.totals)), day, `byModel ${day.day}`);
    sameC(sumC(day.byModel.map((x) => x.cost)), day.cost, `byModel cost ${day.day}`);
    assert.equal(day.byRepo.reduce((a, r) => a + r.turns, 0), day.turns);
    assert.equal(day.byRepo.reduce((a, r) => a + r.pricedTurns, 0), day.turns);
    near(day.byRepo.reduce((a, r) => a + r.usd, 0), day.cost.total, `byRepo ${day.day}`);
    sameT(sumT(d.hours.filter((h) => h.hour.startsWith(day.day))), day, `hours of ${day.day}`);
  }
  for (const r of d.repos) {
    sameT(sumT(r.byModel.map((x) => x.totals)), r, `repo ${r.key}`);
    sameC(sumC(r.byModel.map((x) => x.cost)), r.cost, `repo cost ${r.key}`);
  }
  assert.equal(d.conversations + d.subagentLogs, d.logs);
  assert.ok(d.subagentCost.total < d.cost.total && tokenTotal(d.subagents) < tokenTotal(d.totals));
});

test("every cost is costOf over its own (day, model) cell, and nothing is negative or NaN", () => {
  const d = demoTokenStats(NOW);
  for (const day of d.days) {
    sameC(sumC(day.byModel.map((m) => costOf(m.totals, m.model, day.day))), day.cost, `day ${day.day}`);
    for (const m of day.byModel) sameC(costOf(m.totals, m.model, day.day), m.cost, `${day.day} ${m.model}`);
  }
  for (const h of d.hours) for (const m of h.byModel) sameC(costOf(m.totals, m.model, h.hour.slice(0, 10)), m.cost, h.hour);
  for (const c of d.top) assert.ok(c.cost.total > 0 && c.agentCost.total <= c.cost.total);
  assert.deepEqual(d.top.map((c) => c.cost.total), d.top.map((c) => c.cost.total).sort((a, b) => b - a));
  finite(d);
  assert.ok(d.hours.every((h) => hourMs(h.hour) <= NOW), "no hour from the future");
});

test("tokenwindows: the query parses, windows fold the same cells, the grid ends at the record", () => {
  assert.deepEqual(parseWindowSpecs("session:100:5,week:200:7,bad,x:NaN:1"), [
    { id: "session", anchor: 100, lenMs: 5 }, { id: "week", anchor: 200, lenMs: 7 },
  ]);
  const spec = { id: "week", anchor: NOW + 3 * 24 * HOUR, lenMs: 7 * 24 * HOUR };
  const doc = demoTokenWindows(NOW, [{ id: "session", anchor: NOW + 2 * HOUR, lenMs: 5 * HOUR }, spec]);
  assert.deepEqual(doc.series.map((s) => s.id), ["session", "week"]);
  const d = demoTokenStats(NOW);
  for (const s of doc.series) {
    assert.equal(s.oldestHour, hourMs(d.hours[0].hour));
    assert.ok(s.windows.length > 0);
    assert.deepEqual(s.windows.map((w) => w.back), [...s.windows.map((w) => w.back)].sort((a, b) => a - b));
    for (const w of s.windows) {
      sameT(sumT(w.byModel.map((x) => x.totals)), w, `window ${s.id}/${w.back}`);
      sameC(sumC(w.byModel.map((x) => x.cost)), w.cost, `window cost ${s.id}/${w.back}`);
    }
  }
  assert.ok(tokenTotal(sumT(doc.series[1].windows)) >= tokenTotal(d.totals), "every hour is in at least one week cell");
  assert.ok(windowCells(NOW - (NOW % HOUR), spec.anchor, spec.lenMs).length >= 1);
  finite(doc);
});

test("usagelog: a sawtooth that resets every five hours, a rising week, ending on the reading", () => {
  const usage = { ok: true, sessionPct: 42, weeklyPct: 61, checkedAt: NOW - 2 * 60_000, sessionResetAt: NOW + 2 * HOUR, weeklyResetAt: NOW + 3 * 24 * HOUR };
  const log = demoUsageLog(NOW, usage);
  const last = log.samples[log.samples.length - 1];
  assert.deepEqual([last.t, last.s, last.w, last.sr, last.wr], [usage.checkedAt, 42, 61, usage.sessionResetAt, usage.weeklyResetAt]);
  assert.equal(log.keptFrom, log.samples[0].t);
  assert.deepEqual(log.samples.map((s) => s.t), log.samples.map((s) => s.t).sort((a, b) => a - b));
  for (const s of log.samples) assert.ok(s.s >= 0 && s.s <= 100 && s.w >= 0 && s.w <= 100);
  for (let i = 1; i < log.samples.length; i++) {
    const a = log.samples[i - 1], b = log.samples[i];
    if (a.sr === b.sr) assert.ok(b.s >= a.s, "session only rises inside a window");
    else assert.equal((b.sr - a.sr) % (5 * HOUR), 0, "a reset moves the instant by whole windows");
    if (a.wr === b.wr) assert.ok(b.w >= a.w, "week only rises inside a window");
  }
  assert.ok(new Set(log.samples.map((s) => s.sr)).size > 3, "several session windows");
  assert.ok(log.samples.some((s) => s.s > 20), "not a flat line");
  const day = demoUsageLog(NOW, usage, 24);
  assert.ok(day.samples.length < log.samples.length && day.samples.every((s) => s.t >= NOW - 24 * HOUR));
  finite(day);
});

test("HTTP: opt-in only; repeated w= params reach the grid; no usage reading means no usage log", () => {
  const get = (m, path, query) => demoHttp(m, NOW, { method: "GET", path, query });
  const off = { numbers: {} };
  assert.equal(JSON.parse(get(off, "/api/tokenstats").body).conversations, 0);
  assert.equal(get(off, "/api/tokenwindows", { w: "a:1:2" }).status, 404);
  assert.equal(get(off, "/api/usagelog").status, 404);
  const on = { numbers: { ledger: true } };
  assert.ok(JSON.parse(get(on, "/api/tokenstats").body).conversations > 20);
  const w = JSON.parse(get(on, "/api/tokenwindows", { w: `a:${NOW}:${5 * HOUR},b:${NOW}:${7 * 24 * HOUR}` }).body);
  assert.deepEqual(w.series.map((s) => s.id), ["a", "b"]);
  assert.equal(get(on, "/api/usagelog").status, 404, "no usage reading in the model");
  on.numbers.usage = { ok: true, sessionPct: 10, weeklyPct: 20, checkedAt: NOW, sessionResetAt: NOW + HOUR, weeklyResetAt: NOW + 48 * HOUR };
  const u = JSON.parse(get(on, "/api/usagelog", { hours: "12" }).body);
  assert.ok(u.samples.length > 0 && u.samples.every((s) => s.t >= NOW - 12 * HOUR));
});

test("costwindow: the host's fold over the same records — the whole record is the ledger, a week is a cut of it", () => {
  const d = demoTokenStats(NOW);
  const whole = demoCostWindow(NOW, NOW - 30 * 24 * HOUR, NOW + HOUR);
  sameT(whole.totals, d.totals, "whole record");
  sameC(whole.cost, d.cost, "whole record");
  sameT(whole.agentTotals, d.subagents, "the agents' slice");
  sameC(whole.agentCost, d.subagentCost, "the agents' slice");
  assert.equal(whole.convos.length, d.conversations);
  assert.equal(whole.convos.reduce((a, c) => a + c.agents, 0), d.subagentLogs);
  // A week from mid-hour: it starts on the hour that instant is in, and every way of cutting it adds up.
  const from = NOW - 7 * 24 * HOUR + 20 * 60_000;
  const fromHour = new Date(from).setMinutes(0, 0, 0);
  const wk = demoCostWindow(NOW, from, NOW);
  assert.equal(wk.fromHour, fromHour);
  sameT(sumT(d.hours.filter((h) => hourMs(h.hour) >= fromHour && hourMs(h.hour) < NOW)), wk.totals, "the ledger's hours in the span");
  for (const [name, rows] of [["hours", wk.hours], ["convos", wk.convos], ["byRepo", wk.hours.flatMap((h) => h.byRepo)], ["byModel", wk.hours.flatMap((h) => h.byModel)]]) {
    sameT(sumT(rows.map((r) => r.totals)), wk.totals, name);
    sameC(sumC(rows.map((r) => r.cost)), wk.cost, name);
  }
  sameT(sumT(wk.convos.map((c) => c.agentTotals)), wk.agentTotals, "the agents' slice, per conversation");
  for (const c of wk.convos) {
    assert.ok(c.byHour.every((h) => hourMs(h.hour) >= fromHour && hourMs(h.hour) < NOW), `${c.id} has an hour outside the span`);
    near(c.byHour.reduce((a, h) => a + h.usd, 0), c.cost.total, `${c.id} by hour`);
    assert.ok(tokenTotal(c.agentTotals) <= tokenTotal(c.totals) && c.firstAt <= c.lastAt && c.title);
  }
  assert.deepEqual(wk.convos.map((c) => c.cost.total), wk.convos.map((c) => c.cost.total).sort((a, b) => b - a), "dearest first");
  assert.ok(wk.convos.length > 40 && wk.cost.total < whole.cost.total);
  finite(wk);
  // Over HTTP, for every scenario, as the host: a malformed span or no ledger is an empty document, never a 404.
  const get = (m, query) => JSON.parse(demoHttp(m, NOW, { method: "GET", path: "/api/costwindow", query }).body);
  assert.deepEqual(get({ numbers: { ledger: true } }, { from: String(from), to: String(NOW) }), wk);
  for (const [m, query] of [[{ numbers: { ledger: true } }, {}], [{ numbers: { ledger: true } }, { from: String(NOW), to: String(from) }], [{ numbers: {} }, { from: String(from), to: String(NOW) }]]) {
    const empty = get(m, query);
    assert.equal(empty.hours.length + empty.convos.length + tokenTotal(empty.totals), 0, JSON.stringify(query));
  }
});
