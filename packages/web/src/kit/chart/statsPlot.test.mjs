/**
 * The token-statistics geometry, pinned without a browser.
 *
 *     node --test packages/web/src/kit/chart/statsPlot.test.mjs
 *
 * The cases here are the ways a statistics dashboard can look finished and be
 * wrong. Real shape of the data it is drawing, measured on one machine: 13.6
 * billion tokens of which 96% are cache reads, 0.007% fresh input, spread over
 * 76 active days inside a 104-day span. Almost every default choice — scale to
 * the total, round a percentage before laying it out, let a bar be as wide as
 * its slot — fails on numbers like that, silently.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  areaRuns,
  areaUnder,
  fillMix,
  fillSeries,
  stackAreas,
  barRows,
  burnRate,
  clockColumns,
  usageOutlook,
  hourPoints,
  rollingMean,
  stacks,
  usageSegments,
  usageMarksText,
  nearestUsage,
  timeTicks,
  usageSpan,
  columns,
  compose,
  dayKey,
  dayTicks,
  isoWeek,
  makeDayPlot,
  nearestDay,
  shiftWeek,
  stepPath,
  weekBounds,
  weekDays,
  weekDelta,
  weekStart,
  weekTotals,
} from "./statsPlot.ts";
import { TOKEN_KINDS, cumulative, dayToMs, hourKeyMs, tokenTotal } from "@waterplane/shared";

const PAD = { top: 8, right: 8, bottom: 18, left: 40 };
const plot = (points, width = 340, height = 150) => makeDayPlot({ width, height, pad: PAD, points });
const pt = (day, v) => ({ day, t: dayToMs(day), v });

// ── the day axis ──────────────────────────────────────────────────────────

test("the x axis is the CALENDAR — a quiet fortnight stays a fortnight wide", () => {
  // The opposite choice to `contextPlot`, on purpose: there a long silence is
  // dead time worth compressing, here it is the fact being shown.
  const p = plot([pt("2026-05-01", 10), pt("2026-05-15", 10), pt("2026-05-16", 10)]);
  const gapA = p.px(dayToMs("2026-05-15")) - p.px(dayToMs("2026-05-01"));
  const gapB = p.px(dayToMs("2026-05-16")) - p.px(dayToMs("2026-05-15"));
  assert.ok(gapA / gapB > 13, `14 days drew ${(gapA / gapB).toFixed(1)}× one day`);
});

test("the first and last columns sit INSIDE the plot", () => {
  const pts = [pt("2026-05-01", 10), pt("2026-05-10", 10)];
  const p = plot(pts);
  for (const q of pts) {
    const x = p.px(q.t);
    assert.ok(x > p.x && x < p.x + p.w, `${q.day} at ${x}, plot ${p.x}..${p.x + p.w}`);
  }
});

test("a single day does not divide by zero", () => {
  const p = plot([pt("2026-05-01", 10)]);
  assert.ok(Number.isFinite(p.px(dayToMs("2026-05-01"))));
  assert.ok(Number.isFinite(p.py(10)));
  assert.ok(p.slot > 0);
});

test("no days at all is a plot, not a crash", () => {
  const p = plot([]);
  assert.ok(Number.isFinite(p.px(0)) && Number.isFinite(p.py(0)));
  assert.equal(stepPath(p, []), "");
  assert.equal(areaUnder(p, []), "");
  assert.equal(nearestDay(p, [], 100), null);
  assert.deepEqual(columns(p, []), []);
});

test("the area closes to the baseline with a COMMAND, not a number splice", () => {
  // The bug `contextPlot` already paid for: dropping the leading `M` instead of
  // replacing it makes `M40,132` butt against `40,20` and parse as `M40,13240`.
  const pts = [pt("2026-05-01", 10), pt("2026-05-02", 20)];
  const p = plot(pts);
  const d = areaUnder(p, pts);
  assert.ok(d.startsWith(`M${p.px(pts[0].t).toFixed(1)},${p.py(0).toFixed(1)}L`), d.slice(0, 40));
  assert.ok(d.endsWith("Z"));
  for (const seg of d.replace(/Z$/, "").split(/(?=[ML])/)) {
    assert.match(seg, /^[ML]-?\d+(?:\.\d+)?,-?\d+(?:\.\d+)?$/, `bad segment ${seg}`);
  }
});

test("x labels are placed by pixel, evenly, and read back as dates", () => {
  const p = plot([pt("2026-05-01", 1), pt("2026-08-31", 1)]);
  const t = dayTicks(p);
  assert.equal(t.length, 3);
  assert.ok(t[0].x < t[1].x && t[1].x < t[2].x);
  assert.deepEqual(t.map((x) => x.anchor), ["start", "middle", "end"]);
  assert.ok(t.every((x) => x.label.length > 0));
});

test("a day axis names days, never clock times", () => {
  const noClock = (ts) => assert.ok(ts.every((x) => !x.label.includes(":")), JSON.stringify(ts));
  const one = plot([pt("2026-10-02", 5)]);
  const t1 = dayTicks(one);
  assert.equal(t1.length, 1);
  assert.equal(t1[0].anchor, "middle");
  assert.ok(Math.abs(t1[0].x - (one.x + one.w / 2)) < 0.001);
  assert.match(t1[0].label, /^2 \S+$/);
  noClock(t1);

  const t3 = dayTicks(plot([pt("2026-10-01", 1), pt("2026-10-03", 1)]));
  assert.equal(t3.length, 3);
  assert.deepEqual(t3.map((x) => x.anchor), ["start", "middle", "end"]);
  assert.ok(t3[0].label.startsWith("1 ") && t3[2].label.startsWith("3 "));
  assert.ok(t3[0].x < t3[1].x && t3[1].x < t3[2].x);
  noClock(t3);

  const gap = dayTicks(plot([pt("2026-10-01", 1), pt("2026-10-05", 1)]));
  assert.equal(gap.length, 5);
  noClock(gap);

  const long = dayTicks(plot([pt("2026-05-01", 1), pt("2026-08-31", 1)]));
  assert.equal(long.length, 3);
  assert.deepEqual(long.map((x) => x.anchor), ["start", "middle", "end"]);
  noClock(long);
  // The edges name the first and last BUCKET, not the padded half-day beyond.
  assert.ok(long[0].label.startsWith("1 ") && long[2].label.startsWith("31 "), JSON.stringify(long));
  const eight = dayTicks(plot([pt("2026-10-10", 1), pt("2026-10-17", 1)]));
  assert.ok(eight[0].label.startsWith("10 ") && eight[2].label.startsWith("17 "), JSON.stringify(eight));
});

test("a day axis survives a DST day in the running zone", (t) => {
  // Find a 23h/25h day this year; zone-free otherwise (skips in UTC).
  let start = null;
  for (let m = 0; m < 12 && !start; m++) {
    for (let d = 1; d <= 28; d++) {
      if (new Date(2026, m, d + 1) - new Date(2026, m, d) !== 86_400_000) { start = [m, d]; break; }
    }
  }
  if (!start) return t.skip("no DST in this zone");
  const [m, d0] = start;
  const days = [-1, 0, 1, 2].map((k) => new Date(2026, m, d0 + k));
  const pts = days.map((dt) => ({ day: "x", t: dt.getTime(), v: 1 }));
  const p = plot(pts);
  const ticks = dayTicks(p);
  assert.equal(ticks.length, 4);
  assert.deepEqual(ticks.map((x) => parseInt(x.label, 10)), days.map((dt) => dt.getDate()), JSON.stringify(ticks));
  ticks.forEach((x, i) => assert.ok(Math.abs(x.x - p.px(pts[i].t)) < 0.001, `tick ${i} off its column`));
  // a gap series ending on the far side of the change
  const gap = dayTicks(plot([pts[0], pts[3]]));
  assert.deepEqual(gap.map((x) => parseInt(x.label, 10)), days.map((dt) => dt.getDate()));
});

test("an intraday plot keeps its clock labels, and a plot knows its step", () => {
  const base = { width: 340, height: 150, pad: PAD };
  const h = (n) => ({ day: "x", t: hourKeyMs(`2026-10-02T${String(n).padStart(2, "0")}`), v: 1 });
  const ip = makeDayPlot({ ...base, points: [h(9), h(14)], stepMs: 3_600_000 });
  assert.ok(dayTicks(ip).some((x) => x.label.includes(":")));
  assert.equal(ip.step, 3_600_000);
  assert.equal(plot([pt("2026-10-02", 1)]).step, 86_400_000);
});

// ── columns ───────────────────────────────────────────────────────────────

test("a column never fills its slot — the leftover is air", () => {
  const pts = Array.from({ length: 5 }, (_, i) => pt(`2026-05-0${i + 1}`, 100));
  const p = plot(pts);
  for (const c of columns(p, pts)) assert.ok(c.w <= p.slot - 2 + 0.001, `${c.w} vs slot ${p.slot}`);
});

test("a column is capped, so five days do not draw five slabs", () => {
  const pts = Array.from({ length: 5 }, (_, i) => pt(`2026-05-0${i + 1}`, 100));
  for (const c of columns(plot(pts), pts)) assert.ok(c.w <= 14);
});

test("with a hundred days in a phone's width a column is still VISIBLE", () => {
  // The slot is under two pixels here. A width rounded to zero is a day that
  // silently did not happen, which on a "how much did I use" screen is the
  // whole failure.
  const pts = Array.from({ length: 100 }, (_, i) => {
    const d = new Date(2026, 4, 1 + i);
    return { day: "x", t: d.getTime(), v: 100 };
  });
  const p = plot(pts, 340, 150);
  const cols = columns(p, pts);
  assert.ok(p.slot < 4, `slot was ${p.slot}, this case is not testing what it claims`);
  assert.ok(cols.every((c) => c.w >= 1), "a column rounded away");
  assert.ok(cols.every((c) => c.h >= 1), "a non-zero day drew no height");
});

test("a zero day draws no column, and a tiny one draws a hairline", () => {
  const pts = [pt("2026-05-01", 0), pt("2026-05-02", 1), pt("2026-05-03", 1e9)];
  const cols = columns(plot(pts), pts);
  assert.equal(cols[0].h, 0);
  assert.ok(cols[1].h >= 1, "one token in a billion-token scale must still show");
});

test("the nearest day is found by time, so width cannot change the answer", () => {
  const pts = [pt("2026-05-01", 1), pt("2026-05-02", 2), pt("2026-05-03", 3)];
  const narrow = plot(pts, 200);
  const wide = plot(pts, 900);
  for (const f of [0.05, 0.5, 0.95]) {
    const a = nearestDay(narrow, pts, narrow.x + narrow.w * f);
    const b = nearestDay(wide, pts, wide.x + wide.w * f);
    assert.equal(a.day, b.day, `f=${f}`);
  }
});

// ── horizontal bars ───────────────────────────────────────────────────────

test("bars scale to the LARGEST row, not to the total", () => {
  // Scaling to the total is the intuitive choice: with this tail it makes every
  // bar but the first a stub and the chart compares nothing.
  const rows = barRows([100, 90, 5, 1], (v) => v, (v) => `r${v}`);
  assert.equal(rows[0].frac, 1);
  assert.ok(rows[1].frac > 0.85, `second bar was ${rows[1].frac}`);
  // The share of the whole is still carried, un-lost.
  assert.ok(Math.abs(rows[0].share - 100 / 196) < 1e-9);
});

test("all-zero rows do not divide by zero", () => {
  const rows = barRows([0, 0], (v) => v, () => "z");
  assert.ok(rows.every((r) => r.frac === 0 && r.share === 0));
});

// ── the composition strip ─────────────────────────────────────────────────

const KINDS = TOKEN_KINDS.map((k) => ({ id: k.id, slot: k.slot, name: k.name }));
const REAL = { input: 979_000, output: 30_000_000, cacheRead: 13_000_000_000, cacheWrite: 459_000_000, turns: 68_785 };

test("every non-zero kind is VISIBLE, even at 0.007% of the whole", () => {
  // Input is 0.0072% of this total. At its true width it is zero pixels, and a
  // part-to-whole chart that omits a part is not one.
  const segs = compose(REAL, KINDS);
  assert.equal(segs.length, 4);
  const input = segs.find((s) => s.kind === "Input");
  assert.ok(input.pct < 0.01, `input really is tiny (${input.pct}%)`);
  assert.ok(input.w >= 1.5, `but it drew ${input.w}% wide`);
});

test("the strip still adds to 100%, and the segments are laid end to end", () => {
  const segs = compose(REAL, KINDS);
  const total = segs.reduce((n, s) => n + s.w, 0);
  assert.ok(Math.abs(total - 100) < 1e-6, `widths summed to ${total}`);
  for (let i = 1; i < segs.length; i++) {
    assert.ok(Math.abs(segs[i].x - (segs[i - 1].x + segs[i - 1].w)) < 1e-6, "a gap or an overlap");
  }
  assert.equal(segs[0].x, 0);
});

test("the true percentage is kept beside the drawn width", () => {
  // The widths are distorted to make the slivers visible; the NUMBERS must not
  // be, because they are what the legend prints.
  const segs = compose(REAL, KINDS);
  for (const s of segs) assert.ok(Math.abs(s.pct - (s.value / tokenTotal(REAL)) * 100) < 1e-9);
  const read = segs.find((s) => s.kind === "Cache read");
  assert.ok(read.pct > 96 && read.pct < 97, `cache read measured ${read.pct}%`);
  assert.ok(read.w < read.pct, "the big segment paid for the slivers");
});

test("a kind that is genuinely zero gets no segment at all", () => {
  const segs = compose({ input: 0, output: 10, cacheRead: 90, cacheWrite: 0, turns: 1 }, KINDS);
  assert.deepEqual(segs.map((s) => s.kind), ["Output", "Cache read"]);
  assert.ok(Math.abs(segs.reduce((n, s) => n + s.w, 0) - 100) < 1e-6);
});

test("nothing at all composes to nothing", () => {
  assert.deepEqual(compose({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0 }, KINDS), []);
});

test("one kind alone takes the whole bar", () => {
  const segs = compose({ input: 0, output: 0, cacheRead: 500, cacheWrite: 0, turns: 1 }, KINDS);
  assert.equal(segs.length, 1);
  assert.equal(segs[0].w, 100);
});

// ── the cumulative series ─────────────────────────────────────────────────

test("cumulative only ever rises, and ends at the sum", () => {
  const days = [
    { day: "2026-05-01", total: 10 },
    { day: "2026-05-02", total: 0 },
    { day: "2026-05-09", total: 5 },
  ];
  const run = cumulative(days);
  assert.deepEqual(run.map((r) => r.sum), [10, 10, 15]);
  for (let i = 1; i < run.length; i++) assert.ok(run[i].sum >= run[i - 1].sum);
});

// ── calendar weeks ────────────────────────────────────────────────────────

const dayRow = (day, v) => ({ day, input: 0, output: v, cacheRead: 0, cacheWrite: 0, turns: 1 });

test("a week starts on MONDAY, and a Sunday belongs to the week before it", () => {
  // 2026-09-07 is a Monday, 2026-09-13 the Sunday that closes the same week.
  const mon = weekStart(dayToMs("2026-09-07"));
  assert.equal(dayKey(mon), "2026-09-07");
  assert.equal(dayKey(weekStart(dayToMs("2026-09-13"))), "2026-09-07");
  assert.equal(dayKey(weekStart(dayToMs("2026-09-14"))), "2026-09-14");
});

test("stepping a week crosses a DST switch without losing an hour", () => {
  // The bug this pins: `start + 7 * 86_400_000` across a spring-forward lands
  // at 23:00 the previous day, so the window opens an hour before Monday and
  // swallows Sunday's last turns into the wrong week.
  for (const anchor of ["2026-03-23", "2026-10-19", "2026-11-02"]) {
    const next = shiftWeek(dayToMs(anchor), 1);
    const d = new Date(next);
    assert.equal(d.getHours(), 0, `${anchor} + 1 week landed at ${d.getHours()}:00`);
    assert.equal(d.getDay(), new Date(dayToMs(anchor)).getDay());
    assert.equal(dayKey(shiftWeek(next, -1)), anchor);
  }
});

test("ISO week numbers, including the ones that change year", () => {
  // 4 January is in week 1 by definition; the days around new year belong to
  // whichever year holds their Thursday.
  assert.deepEqual(isoWeek(dayToMs("2026-01-04")), { year: 2026, week: 1 });
  assert.deepEqual(isoWeek(dayToMs("2026-12-28")), { year: 2026, week: 53 });
  assert.deepEqual(isoWeek(dayToMs("2027-01-03")), { year: 2026, week: 53 });
  assert.deepEqual(isoWeek(dayToMs("2027-01-04")), { year: 2027, week: 1 });
  assert.deepEqual(isoWeek(dayToMs("2026-09-07")), { year: 2026, week: 37 });
});

test("a week view FILLS its gaps — seven days, zeros included, marked as measured or not", () => {
  const rows = weekDays([dayRow("2026-09-08", 10), dayRow("2026-09-11", 5)], dayToMs("2026-09-07"));
  assert.equal(rows.length, 7);
  assert.deepEqual(rows.map((r) => r.day.slice(-2)), ["07", "08", "09", "10", "11", "12", "13"]);
  assert.deepEqual(rows.map((r) => r.present), [false, true, false, false, true, false, false]);
  assert.equal(tokenTotal(weekTotals(rows)), 15);
});

test("weekDays reads only its own week, whatever else the scan holds", () => {
  const rows = weekDays(
    [dayRow("2026-09-06", 99), dayRow("2026-09-08", 10), dayRow("2026-09-14", 99)],
    dayToMs("2026-09-07"),
  );
  assert.equal(tokenTotal(weekTotals(rows)), 10);
});

test("the stepper's bounds stop at the DATA behind, and at this week ahead", () => {
  const now = dayToMs("2026-09-09");
  const b = weekBounds([dayRow("2026-08-20", 1), dayRow("2026-09-08", 1)], now);
  assert.equal(dayKey(b.first), "2026-08-17");
  assert.equal(dayKey(b.last), "2026-09-07");
});

test("with nothing recorded the stepper still offers the current week", () => {
  const now = dayToMs("2026-09-09");
  const b = weekBounds([], now);
  assert.equal(dayKey(b.first), "2026-09-07");
  assert.equal(b.first, b.last);
});

test("the current week is always reachable, even when the last log is old", () => {
  const now = dayToMs("2026-09-09");
  const b = weekBounds([dayRow("2026-06-01", 1)], now);
  assert.equal(dayKey(b.last), "2026-09-07");
  assert.ok(b.first < b.last);
});

test("a change from a week that recorded nothing is ABSENT, not infinity", () => {
  assert.equal(weekDelta(500, 0), null);
  assert.equal(weekDelta(0, 0), null);
  assert.equal(weekDelta(150, 100), 0.5);
  assert.equal(weekDelta(50, 100), -0.5);
});

// ── composition over time ─────────────────────────────────────────────────

const totals = (input, output, cacheRead, cacheWrite) =>
  ({ input, output, cacheRead, cacheWrite, cacheWrite1h: 0, turns: 1 });
const mixRow = (day, t4) => ({ day, t: dayToMs(day), totals: t4 });

test("a normalized stack fills the plot whatever the day's volume was", () => {
  // Two days three orders of magnitude apart. The whole point of normalizing is
  // that they are then comparable, so both columns must be exactly as tall as
  // the plot — a day drawn at 40% height because it was a quiet day is the
  // absolute chart wearing this one's clothes.
  const rows = [mixRow("2026-03-01", totals(1, 1, 96, 2)), mixRow("2026-03-02", totals(900, 900, 96000, 2200))];
  const p = plot(rows.map((r) => ({ day: r.day, t: r.t, v: tokenTotal(r.totals) })));
  const out = stacks(p, rows, KINDS, { normalize: true });
  for (const col of out) {
    const h = col.bands.reduce((n, b) => n + b.h, 0);
    assert.ok(Math.abs(h - p.h) < 1.5, `a normalized column fills the plot (got ${h} of ${p.h})`);
  }
});

test("the absolute stack is as tall as the day's value, and no taller", () => {
  const rows = [mixRow("2026-03-01", totals(10, 10, 960, 20)), mixRow("2026-03-02", totals(1, 1, 96, 2))];
  const p = plot(rows.map((r) => ({ day: r.day, t: r.t, v: tokenTotal(r.totals) })));
  const out = stacks(p, rows, KINDS, { normalize: false });
  const big = out[0].bands.reduce((n, b) => n + b.h, 0);
  const small = out[1].bands.reduce((n, b) => n + b.h, 0);
  assert.ok(big > small * 5, "a day ten times the size is drawn ten times the height");
  assert.ok(Math.abs((p.py(0) - p.py(tokenTotal(rows[0].totals))) - big) < 1.5);
});

test("the bands keep the kinds' own order in every column, whatever the sizes", () => {
  // A stack re-ordered per column by size is unreadable ACROSS columns, which
  // is the only direction anybody reads a stack.
  const rows = [
    mixRow("2026-03-01", totals(500, 1, 1, 1)),
    mixRow("2026-03-02", totals(1, 1, 5000, 1)),
  ];
  const p = plot(rows.map((r) => ({ day: r.day, t: r.t, v: tokenTotal(r.totals) })));
  const out = stacks(p, rows, KINDS, { normalize: true });
  const order = (col) => col.bands.map((b) => b.slot);
  assert.deepEqual(order(out[0]), order(out[1]));
});

test("a kind that is present is never dropped, and a zero day draws nothing", () => {
  const rows = [mixRow("2026-03-01", totals(1, 0, 1_000_000, 0)), mixRow("2026-03-02", totals(0, 0, 0, 0))];
  const p = plot(rows.map((r) => ({ day: r.day, t: r.t, v: tokenTotal(r.totals) })));
  const out = stacks(p, rows, KINDS, { normalize: true });
  assert.equal(out[0].bands.length, 2, "both present kinds are drawn, however small one is");
  assert.ok(out[0].bands.every((b) => b.h >= 1), "…and neither rounds to nothing");
  assert.equal(out[1].bands.length, 0, "a day with no tokens has no bands, not four zero-height ones");
});

// ── the trend line ────────────────────────────────────────────────────────

test("the rolling mean divides by the CALENDAR window, so a quiet day counts", () => {
  // Seven consecutive days of 70 each: the mean is 70. Then a gap. The next
  // point's window holds one day of data and six of silence, so its mean must
  // be ~1/7 of the value, not the value — a by-index mean would report 70 again
  // and draw a flat line through a week off.
  const days = ["2026-03-01", "2026-03-02", "2026-03-03", "2026-03-04", "2026-03-05", "2026-03-06", "2026-03-07"]
    .map((d) => pt(d, 70));
  const mean = rollingMean(days, 7);
  assert.equal(mean.length, 1, "no point is emitted before the window is full");
  assert.equal(mean[0].day, "2026-03-07");
  assert.ok(Math.abs(mean[0].v - 70) < 1e-9);

  const withGap = [...days, pt("2026-03-20", 70)];
  const m2 = rollingMean(withGap, 7);
  const last = m2[m2.length - 1];
  assert.equal(last.day, "2026-03-20");
  assert.ok(Math.abs(last.v - 10) < 1e-9, `a lone day in a seven-day window means 70/7 (got ${last.v})`);
});

test("the mean is absent rather than ramped while the window is not yet full", () => {
  assert.deepEqual(rollingMean([pt("2026-03-01", 10)], 7), []);
  assert.deepEqual(rollingMean([pt("2026-03-01", 10), pt("2026-03-02", 10)], 7), []);
  assert.equal(rollingMean([pt("2026-03-01", 10), pt("2026-03-07", 10)], 7).length, 1);
});

// ── the clock face ────────────────────────────────────────────────────────

const BOX = { x: 0, y: 0, w: 240, h: 100 };

test("every hour of the clock is drawn, including the ones nobody ever worked", () => {
  const vals = Array.from({ length: 24 }, (_, h) => (h === 14 ? 1000 : h === 9 ? 10 : 0));
  const cols = clockColumns(vals, BOX);
  assert.equal(cols.length, 24, "a missing hour is an empty slot, not a missing column");
  assert.equal(cols[3].h, 0, "…and an hour with nothing in it has no bar at all");
  assert.ok(cols[9].h >= 1, "an hour with a little work is still visible");
  assert.ok(Math.abs(cols[14].h - BOX.h) < 1e-9, "the busiest hour fills the box");
  // Equal widths and no overlap: this is a clock face, not a time axis.
  const w = cols[0].w;
  assert.ok(cols.every((c) => Math.abs(c.w - w) < 1e-9));
  for (let i = 1; i < cols.length; i++) assert.ok(cols[i].x >= cols[i - 1].x + cols[i - 1].w);
});

test("an empty corpus draws no bars rather than 24 full-height ones", () => {
  const cols = clockColumns(Array(24).fill(0), BOX);
  assert.ok(cols.every((c) => c.h === 0 && c.share === 0));
});

// ── the limit windows' history ────────────────────────────────────────────

const MIN = 60_000;
const sample = (t, s, w, sr, wr = null) => ({ t, s, w, sr, wr });

test("a window rollover CUTS the line instead of drawing a cliff", () => {
  const t0 = Date.parse("2026-09-10T08:00:00Z");
  // The reset instants are the ones a real scrape carries: a five-hour window
  // ending at 10:00, then the next one ending at 15:00.
  const r1 = Date.parse("2026-09-10T10:00:00Z");
  const r2 = Date.parse("2026-09-10T15:00:00Z");
  const rows = [
    sample(t0, 10, 20, r1),
    sample(t0 + 10 * MIN, 40, 21, r1),
    sample(t0 + 20 * MIN, 80, 22, r1),
    // The window rolled: the figure drops, and the reset instant it named moved.
    sample(t0 + 30 * MIN, 3, 23, r2),
    sample(t0 + 40 * MIN, 9, 24, r2),
  ];
  const segs = usageSegments(rows, "session");
  assert.equal(segs.length, 2, "two windows, two polylines");
  assert.equal(segs[0].pts.length, 3);
  assert.equal(segs[1].rolled, true, "…and the second one knows it begins a new window");
  assert.equal(segs[0].rolled, false, "the first segment never claims a rollover");
});

test("a reset instant that jitters by a minute is the SAME window, not a rollover", () => {
  // What the daemon actually logged on 2026-09-24: the CLI prints a wall-clock
  // minute and recomputes it as the window slides, so one window is scraped as
  // 10:59 and then as 11:00. Compared with `!==`, every one of those flips cut
  // the line and drew a dashed rule — dozens of marks for windows that never
  // ended, which is what made the strip unreadable.
  const t0 = Date.parse("2026-09-24T06:00:00Z");
  const a = Date.parse("2026-09-24T10:59:00Z");
  const b = Date.parse("2026-09-24T11:00:00Z");
  const rows = [
    sample(t0, 2, 91, a),
    sample(t0 + 8 * MIN, 3, 92, b),
    sample(t0 + 16 * MIN, 3, 92, a),
    sample(t0 + 24 * MIN, 4, 92, b),
  ];
  const segs = usageSegments(rows, "session");
  assert.equal(segs.length, 1, "one window, one polyline");
  assert.equal(segs[0].pts.length, 4);
  assert.equal(usageSegments(rows, "week").length, 1, "and the same for the weekly line");
});

test("a reading whose reset the screen did not print is not itself a rollover", () => {
  // Null is unknown, never "different". A window whose reset the screen simply
  // did not print, with the figure standing still, is one line.
  const t0 = Date.parse("2026-09-10T08:00:00Z");
  const r = Date.parse("2026-09-10T10:00:00Z");
  const rows = [sample(t0, 7, 20, r), sample(t0 + 8 * MIN, 7, 20, null), sample(t0 + 16 * MIN, 8, 20, r)];
  assert.equal(usageSegments(rows, "session").length, 1);
});

test("the figure FALLING is a rollover even when no reset is named — and cuts once, not twice", () => {
  // The shape a real five-hour window makes, and the one the reset instants
  // alone cannot see: the reading taken as the window rolls is 0% with no
  // reset in force to name, so the instants either side are only ever compared
  // against an unknown. Drawn as one line it says usage came back.
  const t0 = Date.parse("2026-09-24T06:00:00Z");
  const r1 = Date.parse("2026-09-24T08:00:00Z");
  const r2 = Date.parse("2026-09-24T13:00:00Z");
  const rows = [
    sample(t0, 5, 90, r1),
    sample(t0 + 30 * MIN, 7, 90, r1),
    sample(t0 + 40 * MIN, 0, 90, null),   // it rolled: no window, so no instant
    sample(t0 + 50 * MIN, 1, 90, r2),     // …and only now is the new one named
    sample(t0 + 60 * MIN, 2, 90, r2),
  ];
  const segs = usageSegments(rows, "session", 45 * MIN);
  assert.equal(segs.length, 2, "one cut, at the drop — not a second one when the new instant appears");
  assert.equal(segs[0].pts.length, 2);
  assert.equal(segs[1].pts.length, 3);
  assert.equal(segs[1].rolled, true);

  // A point of slack: the scraped figure is an integer and the screen can
  // correct itself by one. That is not a new window.
  const wobble = [sample(t0, 41, 90, r1), sample(t0 + 10 * MIN, 40, 90, r1)];
  assert.equal(usageSegments(wobble, "session").length, 1, "a one-point correction is not a rollover");
});

test("a reading carries the reset instant it named, so a past point can say which window it is in", () => {
  const t0 = Date.parse("2026-09-10T08:00:00Z");
  const r = Date.parse("2026-09-10T10:00:00Z");
  const segs = usageSegments([sample(t0, 7, 20, r), sample(t0 + 8 * MIN, 9, 20, r)], "session");
  assert.equal(segs[0].pts[0].r, r);
  assert.equal(nearestUsage(segs, t0 + 7 * MIN).t, t0 + 8 * MIN, "nearest is by TIME, not by index");
  assert.equal(nearestUsage([], t0), null);
});

test("the time labels land on instants a person reads, and inside the span", () => {
  const t0 = Date.parse("2026-09-10T08:13:00Z");
  const t1 = t0 + 24 * 3600_000;
  const ticks = timeTicks(t0, t1, 4);
  assert.ok(ticks.length >= 2 && ticks.length <= 4, `got ${ticks.length} labels`);
  assert.ok(ticks.every((t) => t >= t0 && t <= t1), "no label outside the axis");
  const step = ticks[1] - ticks[0];
  assert.ok(ticks.every((t, i) => i === 0 || Math.abs(t - ticks[i - 1] - step) < 1000), "one even step");
  // Aligned to LOCAL midnight, so the label is a round time on the clock the
  // reader is holding rather than a round offset from the epoch.
  const d = new Date(ticks[0]);
  assert.equal(d.getMinutes(), 0);
  assert.equal(d.getSeconds(), 0);
  assert.deepEqual(timeTicks(t1, t0), [], "a backwards or empty span has no labels");
});

test("the week chart spans the WEEK the reset closes, not the last day", () => {
  const now = Date.parse("2026-09-24T11:46:00Z");
  const reset = Date.parse("2026-09-24T19:00:00Z");
  const w = usageSpan("week", reset, now);
  assert.deepEqual(w, { t0: reset - 7 * 86_400_000, t1: reset, isWindow: true });
  // The five-hour chart is unchanged: the last day, ending now.
  assert.deepEqual(usageSpan("session", reset, now), { t0: now - 24 * 3600_000, t1: now, isWindow: false });
  // A reset already past describes an ended window — a span, never that window.
  assert.deepEqual(usageSpan("week", now - 1, now), { t0: now - 7 * 86_400_000, t1: now, isWindow: false });
  assert.equal(usageSpan("week", null, now).isWindow, false);
});

test("the marks are explained only where they are DRAWN", () => {
  const t0 = Date.parse("2026-09-10T08:00:00Z");
  const r1 = Date.parse("2026-09-10T10:00:00Z");
  const r2 = Date.parse("2026-09-10T15:00:00Z");
  const one = usageSegments([sample(t0, 1, 20, r1), sample(t0 + 8 * MIN, 2, 20, r1)], "session");
  assert.equal(usageMarksText(one), null, "an unbroken line explains nothing");

  // The rule is how a rollover is DRAWN — method, so it is `more` (folded);
  // a break is a stretch nobody read — an absence, so it is `lead` (open).
  const rolled = usageSegments([sample(t0, 1, 20, r1), sample(t0 + 8 * MIN, 2, 20, r2)], "session");
  const rw = usageMarksText(rolled);
  assert.match(rw.more, /dashed rule/);
  assert.equal(rw.lead, null, "no gap was drawn, so no gap is described");

  const gapped = usageSegments([sample(t0, 1, 20, r1), sample(t0 + 300 * MIN, 2, 20, r1)], "session", 45 * MIN);
  const gw = usageMarksText(gapped);
  assert.match(gw.lead, /break in the line/);
  assert.equal(gw.more, null, "nothing rolled over, so no rule is described");
});

test("a stretch nobody observed is a gap, never a line drawn across it", () => {
  const t0 = Date.parse("2026-09-10T08:00:00Z");
  const rows = [
    sample(t0, 10, 20, 1000),
    sample(t0 + 10 * MIN, 12, 20, 1000),
    sample(t0 + 400 * MIN, 30, 22, 1000),  // nobody looked for nearly seven hours
  ];
  const segs = usageSegments(rows, "session", 45 * MIN);
  assert.equal(segs.length, 2);
  assert.equal(segs[1].rolled, false, "a gap is a gap — it must not be reported as a rollover");
});

test("a reading the screen did not print is dropped, never zeroed", () => {
  const t0 = Date.parse("2026-09-10T08:00:00Z");
  const rows = [sample(t0, 10, null, 1000), sample(t0 + 5 * MIN, 12, null, 1000)];
  assert.equal(usageSegments(rows, "session")[0].pts.length, 2);
  assert.deepEqual(usageSegments(rows, "week"), [], "the weekly line has no points, rather than two at 0%");
});

test("a burn rate needs two readings far enough apart, in ONE window", () => {
  const t0 = Date.parse("2026-09-10T08:00:00Z");
  const near = usageSegments([sample(t0, 10, 1, 1000), sample(t0 + 5 * MIN, 20, 1, 1000)], "session");
  assert.equal(burnRate(near), null, "five minutes is not a rate, it is a sample");

  // 30 minutes: past the 20-minute floor, and inside the 45-minute gap cut —
  // a rate is only ever measured across a stretch that was actually observed.
  const ok = usageSegments([sample(t0, 10, 1, 1000), sample(t0 + 30 * MIN, 17.5, 1, 1000)], "session");
  assert.ok(Math.abs(burnRate(ok) - 15) < 1e-9, "7.5 points in half an hour is 15%/h");

  // An unobserved stretch is not a measurement either: the segment is cut, so
  // the newest one holds a single reading and there is no rate.
  const sparse = usageSegments([sample(t0, 10, 1, 1000), sample(t0 + 90 * MIN, 40, 1, 1000)], "session");
  assert.equal(burnRate(sparse), null, "a rate across ninety unobserved minutes is not a rate");

  // Across a rollover the newest segment is the only one measured, and a
  // segment whose figure went DOWN has no rate at all.
  const down = usageSegments([sample(t0, 80, 1, 1000), sample(t0 + 30 * MIN, 10, 1, 1000)], "session");
  assert.equal(burnRate(down), null);
  assert.equal(burnRate([]), null);
});

test("a projection is a TIME when it fills first and a LEVEL when it resets first", () => {
  const now = Date.parse("2026-09-10T08:00:00Z");
  // 10%/h from 50% is five hours to full.
  const soon = usageOutlook(50, 10, now + 9 * 3600_000, now);
  assert.equal(soon.kind, "full");
  assert.ok(Math.abs(soon.at - (now + 5 * 3600_000)) < 1000);

  // The window resets first. This used to be silence, which reads as a
  // projection that could not be made rather than as the good news it is.
  const sat = usageOutlook(50, 10, now + 2 * 3600_000, now);
  assert.equal(sat.kind, "lasts");
  assert.ok(Math.abs(sat.pctAtReset - 70) < 1e-9, "50% plus two hours at 10%/h");

  // The real screenshot's five-hour window: 6% used, 0.8%/h, 2h47m to go —
  // nowhere near full, and the honest answer is a number rather than nothing.
  const idle = usageOutlook(6, 0.8, now + 2.75 * 3600_000, now);
  assert.equal(idle.kind, "lasts");
  assert.ok(idle.pctAtReset > 8 && idle.pctAtReset < 9);

  // No reset instant on the screen: the date is still projectable, and it is
  // the only branch that can be, since there is nothing to land before.
  assert.equal(usageOutlook(50, 10, null, now).kind, "full");

  // Absent, never invented.
  assert.equal(usageOutlook(50, 0, null, now), null, "a flat window never fills");
  assert.equal(usageOutlook(null, 10, null, now), null);
  assert.equal(usageOutlook(100, 10, null, now), null);
  assert.equal(usageOutlook(50, 10, now - 60_000, now), null,
    "a reset that has already passed describes a window that ENDED — project nothing from it");
});

// ── the intraday axis ─────────────────────────────────────────────────────

test("hours are plotted as instants an hour apart, not as 24 categories", () => {
  const rows = [{ hour: "2026-03-10T09" }, { hour: "2026-03-10T10" }, { hour: "2026-03-11T09" }];
  const pts = hourPoints(rows, () => 1, hourKeyMs);
  assert.equal(pts[1].t - pts[0].t, 3_600_000);
  assert.equal(pts[2].t - pts[1].t, 23 * 3_600_000,
    "the overnight gap is 23 hours of elapsed time, not one slot");
  const p = makeDayPlot({ width: 340, height: 150, pad: PAD, points: pts, stepMs: 3_600_000 });
  assert.ok(p.px(pts[2].t) > p.px(pts[1].t));
  assert.ok(p.slot < p.w / 20, "an hour occupies an hour's worth of a day-long axis");
});

test("a percentage axis is fixed at 100, never fitted to its own peak", () => {
  const pts = [pt("2026-03-01", 8), pt("2026-03-02", 15)];
  const p = makeDayPlot({ width: 340, height: 150, pad: PAD, points: pts, yMax: 100 });
  assert.equal(p.yMax, 100);
  assert.deepEqual(p.yTicks, [0, 25, 50, 75, 100]);
  assert.ok(p.py(15) > p.py(100), "15% is near the floor, not at the ceiling");
});


// ── the area forms ────────────────────────────────────────────────────────

const tot = (o) => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, turns: 0, ...o });
const row4 = (day, o) => mixRow(day, tot(o));

/** A day nothing happened on, in the caller's own row shape — `fillMix` takes
 *  this rather than building one, because the row carries more than its totals
 *  now (the per-model split, the subagent launches) and a blank rebuilt from
 *  `{t, day, totals}` would drop both. */
const blankMix = (t, day) => ({ t, day, totals: tot({}), byModel: [], agents: [] });

test("a skipped day is filled in as the ZERO it was measured to be", () => {
  // The one series on this screen where filling is honest: the scan walks every
  // conversation log, so a day missing from `days` had no turns in it. An area
  // drawn over the unfilled series slopes across the quiet week as if the work
  // had tapered.
  const out = fillSeries([pt("2026-05-01", 10), pt("2026-05-05", 20)]);
  assert.deepEqual(out.map((d) => d.day),
    ["2026-05-01", "2026-05-02", "2026-05-03", "2026-05-04", "2026-05-05"]);
  assert.deepEqual(out.map((d) => d.v), [10, 0, 0, 0, 20]);
  assert.deepEqual(out.map((d) => d.t), out.map((d) => dayToMs(d.day)),
    "a filled day sits at its own local midnight");
});

test("the fill never runs past the record at either end", () => {
  const out = fillSeries([pt("2026-05-02", 1), pt("2026-05-04", 1)]);
  assert.equal(out[0].day, "2026-05-02");
  assert.equal(out[out.length - 1].day, "2026-05-04");
});

test("a fortnight of missing hours is filled hour by hour, not day by day", () => {
  const pts = hourPoints([{ hour: "2026-03-10T09" }, { hour: "2026-03-10T12" }], () => 5, hourKeyMs);
  const out = fillSeries(pts, 3_600_000);
  assert.deepEqual(out.map((d) => d.day),
    ["2026-03-10T09", "2026-03-10T10", "2026-03-10T11", "2026-03-10T12"]);
  assert.deepEqual(out.map((d) => d.v), [5, 0, 0, 5]);
});

test("a window too wide to fill is NULL, never a half-filled series", () => {
  // Half a filled series is a chart whose right-hand end silently means
  // something else. The caller draws columns and says why instead.
  assert.equal(fillSeries([pt("2020-01-01", 1), pt("2026-01-01", 1)], 86_400_000, 100), null);
  assert.equal(fillMix([row4("2020-01-01", { input: 1 }), row4("2026-01-01", { input: 1 })], blankMix, 100), null);
});

test("one point, or none, needs no filling and says so", () => {
  assert.deepEqual(fillSeries([]), []);
  assert.equal(fillSeries([pt("2026-05-01", 3)]).length, 1);
});

test("the day walk survives a DST switch", () => {
  // `+ 86_400_000` lands at 23:00 of the previous day across a spring forward,
  // and every key after it is off by one.
  const out = fillSeries([pt("2026-03-28", 1), pt("2026-04-01", 1)]);
  assert.deepEqual(out.map((d) => d.day),
    ["2026-03-28", "2026-03-29", "2026-03-30", "2026-03-31", "2026-04-01"]);
});

test("the hour walk keeps a fall-back hour ONCE: the store merged its two passes into one key", () => {
  // Berlin 2026-10-25: 03:00 CEST falls back to 02:00 CET, so 00:00Z and 01:00Z both key T02.
  // Pushing the merged point twice made the filled series count that hour double.
  const prev = process.env.TZ;
  process.env.TZ = "Europe/Berlin";
  try {
    const pts = hourPoints([{ hour: "2026-10-25T01" }, { hour: "2026-10-25T02" }, { hour: "2026-10-25T04" }], () => 5, hourKeyMs);
    const out = fillSeries(pts, 3_600_000);
    assert.deepEqual(out.map((d) => d.day), ["2026-10-25T01", "2026-10-25T02", "2026-10-25T03", "2026-10-25T04"]);
    assert.deepEqual(out.map((d) => d.v), [5, 5, 0, 5]);
  } finally {
    if (prev === undefined) delete process.env.TZ;
    else process.env.TZ = prev;
  }
});

test("a mix row that was never recorded is four zeros, not an unknown split", () => {
  const out = fillMix([row4("2026-05-01", { input: 10 }), row4("2026-05-03", { input: 30 })], blankMix);
  assert.equal(out.length, 3);
  assert.equal(tokenTotal(out[1].totals), 0);
  assert.equal(out[1].day, "2026-05-02");
});

test("an ABSOLUTE stack joins every bucket, zeros included — the floor is the reading", () => {
  const rows = [row4("2026-05-01", { input: 10 }), row4("2026-05-02", {}), row4("2026-05-03", { input: 10 })];
  assert.deepEqual(areaRuns(rows, false, KINDS), [[0, 1, 2]]);
});

test("a NORMALIZED stack is cut at a day with nothing in it", () => {
  // A day with no tokens has no mix. Rescaling it to 100% of nothing would
  // invent a split and hold it flat across the gap.
  const rows = [row4("2026-05-01", { input: 10 }), row4("2026-05-02", {}), row4("2026-05-03", { input: 10 })];
  assert.deepEqual(areaRuns(rows, true, KINDS), [[0], [2]]);
});

test("the bands stack in KIND order, bottom-first, and tile the column exactly", () => {
  const rows = [
    row4("2026-05-01", { input: 1, output: 2, cacheRead: 96, cacheWrite: 1 }),
    row4("2026-05-02", { input: 1, output: 2, cacheRead: 96, cacheWrite: 1 }),
  ];
  const p = makeDayPlot({ width: 340, height: 150, pad: PAD, points: rows.map((r) => ({ ...r, v: 100 })), yMax: 100 });
  const bands = stackAreas(p, rows, KINDS, { normalize: true });
  assert.deepEqual(bands.map((b) => b.slot), KINDS.map((k) => k.slot));
  // The top edge of one band is the bottom edge of the next: read the y of the
  // first point of every band's top boundary and of the band below it.
  const firstY = (d) => Number(d.slice(1).split("L")[0].split(",")[1]);
  const ys = bands.map((b) => firstY(b.d));
  for (let i = 1; i < ys.length; i++) assert.ok(ys[i] < ys[i - 1], "each band sits on the one below it");
  // Bottom of the first band is the baseline; top of the last is the ceiling.
  assert.ok(Math.abs(ys[ys.length - 1] - p.y) < 0.2, `top band starts at ${ys[ys.length - 1]}, plot top ${p.y}`);
});

test("every band is a closed sub-path of well-formed commands", () => {
  const rows = [row4("2026-05-01", { input: 5, cacheRead: 95 }), row4("2026-05-02", { input: 5, cacheRead: 95 })];
  const p = makeDayPlot({ width: 340, height: 150, pad: PAD, points: rows.map((r) => ({ ...r, v: 100 })), yMax: 100 });
  for (const b of stackAreas(p, rows, KINDS, { normalize: true })) {
    if (!b.d) continue;
    assert.ok(b.d.startsWith("M") && b.d.endsWith("Z"), b.d.slice(0, 30));
    for (const seg of b.d.replace(/Z/g, "").split(/(?=[ML])/)) {
      assert.match(seg, /^[ML]-?\d+(?:\.\d+)?,-?\d+(?:\.\d+)?$/, `bad segment ${seg}`);
    }
  }
});

test("a run of ONE day is widened to its slot — an area through one point is nothing", () => {
  // How the week view came out blank on a Monday: a single point is a line with
  // no length and an area with no width.
  const rows = [row4("2026-05-01", { input: 10 }), row4("2026-05-02", {}), row4("2026-05-03", { input: 10 })];
  const p = makeDayPlot({ width: 340, height: 150, pad: PAD, points: rows.map((r) => ({ ...r, v: 10 })), yMax: 100 });
  const band = stackAreas(p, rows, KINDS, { normalize: true })[0];
  const xs = band.d.split(/[ML]/).filter(Boolean).map((s) => Number(s.split(",")[0]));
  const wide = Math.max(...xs) - Math.min(...xs);
  assert.ok(wide > p.slot * 0.9, `one-day run drew ${wide}px across a ${p.slot}px slot`);
});

test("no rows is no bands, not a crash", () => {
  const p = makeDayPlot({ width: 340, height: 150, pad: PAD, points: [] });
  assert.deepEqual(areaRuns([], true, KINDS), []);
  assert.deepEqual(stackAreas(p, [], KINDS, { normalize: true }).map((b) => b.d), KINDS.map(() => ""));
});

test("a kind that is absent from a day draws no band there, and the rest still tile", () => {
  const rows = [row4("2026-05-01", { cacheRead: 100 }), row4("2026-05-02", { input: 50, cacheRead: 50 })];
  const p = makeDayPlot({ width: 340, height: 150, pad: PAD, points: rows.map((r) => ({ ...r, v: 100 })), yMax: 100 });
  const bands = stackAreas(p, rows, KINDS, { normalize: true });
  const input = bands.find((b) => b.slot === 0);
  assert.ok(input.d, "an input band exists — it is zero-height on day one, not missing");
  const read = bands.find((b) => b.slot === 2);
  assert.ok(read.d.includes("L"), read.d.slice(0, 40));
});

test("modelBands: every model of a family gets a band, newest in the full hue, older in its tints", async () => {
  const { modelBands } = await import("./statsPlot.ts");
  // All-time volume order: last month's ids out-rank this week's.
  const m = modelBands([
    "claude-fable-5", "claude-opus-5", "claude-opus-5-5", "claude-sonnet-5-5",
    "claude-fable-5-1", "claude-haiku-4-5", "claude-haiku-5-5", "gpt-x",
  ].map((key) => ({ key, label: key })));
  assert.deepEqual(m.bands.map((b) => [b.alias, b.slot]), [
    ["claude-fable-5-1", 1], ["claude-fable-5", 6],
    ["claude-opus-5-5", 3], ["claude-opus-5", 8],
    ["claude-sonnet-5-5", 2],
    ["claude-haiku-5-5", 0], ["claude-haiku-4-5", 5],
  ]);
  assert.equal(m.restName, "gpt-x");
});

test("time labels stay on the clock across a DST change", () => {
  // Berlin's week of 2026-10-22 18:00 → 10-29 18:00 crosses the end of summer
  // time on the 25th. Stepping by fixed milliseconds put every label after it
  // at 23:00 the day before ("Sa, 23:00, 23:00"). Run under TZ=Europe/Berlin
  // to exercise the change; in any zone every label is a local midnight.
  const t0 = new Date(2026, 9, 22, 18).getTime();
  const t1 = new Date(2026, 9, 29, 18).getTime();
  const ticks = timeTicks(t0, t1, 4);
  assert.ok(ticks.length >= 2, `got ${ticks.length} labels`);
  for (const t of ticks) assert.equal(new Date(t).getHours(), 0, new Date(t).toString());
  const sub = timeTicks(new Date(2026, 9, 24, 12).getTime(), new Date(2026, 9, 26, 12).getTime(), 8);
  for (const t of sub) assert.equal(new Date(t).getHours() % 6, 0, new Date(t).toString());
});
