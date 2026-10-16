/**
 * Budget periods: the one `periodBounds`, the pacing maths and the billing
 * classifier. Edges are pinned across DST, short months and far zones because a
 * period that resets an hour early or a day late is a cap lifted or held wrongly.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  periodBounds, periodStates, cleanPeriods, windowRuleRefusal, periodHasEdge,
  spent, linearPace, perDayLeft, projectedEnd,
  SESSION_PERIOD, WEEKLY_PERIOD, ROLLING_30D_PERIOD,
} from "../dist/period.js";
import { classifyBilling, resolveBilling, authStatusKind, hasScrapedWindows } from "../dist/billing.js";
import { cleanBudget, budgetVerdict, budgetCeilings, budgetHoldText, budgetLimits, withLimit, withoutLimit, DEFAULT_USAGE_BUDGET } from "../dist/budget.js";
import { cleanRule, windowResetAt } from "../dist/schedule.js";
import { anchorPeriodId } from "../dist/schedule/schedrule.js";
import { budgetPassAt } from "../dist/intent.js";

const iso = (ms) => new Date(ms).toISOString();
const utc = (s) => Date.parse(s);
const month = (anchorDay, tz) => ({ id: "month", kind: "calendar", unit: "usd", cycle: "month", anchorDay, tz });

test("month anchored on the 1st in Berlin: edges are local midnights", () => {
  const b = periodBounds(month(1, "Europe/Berlin"), utc("2026-10-15T12:00:00Z"));
  assert.equal(iso(b.start), "2026-09-30T22:00:00.000Z"); // 1 Oct 00:00 CEST
  assert.equal(iso(b.resetAt), "2026-10-31T23:00:00.000Z"); // 1 Nov 00:00 CET (DST ended 25 Oct)
  assert.equal(b.active, true);
});

test("month across the spring-forward and fall-back edges (Berlin, New York)", () => {
  // Berlin 2026-03-29 02:00 -> 03:00; March is 1 h shorter than 31 days.
  let b = periodBounds(month(1, "Europe/Berlin"), utc("2026-03-15T00:00:00Z"));
  assert.equal(iso(b.start), "2026-02-28T23:00:00.000Z");
  assert.equal(iso(b.resetAt), "2026-03-31T22:00:00.000Z");
  assert.equal(b.resetAt - b.start, 31 * 86400e3 - 3600e3);
  // New York 2026-11-01 fall-back: November is 1 h longer than 30 days.
  b = periodBounds(month(1, "America/New_York"), utc("2026-11-15T00:00:00Z"));
  assert.equal(iso(b.start), "2026-11-01T04:00:00.000Z"); // EDT
  assert.equal(iso(b.resetAt), "2026-12-01T05:00:00.000Z"); // EST
  // The instant either side of an edge belongs to the right period.
  assert.equal(periodBounds(month(1, "America/New_York"), utc("2026-12-01T04:59:59Z")).resetAt, utc("2026-12-01T05:00:00Z"));
  assert.equal(periodBounds(month(1, "America/New_York"), utc("2026-12-01T05:00:00Z")).start, utc("2026-12-01T05:00:00Z"));
});

test("day period on the DST-change day is 23 or 25 hours long", () => {
  const day = (tz) => ({ id: "day", kind: "calendar", unit: "usd", cycle: "day", tz });
  let b = periodBounds(day("Europe/Berlin"), utc("2026-03-29T12:00:00Z"));
  assert.equal((b.resetAt - b.start) / 3600e3, 23);
  b = periodBounds(day("America/New_York"), utc("2026-11-01T12:00:00Z"));
  assert.equal((b.resetAt - b.start) / 3600e3, 25);
});

test("anchor day 31 clamps to the last day of short months", () => {
  const p = month(31, "UTC");
  // 20 Feb 2026 (28 days): this period began 31 Jan, resets on 28 Feb.
  let b = periodBounds(p, utc("2026-02-20T00:00:00Z"));
  assert.equal(iso(b.start), "2026-01-31T00:00:00.000Z");
  assert.equal(iso(b.resetAt), "2026-02-28T00:00:00.000Z");
  // Right on the 28th a new period has started, ending 31 Mar.
  b = periodBounds(p, utc("2026-02-28T00:00:00Z"));
  assert.equal(iso(b.start), "2026-02-28T00:00:00.000Z");
  assert.equal(iso(b.resetAt), "2026-03-31T00:00:00.000Z");
  // April has 30 days.
  b = periodBounds(p, utc("2026-04-10T00:00:00Z"));
  assert.equal(iso(b.start), "2026-03-31T00:00:00.000Z");
  assert.equal(iso(b.resetAt), "2026-04-30T00:00:00.000Z");
  b = periodBounds(p, utc("2026-04-30T10:00:00Z"));
  assert.equal(iso(b.resetAt), "2026-05-31T00:00:00.000Z");
});

test("leap year: anchor 29 and 31 in February 2028", () => {
  let b = periodBounds(month(29, "UTC"), utc("2028-02-10T00:00:00Z"));
  assert.equal(iso(b.start), "2028-01-29T00:00:00.000Z");
  assert.equal(iso(b.resetAt), "2028-02-29T00:00:00.000Z");
  b = periodBounds(month(29, "UTC"), utc("2027-02-10T00:00:00Z")); // not a leap year
  assert.equal(iso(b.resetAt), "2027-02-28T00:00:00.000Z");
  b = periodBounds(month(31, "UTC"), utc("2028-02-29T12:00:00Z"));
  assert.equal(iso(b.start), "2028-02-29T00:00:00.000Z");
});

test("year boundary rolls December into January", () => {
  const b = periodBounds(month(15, "UTC"), utc("2026-12-20T00:00:00Z"));
  assert.equal(iso(b.start), "2026-12-15T00:00:00.000Z");
  assert.equal(iso(b.resetAt), "2027-01-15T00:00:00.000Z");
  const c = periodBounds(month(15, "UTC"), utc("2027-01-05T00:00:00Z"));
  assert.equal(iso(c.start), "2026-12-15T00:00:00.000Z");
});

test("zones far from UTC read their own local date", () => {
  // 2026-10-31 20:00Z is already 1 Nov in Auckland (NZDT, +13) and Kiritimati (+14).
  const now = utc("2026-10-31T20:00:00Z");
  let b = periodBounds(month(1, "Pacific/Auckland"), now);
  assert.equal(iso(b.start), "2026-10-31T11:00:00.000Z"); // 1 Nov 00:00 +13
  assert.equal(iso(b.resetAt), "2026-11-30T11:00:00.000Z");
  b = periodBounds(month(1, "Pacific/Kiritimati"), now);
  assert.equal(iso(b.start), "2026-10-31T10:00:00.000Z"); // 1 Nov 00:00 +14
  // The same instant in UTC is still October.
  assert.equal(iso(periodBounds(month(1, "UTC"), now).start), "2026-10-01T00:00:00.000Z");
});

test("week period honours startDow in the zone", () => {
  const week = (startDow, tz) => ({ id: "week", kind: "calendar", unit: "usd", cycle: "week", startDow, tz });
  // 2026-10-15 is a Thursday.
  let b = periodBounds(week(1, "UTC"), utc("2026-10-15T12:00:00Z")); // Monday start
  assert.equal(iso(b.start), "2026-10-12T00:00:00.000Z");
  assert.equal(iso(b.resetAt), "2026-10-19T00:00:00.000Z");
  b = periodBounds(week(0, "UTC"), utc("2026-10-15T12:00:00Z")); // Sunday start
  assert.equal(iso(b.start), "2026-10-11T00:00:00.000Z");
  b = periodBounds(week(4, "UTC"), utc("2026-10-15T12:00:00Z")); // Thursday start: today
  assert.equal(iso(b.start), "2026-10-15T00:00:00.000Z");
  // Week containing the Berlin fall-back (25 Oct): Monday start, 7 days + 1 h.
  b = periodBounds(week(1, "Europe/Berlin"), utc("2026-10-26T12:00:00Z"));
  assert.equal(iso(b.start), "2026-10-25T23:00:00.000Z");
  b = periodBounds(week(1, "Europe/Berlin"), utc("2026-10-21T12:00:00Z"));
  assert.equal((b.resetAt - b.start) / 3600e3, 7 * 24 + 1);
});

test("span: before, within and after", () => {
  const p = { id: "q", kind: "span", unit: "usd", from: utc("2026-10-01T00:00:00Z"), to: utc("2026-11-01T00:00:00Z") };
  assert.deepEqual(periodBounds(p, utc("2026-09-01T00:00:00Z")), { start: p.from, resetAt: p.to, active: false });
  assert.deepEqual(periodBounds(p, utc("2026-10-15T00:00:00Z")), { start: p.from, resetAt: p.to, active: true });
  assert.deepEqual(periodBounds(p, p.to), { start: p.from, resetAt: null, active: false });
});

test("rolling: trailing sum has no edge, scraped windows take the host's reset", () => {
  const now = utc("2026-10-15T12:00:00Z");
  const t = periodBounds(ROLLING_30D_PERIOD, now);
  assert.equal(t.resetAt, null);
  assert.equal(t.start, now - 30 * 86400e3);
  const s = periodBounds(SESSION_PERIOD, now, { resetAt: now + 3600e3 });
  assert.equal(s.resetAt, now + 3600e3);
  assert.equal(s.start, now + 3600e3 - 5 * 3600e3);
  assert.equal(periodBounds(WEEKLY_PERIOD, now).resetAt, null);
  assert.equal(periodBounds(WEEKLY_PERIOD, now, { resetAt: now - 1 }).resetAt, null);
});

test("an unknown zone degrades to host-local instead of throwing", () => {
  const b = periodBounds(month(1, "Not/AZone"), utc("2026-10-15T12:00:00Z"));
  assert.ok(Number.isFinite(b.start) && b.resetAt > b.start);
});

test("windowRuleRefusal: rolling and unknown periods refuse in words", () => {
  const periods = [ROLLING_30D_PERIOD, month(1, "UTC")];
  assert.equal(windowRuleRefusal(undefined, periods), null);
  assert.equal(windowRuleRefusal("session", periods), null);
  assert.equal(windowRuleRefusal("weekly", undefined), null);
  assert.equal(windowRuleRefusal("month", periods), null);
  assert.match(windowRuleRefusal("rolling30d", periods), /no reset time/);
  assert.match(windowRuleRefusal("gone", periods), /no budget period/);
  assert.equal(periodHasEdge(ROLLING_30D_PERIOD), false);
});

test("cleanPeriods drops the malformed, never repairs", () => {
  const out = cleanPeriods([
    month(31, "UTC"), month(32, "UTC"), { id: "w", kind: "calendar", cycle: "week", startDow: 9, tz: "UTC" },
    { id: "session", kind: "calendar", cycle: "day", tz: "UTC" }, { id: "s", kind: "span", from: 5, to: 1 },
    { id: "rolling30d", kind: "rolling" }, "x", null,
  ]);
  assert.deepEqual(out.map((p) => p.id), ["month", "rolling30d"]);
  assert.deepEqual(cleanPeriods("nope"), []);
  assert.equal(periodStates(out, utc("2026-10-15T00:00:00Z")).length, 2);
});

test("pacing maths degrades to null", () => {
  const start = 0, reset = 30 * 86400e3, day = 86400e3;
  assert.equal(spent([{ at: 1, usd: 2 }, { at: 5, usd: 3 }, { at: 99, usd: 7 }], 0, 10), 5);
  assert.equal(spent([], 0, 10), 0);
  assert.equal(spent(undefined, 0, 10), null);
  assert.equal(spent([{ at: 1, usd: NaN }], 0, 10), null);
  assert.equal(linearPace(300, start, reset, 10 * day), 100);
  assert.equal(linearPace(300, start, null, 10 * day), null);
  assert.equal(linearPace(300, start, reset, 99 * day), 300);
  assert.equal(perDayLeft(300, 120, reset, 10 * day), 9); // 180 over 20 days
  assert.equal(perDayLeft(300, 400, reset, 10 * day), 0);
  assert.equal(perDayLeft(300, null, reset, 10 * day), null);
  assert.equal(perDayLeft(300, 10, reset, reset + 1), null);
  assert.equal(perDayLeft(300, 0, reset, reset - 3600e3), 300); // last hours are not scaled up
  assert.equal(projectedEnd(100, start, reset, 10 * day), 300);
  assert.equal(projectedEnd(100, start, reset, day), null); // too early to say
  assert.equal(projectedEnd(100, start, null, 10 * day), null);
  assert.equal(projectedEnd(null, start, reset, 10 * day), null);
});

test("billing: classify ambiguous inputs to unknown", () => {
  assert.equal(classifyBilling(null), "unknown");
  assert.equal(classifyBilling({}), "unknown");
  assert.equal(classifyBilling({ apiKeyEnv: true }), "api");
  assert.equal(classifyBilling({ apiKeyHelper: true }), "api");
  assert.equal(classifyBilling({ cloudEnv: true }), "cloud");
  assert.equal(classifyBilling({ cloudEnv: true, apiKeyEnv: true }), "cloud");
  assert.equal(classifyBilling({ authStatus: "Login method: Claude Max account (claude.ai)" }), "subscription");
  assert.equal(classifyBilling({ authStatus: "Login method: Anthropic Console API key" }), "api");
  assert.equal(classifyBilling({ apiKeyEnv: true, authStatus: "Logged in with claude.ai" }), "unknown");
  assert.equal(classifyBilling({ cloudEnv: true, authStatus: "Logged in with claude.ai" }), "unknown");
  assert.equal(classifyBilling({ authStatus: "claude.ai account, also an API key" }), "unknown");
  assert.equal(classifyBilling({ authStatus: "Not logged in" }), "unknown");
  assert.equal(authStatusKind(""), null);
  assert.deepEqual(resolveBilling("api", { authStatus: "claude.ai" }), { profile: "api", source: "setting" });
  assert.deepEqual(resolveBilling("unknown", { cloudEnv: true }), { profile: "cloud", source: "probe" });
  assert.deepEqual(resolveBilling(null, null), { profile: "unknown", source: "probe" });
  assert.equal(hasScrapedWindows("unknown"), true);
  assert.equal(hasScrapedWindows("api"), false);
});

// ── the ceiling list ─────────────────────────────────────────────────────────

const NOW = utc("2026-10-15T12:00:00Z");
const usage = (o = {}) => ({ ok: true, checkedAt: NOW - 1000, sessionPct: 10, weeklyPct: 10, sessionResetAt: NOW + 3600e3, weeklyResetAt: NOW + 86400e3, ...o });
const withMonth = (max) => cleanBudget({ ...DEFAULT_USAGE_BUDGET, periods: [month(1, "UTC")], ceilings: [{ periodId: "month", max, unit: "usd" }] });

test("cleanBudget migrates the old shape in place and writes both", () => {
  const b = cleanBudget({ enabled: true, sessionMax: 80, weeklyMax: 70, leftoverMax: 20 });
  assert.equal(b.sessionMax, 80);
  assert.equal(b.weeklyMax, 70);
  assert.deepEqual(b.ceilings, [{ periodId: "session", max: 80, unit: "pct" }, { periodId: "weekly", max: 70, unit: "pct" }]);
  assert.deepEqual(cleanBudget({}).ceilings, [{ periodId: "session", max: 90, unit: "pct" }]);
  // Idempotent.
  assert.deepEqual(cleanBudget(b), b);
});

test("a list written without mirrors is read; a stale list never beats an old writer's mirror", () => {
  const fromList = cleanBudget({ ceilings: [{ periodId: "session", max: 60, unit: "pct" }, { periodId: "weekly", max: 50, unit: "pct" }] });
  assert.equal(fromList.sessionMax, 60);
  assert.equal(fromList.weeklyMax, 50);
  const edited = { ...cleanBudget({ sessionMax: 80 }), sessionMax: 55 }; // old client edits the mirror only
  assert.equal(cleanBudget(edited).ceilings[0].max, 55);
});

test("cleanBudget drops dollar ceilings on undefined periods and bad numbers", () => {
  const b = cleanBudget({ periods: [month(1, "UTC")], ceilings: [
    { periodId: "month", max: 400, unit: "usd" }, { periodId: "ghost", max: 5, unit: "usd" },
    { periodId: "month", max: 9, unit: "usd" }, { periodId: "week", max: -1, unit: "usd" }, { periodId: "session", max: 5, unit: "usd" },
  ] });
  assert.deepEqual(b.ceilings.filter((l) => l.unit === "usd"), [{ periodId: "month", max: 400, unit: "usd" }]);
});

test("withLimit / withoutLimit keep both shapes in step", () => {
  let b = withLimit(cleanBudget({}), { periodId: "weekly", max: 75, unit: "pct" });
  assert.equal(b.weeklyMax, 75);
  b = withLimit(b, { periodId: "month", max: 400, unit: "usd" });
  assert.equal(budgetLimits(b).length, 3);
  b = withoutLimit(b, "weekly");
  assert.equal(b.weeklyMax, null);
  b = withoutLimit(b, "session");
  assert.equal(b.sessionMax, 100);
});

test("a dollar ceiling holds at the cap and names its reset", () => {
  const cfg = withMonth(400);
  const v = budgetVerdict(cfg, null, NOW, { month: 412 });
  assert.equal(v.blocked, true);
  assert.equal(v.which, "month");
  assert.equal(v.unit, "usd");
  assert.equal(v.resumeAt, utc("2026-11-01T00:00:00Z"));
  const c = budgetCeilings(cfg, null, NOW, { month: 400 });
  assert.deepEqual(c, [{ which: "month", pct: 400, max: 400, resetAt: utc("2026-11-01T00:00:00Z"), unit: "usd" }]);
  assert.match(budgetHoldText(c[0], NOW), /\$400 spent this month, over the \$400 budget/);
  // Releases at the reset: the caller's spend is for the NEW period.
  assert.equal(budgetVerdict(cfg, null, utc("2026-11-01T00:00:00Z"), { month: 3 }).blocked, false);
});

test("a missing spend reading is unknown, never a trip or a zero", () => {
  const cfg = withMonth(400);
  assert.equal(budgetVerdict(cfg, null, NOW).state, "unknown");
  assert.equal(budgetVerdict(cfg, null, NOW, { month: null }).blocked, false);
  assert.equal(budgetVerdict(cfg, null, NOW, { month: NaN }).blocked, false);
  assert.deepEqual(budgetCeilings(cfg, null, NOW, {}), []);
  assert.equal(budgetVerdict(cfg, null, NOW, { month: 100 }).state, "ok");
});

test("dollar and percent ceilings coexist; session sorts first; stale usage only mutes the percent ones", () => {
  const cfg = cleanBudget({ sessionMax: 90, periods: [month(1, "UTC")], ceilings: [{ periodId: "month", max: 50, unit: "usd" }] });
  const both = budgetCeilings(cfg, usage({ sessionPct: 95 }), NOW, { month: 60 });
  assert.deepEqual(both.map((c) => c.which), ["session", "month"]);
  const stale = budgetCeilings(cfg, usage({ sessionPct: 95, checkedAt: 1 }), NOW, { month: 60 });
  assert.deepEqual(stale.map((c) => c.which), ["month"]);
  assert.equal(budgetVerdict(cfg, usage(), NOW, { month: 10 }).state, "ok");
});

test("an inactive span holds nothing", () => {
  const span = { id: "q", kind: "span", unit: "usd", from: NOW + 1e6, to: NOW + 2e6 };
  const cfg = cleanBudget({ periods: [span], ceilings: [{ periodId: "q", max: 1, unit: "usd" }] });
  assert.equal(budgetVerdict(cfg, null, NOW, { q: 99 }).blocked, false);
  assert.equal(budgetVerdict(cfg, null, NOW + 1.5e6, { q: 99 }).blocked, true);
});

// ── schedule rule and pass take a period id ──────────────────────────────────

test("a window rule can name a period; session/weekly stay valid", () => {
  const r = cleanRule({ kind: "window", periodId: "month", edge: "before", offsetMin: -120 });
  assert.equal(r.periodId, "month");
  assert.equal(anchorPeriodId(r), "month");
  assert.equal(windowResetAt(r, { periodResetAt: { month: 1234 } }), 1234);
  assert.equal(windowResetAt(r, { sessionResetAt: 99 }), null);
  const w = cleanRule({ kind: "window", window: "weekly", periodId: "weekly" });
  assert.equal(w.periodId, undefined);
  assert.equal(anchorPeriodId(w), "weekly");
  assert.equal(windowResetAt(w, { weeklyResetAt: 77 }), 77);
  assert.equal(budgetPassAt(r, 1000).window, "month");
  assert.equal(budgetPassAt({ ...w, offsetMin: -60 }, 1e9).window, "weekly");
});

test("billing: a key beside a probe that read nothing (authStatus null) is unknown, not api", () => {
  assert.equal(classifyBilling({ apiKeyEnv: true, authStatus: null }), "unknown");
  assert.equal(classifyBilling({ apiKeyHelper: true, authStatus: null }), "unknown");
  assert.equal(classifyBilling({ apiKeyEnv: true, authStatus: "Not logged in" }), "api");
  assert.equal(classifyBilling({ cloudEnv: true, authStatus: null }), "cloud");
});

test("a local midnight inside a DST gap resolves to the first instant after it", () => {
  const sp = { id: "d", kind: "calendar", unit: "usd", cycle: "day", tz: "America/Sao_Paulo" };
  // 2018-11-04 00:00 did not exist in Sao Paulo (clocks went 00:00 -> 01:00, -03 -> -02).
  assert.equal(periodBounds(sp, Date.UTC(2018, 10, 4, 12)).start, Date.UTC(2018, 10, 4, 3));
  assert.equal(periodBounds(sp, Date.UTC(2018, 10, 4, 12)).resetAt, Date.UTC(2018, 10, 5, 2)); // next midnight is -02
  assert.equal(periodBounds(sp, Date.UTC(2018, 10, 3, 12)).resetAt, Date.UTC(2018, 10, 4, 3));
  const sc = { id: "d", kind: "calendar", unit: "usd", cycle: "day", tz: "America/Santiago" };
  // 2022-09-11 00:00 did not exist in Santiago (-04 -> -03).
  assert.equal(periodBounds(sc, Date.UTC(2022, 8, 11, 12)).start, Date.UTC(2022, 8, 11, 4));
});

test("cleanPeriods drops a calendar period with an invalid time zone", () => {
  const ok = { id: "a", kind: "calendar", cycle: "day", tz: "Europe/Berlin" };
  const bad = { id: "b", kind: "calendar", cycle: "day", tz: "Mars/Olympus" };
  assert.deepEqual(cleanPeriods([ok, bad]).map((p) => p.id), ["a"]);
});
