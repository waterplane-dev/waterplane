import test from "node:test";
import assert from "node:assert/strict";
import { periodStates } from "@waterplane/shared";
import {
  buildPeriod, emptyDraft, modelRows, pacing, pacingLine, periodCap, periodChip, periodDescribe, periodReadSpan, primaryUsdPeriod, usdWords,
} from "./periodWords.ts";

const D = 86_400_000;
const month = { id: "month", kind: "calendar", unit: "usd", cycle: "month", anchorDay: 1, tz: "UTC" };
const now = Date.UTC(2026, 9, 11, 12); // Oct 11, 12:00 UTC
const state = (spentUsd, period = month) => ({ ...periodStates([period], now)[0], ...(spentUsd === undefined ? {} : { spentUsd }) });
const budget = (max) => ({ enabled: true, sessionMax: 90, weeklyMax: null, leftoverMax: 20, periods: [month], ceilings: max == null ? [] : [{ periodId: "month", max, unit: "usd" }] });

test("usdWords: whole dollars from a hundred, cents below", () => {
  assert.equal(usdWords(412.4), "$412");
  assert.equal(usdWords(2000), "$2000");
  assert.equal(usdWords(0.48), "$0.48");
  assert.equal(usdWords(0), "$0");
});

test("the chip reads month, spend, cap and pace", () => {
  // Day 10.5 of 31 against 2000: the straight line is ~677, 412 is well under it.
  assert.equal(periodChip(state(412), 2000, now).text, "Oct $412 / $2000 · under pace");
  assert.equal(periodChip(state(700), 2000, now).text, "Oct $700 / $2000 · on pace");
  assert.equal(periodChip(state(900), 2000, now).text, "Oct $900 / $2000 · ahead of pace");
  assert.equal(periodChip(state(2100), 2000, now).text, "Oct $2100 / $2000 · over the cap");
});

test("no cap: spend only, no pace word; hot only near a cap", () => {
  const c = periodChip(state(412), null, now);
  assert.equal(c.text, "Oct $412");
  assert.equal(c.hot, false);
  assert.equal(periodChip(state(1700), 2000, now).hot, true);
});

test("an unmeasured period has no chip: absent, never $0 or ?", () => {
  assert.equal(periodChip(state(undefined), 2000, now), null);
  assert.equal(periodChip(state(null), 2000, now), null);
});

test("a billing day off the 1st names the day", () => {
  const p = { ...month, id: "m15", anchorDay: 15 };
  assert.match(periodChip(state(10, p), null, now).text, /^15 Sep \$10\.00$/);
});

test("pacing: per-day left and projection, absent where they cannot be said", () => {
  const p = pacing(state(700), 2000, now);
  assert.ok(p.perDay > 0 && p.perDay < 100);
  assert.ok(Math.abs(p.projected - 700 * (31 / 10.5)) < 1);
  // Rolling 30 days has no edge: no per-day, no projection.
  const roll = state(700, { id: "rolling30d", kind: "rolling", unit: "usd", lenMs: 30 * D, scraped: false });
  assert.deepEqual(pacing(roll, 2000, now), { pace: null, perDay: null, projected: null });
  // The first hours of a period: a straight line against a hundredth of the cap is noise.
  const early = periodStates([month], Date.UTC(2026, 9, 1, 1))[0];
  assert.equal(pacing({ ...early, spentUsd: 5 }, 2000, Date.UTC(2026, 9, 1, 1)).pace, null);
});

test("pacingLine: over the cap says so and offers no per-day figure", () => {
  assert.deepEqual(pacingLine(state(2100), 2000, now)[0], "over the cap");
  assert.ok(!pacingLine(state(2100), 2000, now).some((w) => w.includes("/day")));
  assert.ok(pacingLine(state(700), 2000, now).some((w) => /\/day left$/.test(w)));
});

test("periodCap reads the dollar ceiling only", () => {
  assert.equal(periodCap(budget(2000), "month"), 2000);
  assert.equal(periodCap(budget(null), "month"), null);
  assert.equal(periodCap(null, "month"), null);
});

test("primaryUsdPeriod: a capped period beats an uncapped one, month beats the rest", () => {
  const day = { id: "day", kind: "calendar", unit: "usd", cycle: "day", tz: "UTC" };
  const states = periodStates([day, month], now);
  assert.equal(primaryUsdPeriod(states, { ...budget(null), periods: [day, month] }, now).period.id, "month");
  const capped = { ...budget(null), periods: [day, month], ceilings: [{ periodId: "day", max: 50, unit: "usd" }] };
  assert.equal(primaryUsdPeriod(states, capped, now).period.id, "day");
  assert.equal(primaryUsdPeriod([], budget(1)), null);
  assert.equal(primaryUsdPeriod(undefined, null), null);
});

test("periodReadSpan reads to now inside the period and refuses past the host's 35 days", () => {
  const s = state(1);
  const r = periodReadSpan(s, now);
  assert.equal(r.from, s.start);
  assert.equal(r.to, now);
  const span = { id: "s", kind: "span", unit: "usd", from: now - 60 * D, to: now + D };
  assert.match(periodReadSpan(periodStates([span], now)[0], now).refusal, /35 days/);
});

test("modelRows folds the carried sessions and the capped rest into rows that add up", () => {
  const sl = (model, usd, input) => ({ model, cost: { total: usd }, totals: { input, output: 0, cacheRead: 0, cacheWrite: 0 } });
  const rows = modelRows([{ byModel: [sl("claude-opus-4-8", 3, 10), sl("claude-sonnet-4-6", 1, 5)] }], [{ byModel: [sl("claude-opus-4-8", 2, 4)] }]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].usd, 5);
  assert.equal(rows[0].tokens, 14);
  assert.equal(rows.reduce((n, r) => n + r.usd, 0), 6);
});

test("buildPeriod: a month needs a real billing day and zone, a span two real days", () => {
  const d = emptyDraft();
  assert.equal(buildPeriod({ ...d, tz: "Europe/Berlin", anchorDay: "15" }).period.anchorDay, 15);
  assert.match(buildPeriod({ ...d, tz: "Europe/Berlin", anchorDay: "32" }).reason, /1 to 31/);
  assert.match(buildPeriod({ ...d, tz: "Mars/Olympus" }).reason, /not a time zone/);
  assert.match(buildPeriod({ ...d, kind: "span", from: "2026-02-30", to: "2026-03-05" }).reason, /YYYY-MM-DD/);
  assert.match(buildPeriod({ ...d, kind: "span", from: "2026-03-05", to: "2026-03-01" }).reason, /on or after/);
  const ok = buildPeriod({ ...d, kind: "span", from: "2026-03-01", to: "2026-03-31" });
  assert.equal(ok.ok, true);
  assert.equal(ok.period.id, "span-2026-03-01");
  assert.ok(ok.period.to > ok.period.from);
  assert.equal(buildPeriod({ ...d, kind: "rolling30d" }).period.id, "rolling30d");
  assert.equal(buildPeriod({ ...d, kind: "week", startDow: 1, tz: "UTC" }).period.startDow, 1);
});

test("periodDescribe names the shape", () => {
  assert.match(periodDescribe(month), /calendar month from the 1st · UTC/);
  assert.match(periodDescribe({ ...month, anchorDay: 15 }), /15th/);
  assert.equal(periodDescribe({ id: "rolling30d", kind: "rolling", unit: "usd", lenMs: 30 * D, scraped: false }), "rolling 30 days");
});

test("periodChip and primaryUsdPeriod say nothing once the reset has passed", () => {
  const s = state(412);
  assert.ok(periodChip(s, 2000, now));
  assert.equal(periodChip(s, 2000, s.resetAt), null);
  assert.equal(periodChip(s, 2000, s.resetAt + D), null);
  assert.equal(primaryUsdPeriod([s], null, s.resetAt + D), null);
  assert.ok(primaryUsdPeriod([s], null, now));
});

test("periodReadSpan refuses an edge inside an hour and reads a rolling window over whole hours", () => {
  const half = { ...state(1), start: Date.UTC(2026, 9, 1, 0, 30) };
  assert.match(periodReadSpan(half, now).refusal, /inside an hour/);
  const closedHalf = { ...state(1), resetAt: Date.UTC(2026, 9, 5, 0, 30) };
  assert.match(periodReadSpan(closedHalf, now).refusal, /inside an hour/);
  const rolling = periodStates([{ id: "r", kind: "rolling", unit: "usd", lenMs: 30 * D, scraped: false }], now + 20 * 60_000)[0];
  const r = periodReadSpan(rolling, now + 20 * 60_000);
  assert.equal(r.from % 3_600_000, 0);
  assert.ok(r.from >= rolling.start);
});

test("buildPeriod refuses a span whose local midnight is off the UTC hour", () => {
  const prev = process.env.TZ;
  try {
    process.env.TZ = "Asia/Kolkata";
    const r = buildPeriod({ ...emptyDraft(), kind: "span", from: "2026-10-01", to: "2026-10-05" });
    assert.equal(r.ok, false);
    assert.match(r.reason, /whole UTC hour/);
    process.env.TZ = "Europe/Berlin";
    assert.equal(buildPeriod({ ...emptyDraft(), kind: "span", from: "2026-10-01", to: "2026-10-05" }).ok, true);
  } finally { if (prev === undefined) delete process.env.TZ; else process.env.TZ = prev; }
});
