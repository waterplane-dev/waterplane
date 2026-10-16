/**
 * The weekly burn: the segment rule both the chart and the host's watcher cut
 * the usage readings by, the reset-cut stretch a rate is read off, when a push
 * is owed, and its words. A rate that would be invented is null; the push
 * pauses nothing and says so.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  BURN_DEFAULT_COOLDOWN_MS, burnPushText, burnStretch, burnVerdict, sameWindow, usageSegments, usageStretches,
} from "../dist/index.js";

const MIN = 60_000;
const HOUR = 60 * MIN;
const sample = (t, s, w, sr, wr = null) => ({ t, s, w, sr, wr });
const wk = (t, w, wr) => ({ t, s: null, w, sr: null, wr });

// ── the three cases the web kit pins (kit/chart/statsPlot.test.mjs), over the moved rule ──

test("a window rollover CUTS the line instead of drawing a cliff", () => {
  const t0 = Date.parse("2026-09-10T08:00:00Z");
  const r1 = Date.parse("2026-09-10T10:00:00Z");
  const r2 = Date.parse("2026-09-10T15:00:00Z");
  const rows = [
    sample(t0, 10, 20, r1),
    sample(t0 + 10 * MIN, 40, 21, r1),
    sample(t0 + 20 * MIN, 80, 22, r1),
    sample(t0 + 30 * MIN, 3, 23, r2),
    sample(t0 + 40 * MIN, 9, 24, r2),
  ];
  const segs = usageSegments(rows, "session");
  assert.equal(segs.length, 2);
  assert.equal(segs[0].pts.length, 3);
  assert.equal(segs[1].rolled, true);
  assert.equal(segs[0].rolled, false);
});

test("a reset instant that jitters by a minute is the SAME window, not a rollover", () => {
  const t0 = Date.parse("2026-09-24T06:00:00Z");
  const a = Date.parse("2026-09-24T10:59:00Z");
  const b = Date.parse("2026-09-24T11:00:00Z");
  const rows = [sample(t0, 2, 91, a), sample(t0 + 8 * MIN, 3, 92, b), sample(t0 + 16 * MIN, 3, 92, a), sample(t0 + 24 * MIN, 4, 92, b)];
  const segs = usageSegments(rows, "session");
  assert.equal(segs.length, 1);
  assert.equal(segs[0].pts.length, 4);
  assert.equal(usageSegments(rows, "week").length, 1);
  assert.equal(sameWindow(a, b), true);
  assert.equal(sameWindow(null, b), true, "unknown is never 'different'");
});

test("the figure FALLING is a rollover even when no reset is named — and cuts once, not twice", () => {
  const t0 = Date.parse("2026-09-24T06:00:00Z");
  const r1 = Date.parse("2026-09-24T08:00:00Z");
  const r2 = Date.parse("2026-09-24T13:00:00Z");
  const rows = [
    sample(t0, 5, 90, r1),
    sample(t0 + 30 * MIN, 7, 90, r1),
    sample(t0 + 40 * MIN, 0, 90, null),
    sample(t0 + 50 * MIN, 1, 90, r2),
    sample(t0 + 60 * MIN, 2, 90, r2),
  ];
  const segs = usageSegments(rows, "session", 45 * MIN);
  assert.equal(segs.length, 2);
  assert.equal(segs[0].pts.length, 2);
  assert.equal(segs[1].pts.length, 3);
  assert.equal(segs[1].rolled, true);
  assert.equal(usageSegments([sample(t0, 41, 90, r1), sample(t0 + 10 * MIN, 40, 90, r1)], "session").length, 1);
});

test("a stretch is cut only by a reset — a gap in the readings is not usage coming back", () => {
  const t0 = Date.parse("2026-10-05T00:00:00Z");
  const wr = Date.parse("2026-10-09T19:00:00Z");
  const rows = [wk(t0, 10, wr), wk(t0 + 10 * HOUR, 30, wr)];
  assert.equal(usageSegments(rows, "week").length, 2, "the chart breaks the line across ten unobserved hours");
  assert.equal(usageStretches(rows, "week").length, 1, "…but the window is one stretch");
});

// ── burnStretch ──

const NOW = Date.parse("2026-10-09T12:00:00Z");
const WR = Date.parse("2026-10-09T19:00:00Z");

test("burnStretch: rate arithmetic over the lookback, clipped to it", () => {
  const rows = [
    wk(NOW - 5 * HOUR, 2, WR),          // outside the 3 h lookback: not counted
    wk(NOW - 2 * HOUR, 20, WR),
    wk(NOW - 1 * HOUR, 24, WR),
    wk(NOW, 28, WR),
  ];
  const s = burnStretch(rows, NOW);
  assert.deepEqual(s, { from: NOW - 2 * HOUR, to: NOW, dPts: 8, ptsPerHour: 4, samples: 3 });
});

test("burnStretch: a reset inside the lookback starts a new stretch", () => {
  const next = WR + 7 * 24 * HOUR;
  const rows = [
    wk(NOW - 150 * MIN, 95, WR),
    wk(NOW - 120 * MIN, 99, WR),
    wk(NOW - 60 * MIN, 1, next),         // the week rolled
    wk(NOW, 4, next),
  ];
  const s = burnStretch(rows, NOW);
  assert.ok(s, "the new stretch is long enough on its own");
  assert.equal(s.from, NOW - 60 * MIN);
  assert.equal(s.dPts, 3, "never the -95 across the reset");
  assert.equal(s.ptsPerHour, 3);
});

test("burnStretch: under 45 minutes, a falling figure, or one reading is null", () => {
  assert.equal(burnStretch([wk(NOW - 30 * MIN, 10, WR), wk(NOW, 20, WR)], NOW), null, "30 minutes is a sample, not a rate");
  assert.equal(burnStretch([wk(NOW - 2 * HOUR, 20, WR), wk(NOW, 20, WR)], NOW), null, "nothing climbed");
  assert.equal(burnStretch([wk(NOW - 2 * HOUR, 20, WR), wk(NOW - HOUR, 21, WR), wk(NOW, 20.5, WR)], NOW), null, "a correction that ends lower than 1 pt up");
  assert.equal(burnStretch([wk(NOW, 20, WR)], NOW), null);
  assert.equal(burnStretch([], NOW), null);
  assert.equal(burnStretch([{ t: NOW - HOUR, s: 5, w: null, sr: null, wr: null }, { t: NOW, s: 9, w: null, sr: null, wr: null }], NOW), null,
    "a reading without the weekly figure is dropped, never read as 0");
});

// ── burnVerdict ──

const S = { from: NOW - 2 * HOUR, to: NOW, dPts: 10, ptsPerHour: 5, samples: 4 };

test("burnVerdict: off, no stretch, under threshold, cooldown, told, fires", () => {
  assert.deepEqual(burnVerdict(S, 0, {}, NOW, BURN_DEFAULT_COOLDOWN_MS), { fire: false, why: "off" });
  assert.deepEqual(burnVerdict(S, -1, {}, NOW, BURN_DEFAULT_COOLDOWN_MS), { fire: false, why: "off" });
  assert.deepEqual(burnVerdict(null, 4, {}, NOW, BURN_DEFAULT_COOLDOWN_MS), { fire: false, why: "noStretch" });
  assert.deepEqual(burnVerdict(S, 6, {}, NOW, BURN_DEFAULT_COOLDOWN_MS), { fire: false, why: "underThreshold" });
  assert.deepEqual(burnVerdict(S, 4, { lastAt: NOW - HOUR }, NOW, BURN_DEFAULT_COOLDOWN_MS), { fire: false, why: "cooldown" });
  assert.deepEqual(burnVerdict(S, 4, { lastAt: NOW - 4 * HOUR, lastFrom: S.from }, NOW, BURN_DEFAULT_COOLDOWN_MS), { fire: false, why: "told" },
    "the same stretch is never told twice, even past the cooldown");
  assert.deepEqual(burnVerdict(S, 4, { lastAt: NOW - 4 * HOUR, lastFrom: S.from - HOUR }, NOW, BURN_DEFAULT_COOLDOWN_MS), { fire: true });
  assert.deepEqual(burnVerdict(S, 5, {}, NOW, BURN_DEFAULT_COOLDOWN_MS), { fire: true }, "at the threshold fires");
});

// ── burnPushText ──

test("burnPushText: the rate, the delta, the dearest launch, and 'Nothing was paused.'", () => {
  const { title, body } = burnPushText(S, { label: "architect review · 36 repos", usd: 143.2, share: 0.48 }, "≈ 10 pts");
  assert.match(title, /\+10 points in 2 h/);
  assert.match(body, /rose 10 points in 2 h, about 5 an hour/);
  assert.match(body, /architect review · 36 repos — \$143\.20 at list price ≈ 10 pts, 48% of the stretch/);
  assert.ok(body.endsWith("Nothing was paused."));
  const bare = burnPushText({ ...S, dPts: 1.5, ptsPerHour: 1.2, to: S.from + 75 * MIN }, null, null);
  assert.match(bare.body, /rose 1\.5 points in 1 h 15 min, about 1\.2 an hour\. Nothing was paused\.$/);
  assert.ok(!/Dearest/.test(bare.body), "no launch, no clause");
});
