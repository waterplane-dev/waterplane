/**
 * Billing profile + budget periods, host half: the probe's wiring (facts in,
 * profile out, `unknown` until probed), the period-to-date fold and what may be
 * believed of it, and a dollar cap holding AUTOMATIC work only and letting go at
 * the period's computed reset.
 *
 *     node --test packages/host/test/billingperiods.test.mjs
 *
 * The rules themselves (`classifyBilling`, `periodBounds`, `budgetVerdict`,
 * `intentVerdict`, `windowRuleRefusal`) are pinned in shared; this is the plumbing.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { intentVerdict, windowRuleRefusal, periodBounds } from "@waterplane/shared";
import { BillingStore, envFacts, apiKeyHelperIn } from "../dist/billing.js";
import { PeriodSpend, SPEND_STALE_MS, foldTotal } from "../dist/periodspend.js";
import { BudgetStore } from "../dist/budget.js";
import { createPaceWatch } from "../dist/burnwatch.js";

const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "billperiods-")); dirs.push(d); return d; };

const monthPeriod = { id: "month", kind: "calendar", unit: "usd", cycle: "month", anchorDay: 1, tz: "UTC" };
const NOW = Date.UTC(2026, 9, 15, 12, 0, 0); // 15 Oct 2026
const MONTH_START = Date.UTC(2026, 9, 1);
const NOV = Date.UTC(2026, 10, 1);

// ── probe wiring ─────────────────────────────────────────────────────────────

const billing = (over = {}) => {
  const changes = [];
  const emptyCfg = tmp();
  const store = new BillingStore(over.root ?? tmp(), {
    authStatus: over.authStatus ?? (async () => null),
    env: over.env ?? {}, now: over.now,
    configDir: () => over.configDir ?? emptyCfg,
    onChange: (s) => changes.push(s),
  });
  return { store, changes };
};

test("unknown until the first probe has finished, then classified from the facts", async () => {
  const { store, changes } = billing({ env: { ANTHROPIC_API_KEY: "k" }, authStatus: async () => "Not logged in" });
  assert.deepEqual(store.status(), { profile: "unknown", source: "probe" }); // never a guess before the probe
  assert.equal(store.probed(), false);
  const s = await store.refresh();
  assert.deepEqual(s, { profile: "api", source: "probe" });
  assert.equal(changes.length, 1);
});

test("a claude.ai login is subscription; a key beside one is unknown, not api", async () => {
  assert.equal((await billing({ authStatus: async () => "Logged in with claude.ai (Max plan)" }).store.refresh()).profile, "subscription");
  assert.equal((await billing({ env: { ANTHROPIC_API_KEY: "k" }, authStatus: async () => "Logged in with claude.ai (Max plan)" }).store.refresh()).profile, "unknown");
});

test("bedrock/vertex env is cloud; a failed auth probe is unknown, never subscription", async () => {
  assert.equal((await billing({ env: { CLAUDE_CODE_USE_BEDROCK: "1" } }).store.refresh()).profile, "cloud");
  assert.equal((await billing({ env: { CLAUDE_CODE_USE_VERTEX: "0" } }).store.refresh()).profile, "unknown"); // "0" is off
  assert.equal((await billing({ authStatus: async () => { throw new Error("timeout"); } }).store.refresh()).profile, "unknown");
});

test("apiKeyHelper in claude's settings is an api signal", async () => {
  const dir = tmp();
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ apiKeyHelper: "/bin/key.sh" }));
  assert.equal(apiKeyHelperIn(dir), true);
  assert.equal(apiKeyHelperIn(tmp()), false);
  assert.equal((await billing({ configDir: dir, authStatus: async () => "Not logged in" }).store.refresh()).profile, "api");
  assert.deepEqual(envFacts({ ANTHROPIC_AUTH_TOKEN: "t" }), { apiKeyEnv: true, cloudEnv: false });
});

test("the override wins, persists across a restart, and null hands the profile back", async () => {
  const root = tmp();
  const a = billing({ root, authStatus: async () => "Logged in with claude.ai (Pro plan)" });
  await a.store.refresh();
  assert.equal(a.store.setOverride("api").profile, "api");
  assert.equal(a.store.status().source, "setting");
  const b = billing({ root }); // a fresh process, nothing probed
  assert.deepEqual(b.store.status(), { profile: "api", source: "setting" });
  assert.equal(b.store.setOverride("unknown").source, "probe"); // "unknown" is not an override
  assert.equal(b.store.setOverride(null).profile, "unknown");
});

test("the auth probe runs once, not per request", async () => {
  let calls = 0;
  const { store } = billing({ authStatus: async () => { calls++; return null; } });
  await Promise.all([store.refresh(), store.refresh()]);
  await store.refresh();
  assert.equal(calls, 1);
});

test("a key beside a probe that read nothing is unknown, and the probe is redone after the retry window", async () => {
  let calls = 0, text = null, t = 1_000_000;
  const { store } = billing({ env: { ANTHROPIC_API_KEY: "k" }, now: () => t, authStatus: async () => { calls++; return text; } });
  assert.equal((await store.refresh()).profile, "unknown");
  await store.refresh();
  assert.equal(calls, 1, "inside the retry window: not re-run");
  t += 6 * 60_000; text = "Login method: Anthropic Console API key";
  assert.equal((await store.refresh()).profile, "api");
  assert.equal(calls, 2);
  t += 6 * 60_000;
  await store.refresh();
  assert.equal(calls, 2, "a probe that read something is believed for hours");
});

// ── the fold ─────────────────────────────────────────────────────────────────

test("period-to-date is folded over the period's own span, and a failed fold is absent not zero", async () => {
  const asked = [];
  let answer = 412.5;
  const ps = new PeriodSpend({
    periods: () => [monthPeriod], now: () => NOW,
    fold: async (from, to) => { asked.push([from, to]); if (answer === "throw") throw new Error("ledger"); return answer; },
  });
  assert.deepEqual(ps.get(NOW), {}); // never measured: absent
  assert.equal(await ps.refresh(), true);
  assert.equal(asked[0][0], MONTH_START);
  assert.ok(asked[0][1] > NOW && asked[0][1] <= NOV);
  assert.equal(ps.get(NOW).month, 412.5);
  answer = null;
  await ps.refresh();
  assert.equal(ps.get(NOW).month, 412.5); // kept to age out, never overwritten with 0
  assert.deepEqual(ps.get(NOW + SPEND_STALE_MS + 1), {}); // …and then absent
});

test("only whole-hour periods are folded; rolling 30 days is cut on the hour; the reset hour is exclusive", async () => {
  const asked = {};
  const mk = (p, now = NOW + 17 * 60_000) => {
    const ps = new PeriodSpend({ periods: () => [p], now: () => now, fold: async (from, to) => { asked[p.id] = [from, to]; return 1; } });
    return ps;
  };
  const roll = { id: "rolling30d", kind: "rolling", unit: "usd", lenMs: 30 * 86_400_000, scraped: false };
  const r = mk(roll); await r.refresh();
  assert.equal(asked.rolling30d[0], NOW - 30 * 86_400_000, "from the top of the hour, 720 whole hours back");
  assert.equal(asked.rolling30d[1], NOW + 3_600_000);
  assert.equal(r.get(NOW + 17 * 60_000).rolling30d, 1);
  const half = { id: "ist", kind: "calendar", unit: "usd", cycle: "month", anchorDay: 1, tz: "Asia/Kolkata" };
  const h = mk(half); await h.refresh();
  assert.deepEqual(h.get(NOW), {}, "a half-hour zone's edge is not an hour bucket: absent, never a wide figure");
  assert.equal(asked.ist, undefined);
  const span = { id: "sp", kind: "span", unit: "usd", from: NOW - 3_600_000 + 1, to: NOW + 7_200_000 };
  const s = mk(span); await s.refresh();
  assert.deepEqual(s.get(NOW), {});
  const aligned = { id: "sp2", kind: "span", unit: "usd", from: NOW - 3_600_000, to: NOW + 7_200_000 };
  await mk(aligned).refresh();
  assert.deepEqual(asked.sp2, [NOW - 3_600_000, NOW + 3_600_000]);
  // the month's last hour ends AT the reset: [start, reset), the reset hour is the next month's
  await mk(monthPeriod, NOV - 60_000).refresh();
  assert.equal(asked.month[1], NOV);
});

test("a stale ledger document is not believed", () => {
  const doc = (scannedAt) => ({ scannedAt, cost: { total: 12 } });
  assert.equal(foldTotal(doc(NOW), NOW + 1000), 12);
  assert.equal(foldTotal(doc(NOW), NOW + SPEND_STALE_MS + 1), null);
  assert.equal(foldTotal(doc(0), NOW), null);
});

test("a total measured for last month is not this month's spend", async () => {
  const ps = new PeriodSpend({ periods: () => [monthPeriod], now: () => NOW, fold: async () => 900 });
  await ps.refresh();
  assert.equal(ps.get(NOW).month, 900);
  assert.deepEqual(ps.get(NOV + 1), {}); // past the reset: about a period that ended
});

// ── a dollar cap holds automatic work, releases at the reset ─────────────────

function capStore(spendOf) {
  const spend = { month: spendOf };
  const store = new BudgetStore(tmp(), () => null, () => (spend.month == null ? {} : { month: spend.month }));
  store.set({ ...store.get(), periods: [monthPeriod], ceilings: [{ periodId: "month", max: 500, unit: "usd" }] });
  return { store, spend };
}

test("a dollar ceiling over its cap blocks, names the period reset, and survives a percent-only budget.set", () => {
  const { store } = capStore(512);
  const v = store.verdict(NOW);
  assert.equal(v.blocked, true);
  assert.equal(v.which, "month");
  assert.equal(v.unit, "usd");
  assert.equal(v.resumeAt, NOV);
  assert.equal(store.ceilings(NOW)[0].resetAt, NOV);
  // A phone from before periods sends the two percents and no list: the cap stays.
  store.set({ enabled: true, sessionMax: 80, weeklyMax: null, leftoverMax: 20 });
  assert.equal(store.verdict(NOW).blocked, true);
  assert.ok(store.periods(NOW).some((x) => x.period.id === "month"));
});

test("under the cap, or with nothing measured, nothing is held", () => {
  assert.equal(capStore(120).store.verdict(NOW).blocked, false);
  assert.equal(capStore(null).store.verdict(NOW).blocked, false); // fail open, never a trip off nothing
});

test("the cap holds auto work (rung 2) and never a hand-sent one; it lets go at the reset", () => {
  const { store } = capStore(512);
  const row = (auto) => ({
    id: "i1", cwd: "/repo", payload: { kind: "prompt", steps: ["x"] }, target: { kind: "session", sessionId: "s1" },
    trigger: { kind: "now" }, state: "queued", createdAt: NOW - 1000, ...(auto ? { auto: true } : {}),
  });
  const facts = (now) => ({
    present: new Set(), sessions: [{ id: "s1", cwd: "/repo", running: true }], repoSession: new Map(), busyCwds: new Set(),
    busySessions: new Set(), budgetBlocked: store.verdict(now).blocked, budgetOver: store.ceilings(now),
    autoFire: true, knownDirs: new Set(), hostBusy: false, autoSlotsFree: 1,
  });
  const held = intentVerdict(row(true), facts(NOW), NOW);
  assert.equal(held.reason, "budget");
  assert.notEqual(intentVerdict(row(false), facts(NOW), NOW).reason, "budget"); // hand work is not auto
  // Past the computed reset the cached month is about a period that ended: the cap
  // reads absent and the same row is no longer held, with no event delivered.
  const ps = new PeriodSpend({ periods: () => [monthPeriod], now: () => NOW, fold: async () => 512 });
  return ps.refresh().then(() => {
    const live = new BudgetStore(tmp(), () => null, () => ps.get(NOV + 60_000));
    live.set({ ...live.get(), periods: [monthPeriod], ceilings: [{ periodId: "month", max: 500, unit: "usd" }] });
    assert.equal(live.verdict(NOV + 60_000).blocked, false);
    assert.equal(new BudgetStore(tmp(), () => null, () => ps.get(NOW)).verdict(NOW).blocked, false); // no cap configured there
  });
});

test("budget.state periods carry the dollars, the edge, and omit built-ins on a clean subscription", () => {
  const sub = new BudgetStore(tmp(), () => null);
  assert.deepEqual(sub.periods(NOW), []); // nothing configured: the wire field is omitted
  const { store } = capStore(512);
  const p = store.periods(NOW).find((x) => x.period.id === "month");
  assert.equal(p.spentUsd, 512);
  assert.equal(p.resetAt, NOV);
  assert.equal(p.start, periodBounds(monthPeriod, NOW).start);
  assert.deepEqual(store.periodResets(NOW), { session: null, weekly: null, month: NOV });
});

// ── the window rule on a rolling period ──────────────────────────────────────

test("a window rule on the rolling 30 days is refused in words; a month is not", () => {
  const rolling = { id: "rolling30d", kind: "rolling", unit: "usd", lenMs: 30 * 86400e3, scraped: false };
  assert.match(windowRuleRefusal("rolling30d", [rolling]), /no reset time/);
  assert.equal(windowRuleRefusal("month", [monthPeriod]), null);
  assert.equal(windowRuleRefusal("weekly", []), null);
});

// ── $ vs pace ────────────────────────────────────────────────────────────────

test("the pace push fires once per period, only when the projection passes the cap", () => {
  const sent = [];
  const start = MONTH_START;
  let spent = 400; // 14.5 of 31 days in: projects ~855 against 500
  const w = createPaceWatch({
    stateDir: tmp(), now: () => NOW, notify: (k, p) => sent.push([k, p]),
    paces: () => [{ id: "month", label: "month", start, resetAt: NOV, max: 500, spentUsd: spent }],
  });
  assert.equal(w.check(), true);
  assert.equal(w.check(), false); // once per period start
  assert.equal(sent[0][0], "burn");
  assert.match(sent[0][1].body, /list price/);
  const quiet = createPaceWatch({ stateDir: tmp(), now: () => NOW, notify: () => assert.fail("should be quiet"), paces: () => [{ id: "month", label: "month", start, resetAt: NOV, max: 5000, spentUsd: 400 }] });
  assert.equal(quiet.check(), false);
  spent = null;
});

test("a ledger holding undated records is no period figure: a floor is not spend (design round 4)", () => {
  const doc = (undated) => ({ scannedAt: NOW, cost: { total: 12 }, undated });
  assert.equal(foldTotal(doc(0), NOW + 1000), 12);
  assert.equal(foldTotal(doc(undefined), NOW + 1000), 12, "an older host that does not say reads as before");
  assert.equal(foldTotal(doc(1), NOW + 1000), null);
});

test("a fold refused for undated records says so: the period has no figure and a WHY, never $0 (design round 4, r4-1 M2)", async () => {
  const { foldAnswer } = await import("../dist/periodspend.js");
  const doc = { scannedAt: NOW, cost: { total: 7 } };
  assert.equal(foldAnswer(doc, NOW), 7);
  const refused = foldAnswer({ ...doc, undated: 3 }, NOW);
  assert.match(refused.why, /Claude Code's ledger holds 3 records it could not date/);
  assert.equal(foldAnswer({ ...doc, scannedAt: 0, undated: 3 }, NOW), null, "never scanned: nobody measured, no cause to name");

  let answer = refused;
  const ps = new PeriodSpend({ periods: () => [monthPeriod], now: () => NOW, fold: async () => answer });
  assert.equal(await ps.refresh(), true, "a new cause is news");
  assert.deepEqual(ps.get(NOW), {}, "no figure");
  assert.equal(ps.why(NOW).month, refused.why);
  assert.deepEqual(ps.why(NOW + SPEND_STALE_MS + 1), {}, "the cause ages out like a figure");
  answer = 12;
  await ps.refresh();
  assert.equal(ps.get(NOW).month, 12);
  assert.deepEqual(ps.why(NOW), {}, "a figure clears the cause");
});
