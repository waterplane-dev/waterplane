/**
 * The live-window cut, pinned without a browser.
 *
 *     node --test packages/web/src/usageCut.test.mjs
 *
 * Every case here is a way this cut can look like an answer and be one about
 * the wrong span: a window that already reset, an hour record that does not
 * reach back, an edge that falls mid-hour, and a host whose hours carry no
 * model split. All four produce a plausible number if nobody checks, and a
 * plausible number on a screen that also prints dollars is the failure this
 * whole file exists to prevent.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { zeroCost, zeroTotals, tokenTotal } from "@waterplane/shared";
import {
  LIVE_WINDOWS, cutRefusalText, cutSpan, heatFrac, heatStep, isCut, leadClause,
  seriesCut, windowCut, windowGrid, windowSpecs, windowWhen,
} from "./usageCut.ts";

const SESSION = LIVE_WINDOWS.find((w) => w.id === "session");
const WEEK = LIVE_WINDOWS.find((w) => w.id === "week");

const HOUR = 3_600_000;

/** A local-hour key for an instant, the way the host writes one. */
const key = (t) => {
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}`;
};

/** One hour bucket: `n` tokens of cache read, `usd` of cost, optionally split. */
const hour = (t, n, usd, byModel) => ({
  hour: key(t),
  ...zeroTotals(),
  cacheRead: n,
  turns: 1,
  cost: { ...zeroCost(), cacheRead: usd, total: usd },
  ...(byModel ? { byModel } : {}),
});

const slice = (model, n, usd) => ({
  model,
  totals: { ...zeroTotals(), cacheRead: n, turns: 1 },
  cost: { ...zeroCost(), cacheRead: usd, total: usd },
});

/** Local midnight of the day `t` is in — what the host puts in `hoursFrom`. */
const midnight = (t) => {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

const docOf = (hours, models = []) => ({
  hours,
  hoursFrom: hours.length ? midnight(Date.parse(`${hours[0].hour.slice(0, 10)}T00:00:00`)) : null,
  models,
});

const usageOf = (sessionResetAt, weeklyResetAt = null) => ({
  ok: true, sessionPct: 1, weeklyPct: 50,
  sessionResetAt, weeklyResetAt, checkedAt: Date.now(),
});

// ── the edge ──────────────────────────────────────────────────────────────

test("a window opening at :59 starts at the NEXT hour, and says the minute it left out", () => {
  // A window resetting at 06:59 opened at 01:59. The finest bucket on record is an hour, and
  // the floor (01:00) counted 59 minutes of the PREVIOUS window — the measured weekly over-count
  // (Thu 18:59 reset: ≈ 4 points). The nearest hour is 02:00: one minute short, stated.
  const now = new Date(2026, 8, 20, 6, 40, 0, 0).getTime();
  const reset = new Date(2026, 8, 20, 6, 59, 0, 0).getTime();
  const hours = [hour(new Date(2026, 8, 20, 1, 30).getTime(), 100, 10), hour(now - HOUR, 10, 1)];
  const c = windowCut(SESSION, docOf(hours), usageOf(reset), now);
  assert.ok(isCut(c));
  assert.equal(c.openedAt, new Date(2026, 8, 20, 1, 59, 0, 0).getTime());
  assert.equal(c.fromHour, new Date(2026, 8, 20, 2, 0, 0, 0).getTime());
  assert.equal(c.leadMs, -60_000);
  // The 01:00 hour is the previous window's and is not in this one.
  assert.equal(tokenTotal(c.totals), 10);
  assert.match(cutSpan(c, now), /the first minute of the window falls before the first hour bucket and is left out/);
});

test("a window opening at :20 starts at the top of its own hour, the first hour counted whole", () => {
  const now = new Date(2026, 8, 20, 6, 40, 0, 0).getTime();
  const reset = new Date(2026, 8, 20, 7, 20, 0, 0).getTime();
  const c = windowCut(SESSION, docOf([hour(now - HOUR, 10, 1)]), usageOf(reset), now);
  assert.ok(isCut(c));
  assert.equal(c.fromHour, new Date(2026, 8, 20, 2, 0, 0, 0).getTime());
  assert.equal(c.leadMs, 20 * 60_000);
  assert.match(cutSpan(c, now), /the first hour is counted whole, 20 min wider than the window/);
});

test("the week resetting Thu 18:59 starts at 19:00 — the measured over-count", () => {
  const reset = new Date(2026, 9, 8, 18, 59, 0, 0).getTime(); // a Thursday
  const now = reset - 3 * 24 * HOUR;
  const opened = reset - 7 * 24 * HOUR;
  const hours = [
    hour(new Date(2026, 9, 1, 18, 10).getTime(), 999, 40), // last week's 18:00 hour
    hour(new Date(2026, 9, 1, 19, 10).getTime(), 5, 1),
  ];
  const c = windowCut(WEEK, docOf(hours), usageOf(null, reset), now);
  assert.ok(isCut(c));
  assert.equal(c.openedAt, opened);
  assert.equal(c.fromHour, new Date(2026, 9, 1, 19, 0, 0, 0).getTime());
  assert.equal(tokenTotal(c.totals), 5);
  assert.ok(Math.abs(c.cost.total - 1) < 1e-9);
});

test("a window opening exactly on the hour claims no extra minutes", () => {
  const now = new Date(2026, 8, 20, 6, 40, 0, 0).getTime();
  const reset = new Date(2026, 8, 20, 12, 0, 0, 0).getTime();
  const c = windowCut(SESSION, docOf([hour(now, 10, 1)]), usageOf(reset), now);
  assert.ok(isCut(c));
  assert.equal(c.leadMs, 0);
  assert.doesNotMatch(cutSpan(c, now), /counted whole|left out/);
});

test("the edge clause: wider, narrower, singular, none", () => {
  assert.equal(leadClause(0, "week", "the first column"), null);
  assert.equal(leadClause(20_000, "week", "the first column"), null); // under half a minute
  assert.equal(leadClause(59 * 60_000, "week", "the first column"), "the first hour is counted whole, 59 min wider than the week");
  assert.equal(leadClause(-60_000, "week", "the first column"), "the first minute of the week falls before the first column and is left out");
  assert.equal(leadClause(-11 * 60_000, "window", "the first hour bucket"), "the first 11 minutes of the window fall before the first hour bucket and are left out");
});

// ── what is in the cut ────────────────────────────────────────────────────

test("only the hours at or after the cut are counted — the one before it is not", () => {
  const now = new Date(2026, 8, 20, 6, 40, 0, 0).getTime();
  const reset = new Date(2026, 8, 20, 7, 0, 0, 0).getTime(); // opened 02:00
  const hours = [
    hour(new Date(2026, 8, 20, 1, 30).getTime(), 100, 10), // before the cut
    hour(new Date(2026, 8, 20, 2, 30).getTime(), 7, 0.7),
    hour(new Date(2026, 8, 20, 5, 30).getTime(), 3, 0.3),
  ];
  const c = windowCut(SESSION, docOf(hours), usageOf(reset), now);
  assert.ok(isCut(c));
  assert.equal(c.hours.length, 2);
  assert.equal(tokenTotal(c.totals), 10);
  assert.ok(Math.abs(c.cost.total - 1) < 1e-9);
});

test("the model split folds the hours and is labelled through the alias, with `priced` carried over", () => {
  const now = new Date(2026, 8, 20, 6, 40).getTime();
  const reset = new Date(2026, 8, 20, 7, 0).getTime();
  const hours = [
    hour(new Date(2026, 8, 20, 2, 30).getTime(), 3, 0.3, [slice("claude-opus-5", 3, 0.3)]),
    hour(new Date(2026, 8, 20, 5, 30).getTime(), 9, 0.9, [
      slice("claude-opus-5", 5, 0.5),
      slice("some-unpriced-model", 4, 0.4),
    ]),
  ];
  const models = [
    { key: "claude-opus-5", label: "opus", ...zeroTotals(), cost: zeroCost(), priced: true },
    { key: "some-unpriced-model", label: "x", ...zeroTotals(), cost: zeroCost(), priced: false },
  ];
  const c = windowCut(SESSION, docOf(hours, models), usageOf(reset), now);
  assert.ok(isCut(c));
  assert.equal(c.modelSplit, true);
  // Descending by tokens, folded across both hours.
  assert.equal(c.models.length, 2);
  assert.equal(c.models[0].key, "claude-opus-5");
  assert.equal(tokenTotal(c.models[0]), 8);
  assert.equal(c.models[0].priced, true);
  assert.equal(c.models[1].priced, false);
  // A model the all-time list does not name leaves the flag ABSENT — "no
  // published rate" and "the list does not mention it" are different facts.
  const c2 = windowCut(SESSION, docOf(hours, []), usageOf(reset), now);
  assert.ok(isCut(c2));
  assert.equal("priced" in c2.models[0], false);
});

test("an older host's hours carry no split: the tokens still count, the split says unknown", () => {
  const now = new Date(2026, 8, 20, 6, 40).getTime();
  const reset = new Date(2026, 8, 20, 7, 0).getTime();
  const c = windowCut(SESSION, docOf([hour(new Date(2026, 8, 20, 3, 0).getTime(), 42, 4)]), usageOf(reset), now);
  assert.ok(isCut(c));
  assert.equal(c.modelSplit, false);
  assert.deepEqual(c.models, []);
  assert.equal(tokenTotal(c.totals), 42);
});

test("ONE quiet hour inside the cut does not read as an old daemon", () => {
  // An hour that ran nothing has an EMPTY split, which is a reading. The test
  // for "this host records splits" is that SOME hour carries the field.
  const now = new Date(2026, 8, 20, 6, 40).getTime();
  const reset = new Date(2026, 8, 20, 7, 0).getTime();
  const hours = [
    hour(new Date(2026, 8, 20, 2, 30).getTime(), 0, 0, []),
    hour(new Date(2026, 8, 20, 5, 30).getTime(), 9, 0.9, [slice("claude-opus-5", 9, 0.9)]),
  ];
  const c = windowCut(SESSION, docOf(hours), usageOf(reset), now);
  assert.ok(isCut(c));
  assert.equal(c.modelSplit, true);
});

// ── the three refusals ────────────────────────────────────────────────────

test("no reset instant ⇒ no cut, and the sentence names the window", () => {
  const now = Date.now();
  const c = windowCut(WEEK, docOf([hour(now, 1, 1)]), usageOf(now + HOUR, null), now);
  assert.equal(isCut(c), false);
  assert.equal(c.why, "no-reset");
  assert.match(cutRefusalText(WEEK, c), /did not name a reset time/);
});

test("a reading whose window already reset is REFUSED, not counted as the current one", () => {
  // The most dangerous case: the scrape is real, the numbers are real, and the
  // five hours it describes are the previous five.
  const now = new Date(2026, 8, 20, 8, 0).getTime();
  const reset = new Date(2026, 8, 20, 6, 59).getTime();
  const c = windowCut(SESSION, docOf([hour(now - HOUR, 10, 1)]), usageOf(reset), now);
  assert.equal(isCut(c), false);
  assert.equal(c.why, "rolled");
  assert.match(cutRefusalText(SESSION, c), /has since reset/);
});

test("an hour record that does not reach back is REFUSED rather than cut to what it happens to hold", () => {
  const now = new Date(2026, 8, 20, 12, 0).getTime();
  const reset = new Date(2026, 8, 23, 18, 59).getTime(); // week opened 16 Sept
  const doc = docOf([hour(new Date(2026, 8, 19, 9, 0).getTime(), 10, 1)]); // hours from 19 Sept
  const c = windowCut(WEEK, doc, usageOf(null, reset), now);
  assert.equal(isCut(c), false);
  assert.equal(c.why, "short");
  assert.match(cutRefusalText(WEEK, c), /does not reach back/);
});

test("no hourly detail at all is its OWN sentence, not the short-record one", () => {
  const now = new Date(2026, 8, 20, 12, 0).getTime();
  const c = windowCut(SESSION, docOf([]), usageOf(now + HOUR), now);
  assert.equal(isCut(c), false);
  assert.equal(c.why, "short");
  assert.match(cutRefusalText(SESSION, c), /No hourly detail on this desktop yet/);
});

test("no document and no usage are both refusals, never an empty cut reading as zero", () => {
  const now = Date.now();
  assert.equal(isCut(windowCut(SESSION, null, usageOf(now + HOUR), now)), false);
  assert.equal(isCut(windowCut(SESSION, docOf([hour(now, 1, 1)]), null, now)), false);
});

// ── the span sentence ─────────────────────────────────────────────────────

test("a week-wide cut names the DAY it starts on; a five-hour one names only the time", () => {
  const now = new Date(2026, 8, 20, 12, 0).getTime();
  const weekReset = new Date(2026, 8, 24, 18, 59).getTime();
  const wk = windowCut(WEEK, docOf([hour(new Date(2026, 8, 17, 19, 0).getTime(), 1, 1)]), usageOf(null, weekReset), now);
  assert.ok(isCut(wk));
  assert.match(cutSpan(wk, now), /\d+ days of hour buckets/);

  const sess = windowCut(SESSION, docOf([hour(now - HOUR, 1, 1)]), usageOf(now + HOUR), now);
  assert.ok(isCut(sess));
  assert.match(cutSpan(sess, now), /hours of hour buckets/);
});

// ── the windows BEFORE this one ────────────────────────────────────────────

/** One host-folded window row. */
const win = (back, n, usd, byModel) => ({
  back,
  ...zeroTotals(),
  cacheRead: n,
  turns: 2,
  cost: { ...zeroCost(), cacheRead: usd, total: usd },
  ...(byModel ? { byModel } : {}),
});

/** A grid anchored on `anchor`, reaching back to `oldest`. */
const grid = (anchor, lenMs, windows, oldest) => ({
  id: "session", anchor, lenMs, windows,
  oldestHour: oldest, newestHour: anchor - lenMs,
});

test("the grid runs oldest first and ends at the window running now", () => {
  const anchor = new Date(2026, 8, 20, 17, 0, 0, 0).getTime();
  const cells = windowGrid(grid(anchor, 5 * HOUR, [win(0, 10, 1), win(2, 40, 4)], anchor - 20 * HOUR));
  assert.deepEqual(cells.map((c) => c.back), [3, 2, 1, 0]);
  assert.equal(cells[cells.length - 1].back, 0);
  // A window with no row RAN NOTHING — a reading, and a real zero.
  assert.equal(tokenTotal(cells[2].totals), 0);
  assert.equal(tokenTotal(cells[1].totals), 40);
});

test("a window the record does not cover is UNKNOWN, never a zero", () => {
  const anchor = new Date(2026, 8, 20, 17, 0, 0, 0).getTime();
  // The record starts halfway through window 2, so window 2 is not coverable
  // and window 3 does not exist at all.
  const cells = windowGrid(grid(anchor, 5 * HOUR, [win(0, 10, 1)], anchor - 12 * HOUR));
  assert.deepEqual(cells.map((c) => c.back), [2, 1, 0]);
  assert.equal(cells[0].totals, null, "partly covered reads as unknown");
  assert.equal(cells[0].cost, null);
  assert.notEqual(cells[1].totals, null);
});

test("no hour record at all draws no grid — an empty one would be a claim", () => {
  const anchor = Date.now() + HOUR;
  assert.deepEqual(windowGrid(grid(anchor, 5 * HOUR, [], null)), []);
  assert.deepEqual(windowGrid(null), []);
});

test("a past window is cut from the grid, with its own span sentence", () => {
  const anchor = new Date(2026, 8, 20, 17, 0, 0, 0).getTime();
  const g = grid(anchor, 5 * HOUR, [win(1, 60, 6)], anchor - 30 * HOUR);
  const c = seriesCut(SESSION, g, 1, []);
  assert.ok(isCut(c));
  assert.equal(c.back, 1);
  assert.equal(c.resetAt, anchor - 5 * HOUR);
  assert.equal(tokenTotal(c.totals), 60);
  const span = cutSpan(c, anchor);
  assert.ok(!span.includes("to now"), "a window that closed did not run until now");
  assert.ok(span.includes("Counted from"));
});

test("a past window opening mid-hour is cut on the nearest hours at BOTH ends, so neighbours tile", () => {
  // Reset 17:20: window 1 ran [07:20, 12:20) and is counted [07:00, 12:00) — the 12:00 hour is
  // window 0's, whose cut starts there. The sentence prints the span it actually counted.
  const anchor = new Date(2026, 8, 20, 17, 20, 0, 0).getTime();
  const g = grid(anchor, 5 * HOUR, [win(1, 60, 6)], anchor - 30 * HOUR);
  const c = seriesCut(SESSION, g, 1, []);
  assert.ok(isCut(c));
  assert.equal(c.fromHour, new Date(2026, 8, 20, 7, 0, 0, 0).getTime());
  assert.equal(c.leadMs, 20 * 60_000);
  const at = (t) => new Date(t).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  const span = cutSpan(c, anchor);
  assert.ok(span.includes(`to ${at(new Date(2026, 8, 20, 12, 0, 0, 0).getTime())}, 5 hours of hour buckets`), span);
  const next = seriesCut(SESSION, g, 0, []);
  assert.equal(next.fromHour, new Date(2026, 8, 20, 12, 0, 0, 0).getTime());
});

test("a window older than the record is REFUSED, not answered with zero", () => {
  const anchor = new Date(2026, 8, 20, 17, 0, 0, 0).getTime();
  const g = grid(anchor, 5 * HOUR, [], anchor - 6 * HOUR);
  const c = seriesCut(SESSION, g, 4, []);
  assert.equal(isCut(c), false);
  assert.equal(c.why, "short");
});

test("a window with a row but no split says so; one with no row at all is a quiet window", () => {
  const anchor = new Date(2026, 8, 20, 17, 0, 0, 0).getTime();
  const old = grid(anchor, 5 * HOUR, [win(1, 60, 6)], anchor - 30 * HOUR);
  assert.equal(seriesCut(SESSION, old, 1, []).modelSplit, false);
  const quiet = seriesCut(SESSION, old, 2, []);
  assert.equal(quiet.modelSplit, true, "no row is a window that ran nothing, not an old host");
  assert.deepEqual(quiet.models, []);
});

test("the model split is labelled through the alias and keeps `priced` from the all-time row", () => {
  const anchor = new Date(2026, 8, 20, 17, 0, 0, 0).getTime();
  const slice = {
    model: "claude-opus-5-20260101",
    totals: { ...zeroTotals(), cacheRead: 60, turns: 1 },
    cost: { ...zeroCost(), cacheRead: 6, total: 6 },
  };
  const g = grid(anchor, 5 * HOUR, [win(1, 60, 6, [slice])], anchor - 30 * HOUR);
  const c = seriesCut(SESSION, g, 1, [{ key: "claude-opus-5-20260101", label: "x", priced: true, ...zeroTotals(), cost: zeroCost() }]);
  assert.equal(c.modelSplit, true);
  assert.equal(c.models[0].priced, true);
  assert.notEqual(c.models[0].label, "claude-opus-5-20260101");
});

test("a grid with no anchor is no grid, and no cut", () => {
  assert.deepEqual(windowGrid(grid(0, 5 * HOUR, [], 1)), []);
  assert.equal(isCut(seriesCut(SESSION, null, 0, [])), false);
});

test("the ramp never draws a real reading as the empty box, and never colours a zero", () => {
  assert.equal(heatStep(heatFrac(0, 100), 5), 0, "nothing counted stays the empty box");
  assert.equal(heatStep(heatFrac(1, 1_000_000), 5), 1, "one token is still visible");
  assert.equal(heatStep(heatFrac(100, 100), 5), 4, "the busiest box is the top step");
  // Square-rooted on purpose: a quarter of the busiest window is halfway up.
  assert.equal(heatFrac(25, 100), 0.5);
  assert.equal(heatFrac(5, 0), 0, "no maximum ⇒ no colour, never a division");
});

test("a week grid names two dates; a five-hour one names the clock", () => {
  const open = new Date(2026, 8, 20, 12, 0, 0, 0).getTime();
  assert.ok(windowWhen(open, open + 5 * HOUR).includes("–"));
  assert.ok(/\d{1,2}:\d{2}/.test(windowWhen(open, open + 5 * HOUR)));
  const week = windowWhen(open, open + 7 * 24 * HOUR);
  assert.ok(!/\d{1,2}:\d{2}/.test(week), "a week is named by its dates, not by 18:59 twice");
});

test("the specs the host is asked to fold carry the SCRAPED anchors, and skip a window with none", () => {
  const u = { ok: true, sessionPct: 3, weeklyPct: 50, sessionResetAt: 1000, weeklyResetAt: null, checkedAt: 0 };
  const specs = windowSpecs(u);
  assert.deepEqual(specs.map((x) => x.id), ["session"]);
  assert.equal(specs[0].anchor, 1000);
  assert.equal(specs[0].lenMs, SESSION.lenMs);
  assert.deepEqual(windowSpecs(null), []);
});
