import test from "node:test";
import assert from "node:assert/strict";
import {
  NOTIFICATION_KINDS, cleanWeekBurnPrefs, pickedFor, ptsPerWindow, weekBurnItemPrompt, weekBurnNudge, weekBurnPlan, weekBurnStopText,
} from "../dist/index.js";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NOW = Date.parse("2026-10-24T12:00:00Z");
const RESET = NOW + 3 * DAY;
const row = (t, s, w, sr, wr = RESET) => ({ t, s, w, sr, wr });
const prefs = (o = {}) => ({ repos: [], weekOf: null, recurring: false, lastRepos: [], stopPct: 95, task: "", notes: {}, ...o });

/** One full session window ending `endAgo` before NOW: session 0 to 90, week w0 to w1. */
function windowRows(endAgo, w0, w1) {
  const end = NOW - endAgo;
  const sr = end + HOUR;
  const out = [];
  for (let i = 0; i <= 4; i++) out.push(row(end - (4 - i) * HOUR, i * 22, w0 + ((w1 - w0) * i) / 4, sr));
  return out;
}

test("ptsPerWindow: the weekly climb of the biggest full window", () => {
  const rows = [...windowRows(30 * HOUR, 10, 18), ...windowRows(10 * HOUR, 30, 42)];
  assert.equal(ptsPerWindow(rows, NOW), 12);
});

test("ptsPerWindow: null with no readings, no full window, or only an old one", () => {
  assert.equal(ptsPerWindow([], NOW), null);
  const partial = windowRows(10 * HOUR, 10, 20).map((r) => ({ ...r, s: Math.min(r.s, 50) }));
  assert.equal(ptsPerWindow(partial, NOW), null);
  assert.equal(ptsPerWindow(windowRows(20 * DAY, 10, 20), NOW), null);
});

test("plan: windows from the measured pace, start before reset", () => {
  const rows = windowRows(10 * HOUR, 30, 40);
  const p = weekBurnPlan({ samples: rows, weeklyPct: 50, weeklyResetAt: RESET, stopPct: 95, now: NOW });
  assert.equal(p.ptsPerWindow, 10);
  assert.equal(p.windows, 5);
  assert.equal(p.startAt, RESET - 5 * 5 * HOUR - HOUR);
  assert.match(p.reasonText, /Starting in/);
});

test("plan: no measured window falls back to a day before reset, and says so", () => {
  const p = weekBurnPlan({ samples: [], weeklyPct: 50, weeklyResetAt: RESET, stopPct: 95, now: NOW });
  assert.equal(p.startAt, RESET - DAY);
  assert.equal(p.windows, null);
  assert.equal(p.ptsPerWindow, null);
  assert.match(p.reasonText, /No measured full window yet, so starting a day before reset/);
});

test("plan: never before now; a start in the past says starting now", () => {
  const near = NOW + 6 * HOUR;
  const p = weekBurnPlan({ samples: windowRows(10 * HOUR, 30, 40), weeklyPct: 50, weeklyResetAt: near, stopPct: 95, now: NOW });
  assert.equal(p.startAt, NOW);
  assert.match(p.reasonText, /Starting now\.$/);
  const full = weekBurnPlan({ samples: [], weeklyPct: 96, weeklyResetAt: RESET, stopPct: 95, now: NOW });
  assert.equal(full.startAt, NOW);
  assert.equal(full.windows, 0);
});

test("plan: null without a reading or a reset", () => {
  assert.equal(weekBurnPlan({ samples: [], weeklyPct: null, weeklyResetAt: RESET, stopPct: 95, now: NOW }), null);
  assert.equal(weekBurnPlan({ samples: [], weeklyPct: 40, weeklyResetAt: null, stopPct: 95, now: NOW }), null);
});

test("pickedFor: needs repos, a weekOf, and a reset within tolerance", () => {
  const p = prefs({ repos: ["/r/a"], weekOf: RESET });
  assert.equal(pickedFor(p, RESET), true);
  assert.equal(pickedFor(p, RESET + 4 * MIN), true);
  assert.equal(pickedFor(p, RESET + 6 * MIN), false);
  assert.equal(pickedFor(p, RESET + 7 * DAY), false);
  assert.equal(pickedFor(p, null), false);
  assert.equal(pickedFor(prefs({ weekOf: RESET }), RESET), false);
  assert.equal(pickedFor(prefs({ repos: ["/r/a"] }), RESET), false);
});

test("stop text: null only for a fresh reading under the line, before the last 20 minutes", () => {
  const ok = { weeklyPct: 60, weeklyResetAt: RESET, stopPct: 95, now: NOW, readingAt: NOW - 5 * MIN };
  assert.equal(weekBurnStopText(ok), null);
  assert.equal(weekBurnStopText({ ...ok, weeklyPct: 95 }), "Stopped: week at 95%.");
  assert.match(weekBurnStopText({ ...ok, now: RESET - 10 * MIN, readingAt: RESET - 12 * MIN }), /resets within 20 min/);
  assert.ok(weekBurnStopText({ ...ok, readingAt: NOW - HOUR }));
  assert.ok(weekBurnStopText({ ...ok, readingAt: null }));
  assert.ok(weekBurnStopText({ ...ok, weeklyPct: null }));
  assert.ok(weekBurnStopText({ ...ok, weeklyResetAt: null }));
});

// A week climbing slowly: 10 points over 48 h from a week that started 4 days before NOW-ish.
const slowWeek = [row(NOW - 48 * HOUR, null, 10), row(NOW - HOUR, null, 20)];
const nudgeArgs = (o = {}) => ({
  samples: slowWeek, prefs: prefs(), weeklyPct: 20, weeklyResetAt: NOW + 30 * HOUR, readingAt: NOW - MIN, subscription: true, nudgedWeekOf: null, now: NOW, ...o,
});

test("nudge: on pace to leave budget, once the start is within a day", () => {
  const n = weekBurnNudge(nudgeArgs());
  assert.ok(n);
  assert.match(n.body, /On pace to leave ~\d+% of this week unused \(resets in 30 h\)\. Pick repos for the week-end burn\?/);
});

test("nudge: silent when picked, already sent, stale, not a subscription, or on pace to use it", () => {
  assert.equal(weekBurnNudge(nudgeArgs({ prefs: prefs({ repos: ["/r/a"], weekOf: NOW + 30 * HOUR }) })), null);
  assert.equal(weekBurnNudge(nudgeArgs({ nudgedWeekOf: NOW + 30 * HOUR })), null);
  assert.equal(weekBurnNudge(nudgeArgs({ readingAt: NOW - HOUR })), null);
  assert.equal(weekBurnNudge(nudgeArgs({ subscription: false })), null);
  const fast = [row(NOW - 48 * HOUR, null, 10), row(NOW - HOUR, null, 60)];
  assert.equal(weekBurnNudge(nudgeArgs({ samples: fast, weeklyPct: 60 })), null);
  assert.equal(weekBurnNudge(nudgeArgs({ samples: [] })), null, "no pace, no claim");
});

test("nudge: not before a day ahead of the planned start", () => {
  const far = NOW + 20 * DAY;
  assert.equal(weekBurnNudge(nudgeArgs({ weeklyResetAt: far })), null);
});

test("nudge: recurring asks regardless of pace", () => {
  const fast = [row(NOW - 48 * HOUR, null, 10), row(NOW - HOUR, null, 60)];
  const n = weekBurnNudge(nudgeArgs({ samples: fast, weeklyPct: 60, prefs: prefs({ recurring: true }) }));
  assert.equal(n.title, "Pick this week's repos");
});

test("cleanWeekBurnPrefs: garbage becomes defaults", () => {
  const d = prefs();
  for (const bad of [null, undefined, 5, "x", [], { repos: "a", weekOf: "z", stopPct: "high", recurring: "yes", lastRepos: 3 }]) {
    assert.deepEqual(cleanWeekBurnPrefs(bad), d);
  }
  const c = cleanWeekBurnPrefs({ repos: ["/a", "/a", 4, "", "/b"], weekOf: RESET, recurring: true, lastRepos: ["/c"], stopPct: 10 });
  assert.deepEqual(c, { repos: ["/a", "/b"], weekOf: RESET, recurring: true, lastRepos: ["/c"], stopPct: 50, task: "", notes: {} });
  const t = cleanWeekBurnPrefs({ task: `  ${"x".repeat(3000)} `, notes: { "/a": " keep ", "/b": "", "/c": 4, "": "x" } });
  assert.equal(t.task.length, 2000);
  assert.deepEqual(t.notes, { "/a": "keep" });
  assert.equal(cleanWeekBurnPrefs({ stopPct: NaN }).stopPct, 95);
});

test("item prompt names the repo and the rules; kind is registered", () => {
  const t = weekBurnItemPrompt({ repoName: "demo", healthSummary: "tests: 80" });
  assert.match(t, /demo/);
  assert.match(t, /tests: 80/);
  assert.match(t, /never push/);
  assert.match(weekBurnItemPrompt({ repoName: "demo" }), /own checks, tests and lint/);
  assert.ok(NOTIFICATION_KINDS.includes("weekburn"));
});

test("item prompt: the person's task replaces the weakest-reading ask, a note is added, the rules always stay", () => {
  const t = weekBurnItemPrompt({ repoName: "demo", healthSummary: "tests: 80", task: "Raise parser coverage", note: "no new deps" });
  assert.match(t, /What to work on \(from the person who picked this repo\):\nRaise parser coverage/);
  assert.match(t, /tests: 80/);
  assert.doesNotMatch(t, /Pick the weakest reading/);
  assert.match(t, /For this repo:\nno new deps/);
  assert.match(t, /never push/);
  assert.equal(weekBurnItemPrompt({ repoName: "demo", healthSummary: "tests: 80", task: "  ", note: "" }),
    weekBurnItemPrompt({ repoName: "demo", healthSummary: "tests: 80" }));
});

test("isWeekBurnOrigin: the burn's rows and nothing else; the count label", async () => {
  const { isWeekBurnOrigin, weekBurnRowsLabel, WEEKBURN_ORIGIN } = await import("../dist/index.js");
  assert.equal(isWeekBurnOrigin(`${WEEKBURN_ORIGIN}2026-10-26`), true);
  assert.equal(isWeekBurnOrigin("agent"), false);
  assert.equal(isWeekBurnOrigin(undefined), false);
  assert.equal(weekBurnRowsLabel(3), "3 from the week-end burn");
});
