/**
 * The context graph's geometry, pinned without a browser.
 *
 * Same arrangement as `activityRows.test.mjs`: the module has no DOM in it, so
 * `node --test` runs it straight over the TypeScript using node's own type
 * stripping, and `npm run test:unit` discovers it.
 *
 *     node --test packages/web/src/contextPlot.test.mjs
 *
 * Worth pinning because a chart fails silently. Every case below is a way this
 * could draw something plausible and wrong: a ceiling line clipped off the top
 * so the curve looks safe, a wall after the last reading falling off the right
 * edge, a single-reading series dividing by zero and painting nothing, a
 * tooltip and a table describing one event two different ways.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  areaPath,
  eventLabel,
  fmtAxisTime,
  fmtTokens,
  fmtTokensFine,
  linePath,
  makePlot,
  nearestSample,
  yScale,
  pctScale,
  fmtYTick,
  fmtReading,
  fmtGap,
  timeScale,
  GAP_BREAK_MS,
  seriesSummary,
  sparkGeom,
  spendSparkGeom,
  spendSparkTitle,
  axisNote,
  hasSpend,
  spendFacts,
  spendSummary,
  spendNote,
  stackBands,
  agentPeak,
  agentLines,
  kindSeries,
  modelSeries,
  modelSlots,
  modelLabel,
  agentLanes,
  agentAtPoint,
  agentConcurrency,
  agentReadout,
  agentSpendBand,
  agentUndatedText,
  laneGeom,
  agentSummary,
  spendSplit,
  splitNote,
  splitSummary,
  USED,
} from "./contextPlot.ts";
import { REST_SLOT } from "./modelHue.ts";

const PAD = { top: 8, right: 8, bottom: 18, left: 34 };
const T0 = Date.parse("2026-09-01T10:00:00.000Z");
const plot = (samples, events = [], refs = [], windowTok = null) =>
  makePlot({ width: 300, height: 120, pad: PAD, samples, events, refs, windowTok });

test("fmtTokens is one wording for axis and tooltip alike", () => {
  assert.equal(fmtTokens(912), "912");
  assert.equal(fmtTokens(184_000), "184k");
  assert.equal(fmtTokens(1_200_000), "1.2M");
  assert.equal(fmtTokens(1_000_000), "1M");
});

test("the row readout keeps one decimal below 10k, and agrees above it", () => {
  // A sparkline's label is the only number on its line: 1,800 and 2,400 must
  // not both read "2k".
  assert.equal(fmtTokensFine(1_800), "1.8k");
  assert.equal(fmtTokensFine(2_400), "2.4k");
  assert.equal(fmtTokensFine(2_000), "2k");
  assert.equal(fmtTokensFine(912), "912");
  // Above 10k the decimal says nothing, so the two formats agree exactly.
  for (const n of [10_000, 83_400, 184_000, 1_200_000]) {
    assert.equal(fmtTokensFine(n), fmtTokens(n));
  }
  assert.equal(fmtTokensFine(Number.NaN), "?");
});

test("axis time precision follows the SPAN, not the value", () => {
  const t = Date.parse("2026-09-01T13:40:00");
  assert.match(fmtAxisTime(t, 3600_000), /^\d\d:\d\d$/);          // minutes apart
  assert.match(fmtAxisTime(t, 3 * 86_400_000), /Sep.*\d\d:\d\d/);  // days apart
  assert.doesNotMatch(fmtAxisTime(t, 30 * 86_400_000), /:/);       // a month apart
});

test("the axis top IS the last tick — one computation, never two", () => {
  // The bug this pins, seen in a render: the domain was rounded to 250k and
  // the ticks were then computed over 250k, giving a tick labelled 300k that
  // sat at the top of a plot nothing could reach. Every reading was a third
  // lower than the axis claimed.
  for (const max of [184_000, 200_000, 881_715, 6_512, 1]) {
    const { top, ticks } = yScale(max);
    assert.equal(ticks[0], 0);
    assert.equal(ticks[ticks.length - 1], top, `top ${top} vs last tick ${ticks[ticks.length - 1]}`);
    assert.ok(top >= max, `${top} does not contain ${max}`);
    assert.ok(ticks.length >= 3 && ticks.length <= 8, `${ticks.length} ticks for ${max}`);
  }
  assert.deepEqual(yScale(0).ticks[0], 0);
});

test("the axis does not squash the curve into the bottom of the plot", () => {
  // A 200k window used to round its step to 100k and top out at 300k, i.e. the
  // whole conversation in the lower 60%. The headroom should be modest.
  const { top } = yScale(200_000);
  assert.ok(top <= 260_000, `200k window topped out at ${top}`);
});

test("the y domain CONTAINS every reference line it will draw", () => {
  // The curve tops out at 90k but the window is 1M: a domain fitted to the
  // curve would clip the ceiling off and make the session look nowhere near it.
  const p = plot([{ t: T0, tok: 90_000 }], [], [1_000_000], null);
  assert.ok(p.yMax >= 1_000_000);
  assert.equal(p.yMax, p.yTicks[p.yTicks.length - 1]);
  const yRef = p.py(1_000_000);
  assert.ok(yRef >= p.y && yRef <= p.y + p.h, `ceiling at ${yRef} outside [${p.y}, ${p.y + p.h}]`);
});

test("a wall AFTER the last reading is inside the time domain", () => {
  const wall = T0 + 7_200_000;
  const p = plot([{ t: T0, tok: 90_000 }], [{ kind: "limit", t: wall, resetAt: wall + 3_600_000 }]);
  // Both the rejection and the reset it names have to fit — the band is drawn
  // between them.
  for (const t of [wall, wall + 3_600_000]) {
    const x = p.px(t);
    assert.ok(x >= p.x && x <= p.x + p.w + 0.001, `${t} → ${x} outside the plot`);
  }
});

test("a single reading does not divide by zero", () => {
  const p = plot([{ t: T0, tok: 50_000 }]);
  assert.ok(Number.isFinite(p.px(T0)));
  assert.ok(Number.isFinite(p.py(50_000)));
  assert.notEqual(linePath(p, [{ t: T0, tok: 50_000 }]), "");
});

test("an empty series draws nothing rather than a stray M0,0", () => {
  const p = plot([]);
  assert.equal(linePath(p, []), "");
  assert.equal(areaPath(p, []), "");
});

test("the area closes to the baseline with a COMMAND, not a number splice", () => {
  // Caught in a render: dropping the line path's leading `M` instead of
  // replacing it left `M40,200` butted against `40,113`, which parses as
  // `M40,20040` — the fill entered from off the top and stuck a wedge out of
  // the left of the plot. So the assertion is on the command, not just the
  // start and the end.
  const s = [{ t: T0, tok: 10_000 }, { t: T0 + 1_000, tok: 20_000 }];
  const p = plot(s);
  const d = areaPath(p, s);
  assert.ok(d.startsWith(`M${p.px(T0).toFixed(1)},${p.py(0).toFixed(1)}L`), d.slice(0, 40));
  assert.ok(d.endsWith("Z"));
  // Every coordinate pair is introduced by a command letter: no two numbers
  // may ever run together, whatever the geometry.
  assert.doesNotMatch(d, /\d[ ]*,[ ]*\d+(?:\.\d+)?\d*,/);
  for (const seg of d.replace(/Z$/, "").split(/(?=[ML])/)) {
    assert.match(seg, /^[ML]-?\d+(?:\.\d+)?,-?\d+(?:\.\d+)?$/, `bad segment ${seg}`);
  }
});

test("the miniature's area closes with a command too", () => {
  const g = sparkGeom(spark(), 72, 18);
  assert.ok(g.area.startsWith("M0,18L"), g.area.slice(0, 20));
  for (const seg of g.area.replace(/Z$/, "").split(/(?=[ML])/)) {
    assert.match(seg, /^[ML]-?\d+(?:\.\d+)?,-?\d+(?:\.\d+)?$/, `bad segment ${seg}`);
  }
});

test("the nearest reading is found by time, so width cannot change the answer", () => {
  const s = [{ t: T0, tok: 1 }, { t: T0 + 10_000, tok: 2 }, { t: T0 + 20_000, tok: 3 }];
  const wide = makePlot({ width: 900, height: 120, pad: PAD, samples: s, events: [], refs: [], windowTok: null });
  const narrow = plot(s);
  const frac = 0.9; // near the right-hand end
  const hitW = nearestSample(wide, s, wide.x + wide.w * frac);
  const hitN = nearestSample(narrow, s, narrow.x + narrow.w * frac);
  assert.equal(hitW.t, hitN.t);
  assert.equal(hitW.tok, 3);
});

// ── the sparkline ─────────────────────────────────────────────────────────

const spark = (over = {}) => ({
  pts: [10_000, 40_000, 90_000, 12_000, 30_000],
  marks: [{ at: 0.75, kind: "compact" }],
  peak: 90_000,
  windowTok: null,
  autoCompactTok: null,
  ...over,
});

test("the miniature scales against the SERIES peak, not the points on screen", () => {
  // `peak` is higher than anything in `pts` (the points are a downsample), and
  // the curve must not be re-scaled to fill the box — two rows would then look
  // equally full at wildly different token counts.
  const g = sparkGeom(spark({ pts: [10_000, 20_000], peak: 200_000 }), 72, 18);
  assert.ok(g.endY > 9, `20k of 200k should sit low in the box, got y=${g.endY}`);
});

test("the miniature draws a reference line only for an OBSERVED number", () => {
  assert.equal(sparkGeom(spark(), 72, 18).refY, null);
  assert.notEqual(sparkGeom(spark({ autoCompactTok: 190_000, windowTok: 200_000 }), 72, 18).refY, null);
  // No window known, but a compaction was seen to fire — that is the honest
  // line to draw, and it is a different fact.
  assert.notEqual(sparkGeom(spark({ autoCompactTok: 180_000 }), 72, 18).refY, null);
});

test("a tick's x is its fraction of the box", () => {
  const g = sparkGeom(spark(), 72, 18);
  assert.equal(g.ticks.length, 1);
  assert.equal(g.ticks[0].kind, "compact");
  assert.ok(Math.abs(g.ticks[0].x - 54) < 0.001);
});

test("no readings ⇒ no geometry, so the row draws no empty box", () => {
  assert.equal(sparkGeom(spark({ pts: [] }), 72, 18), null);
});

// ── the spend miniature ───────────────────────────────────────────────────

const spent = (over = {}) => spark({
  usedPts: [100_000, 400_000, 900_000, 1_400_000, 2_000_000],
  usageTok: 3_000_000,
  agentTok: 1_000_000,
  ...over,
});

test("no spend series ⇒ no second miniature, never a flat line on the floor", () => {
  // The absent case is a backend that records no output tokens. A curve of
  // zeros would read as "this session has spent nothing", which is a claim.
  assert.equal(spendSparkGeom(spark(), 72, 14), null);
  assert.equal(spendSparkGeom(spent({ usedPts: [] }), 72, 14), null);
  assert.equal(spendSparkGeom(spent({ usedPts: [0, 0, 0] }), 72, 14), null);
});

test("the spend curve ends at the MAIN conversation's own spend", () => {
  const g = spendSparkGeom(spent(), 72, 14);
  assert.equal(g.end, 2_000_000);
  // The agents are the GAP to the dashed line, never part of the curve.
  assert.equal(g.top, 3_000_000);
  assert.ok(g.totalY < g.endY, "the total sits ABOVE the end of the curve");
});

test("the dashed total is drawn only where it says something the curve does not", () => {
  // No agents: the total IS the end of the curve, and a dashed line lying on
  // the end dot reads as a threshold nobody set.
  assert.equal(spendSparkGeom(spent({ agentTok: 0 }), 72, 14).totalY, null);
  assert.equal(spendSparkGeom(spent({ usageTok: undefined, agentTok: undefined }), 72, 14).totalY, null);
});

test("a host total BELOW the curve is refused, never drawn under the last point", () => {
  // Same guard as `spendFacts`: a chart contradicting itself in the one
  // direction nobody looks twice at.
  const g = spendSparkGeom(spent({ usageTok: 1_000_000 }), 72, 14);
  assert.equal(g.totalY, null);
  assert.equal(g.top, 2_000_000);
});

test("the spend miniature's area closes with a command too", () => {
  const g = spendSparkGeom(spent(), 72, 14);
  assert.ok(g.area.startsWith("M0,14L"), g.area.slice(0, 20));
  for (const seg of g.area.replace(/Z$/, "").split(/(?=[ML])/)) {
    assert.match(seg, /^[ML]-?\d+(?:\.\d+)?,-?\d+(?:\.\d+)?$/, `bad segment ${seg}`);
  }
});

test("the spend title names its own axis, because this one is not the shared one", () => {
  const g = spendSparkGeom(spent(), 72, 14);
  const t = spendSparkTitle(spent(), g);
  assert.match(t, /spent: 2M in this conversation so far/);
  assert.match(t, /1M more in its subagents/);
  assert.match(t, /scaled to this session/);
  // No agents ⇒ no clause about them, rather than "0 in subagents".
  assert.doesNotMatch(spendSparkTitle(spent({ agentTok: 0 }), g), /subagents/);
});

test("the spend title carries the tokens the chip stopped printing", () => {
  // The chip beside this curve is money now, so the token total moved into the
  // title — along with the sentence that stops a dollar figure being read as a
  // bill. A row whose readout says "$4.21" and nothing else has lost both.
  const g = spendSparkGeom(spent(), 72, 14);
  const t = spendSparkTitle(spent({ costUsd: 4.21, agentCostUsd: 2.5 }), g);
  assert.match(t, /spent: 2M in this conversation so far/, "the tokens are still said");
  assert.match(t, /\$4\.21 so far/);
  assert.match(t, /\$2\.50 of it in subagents/);
  assert.match(t, /not what a subscription costs/);
  // Nothing priced ⇒ the title is exactly what it always was.
  assert.doesNotMatch(spendSparkTitle(spent(), g), /\$/);
});

// ── words ─────────────────────────────────────────────────────────────────

test("an event is worded once, for the tooltip and the table alike", () => {
  assert.deepEqual(
    eventLabel({ kind: "compact", t: T0, trigger: "auto", preTok: 881_715, postTok: 6_512 }),
    { kind: "compact", text: "Auto-compacted · 882k → 7k" },
  );
  assert.equal(eventLabel({ kind: "compact", t: T0, trigger: "manual" }).text, "Compacted (/compact)");
  assert.equal(eventLabel({ kind: "limit", t: T0, weekly: true }).text, "Weekly usage limit");
  assert.match(eventLabel({ kind: "limit", t: T0, resetAt: T0 + 3600_000 }).text, /^Usage limit · back at \d\d:\d\d$/);
});

test("the summary counts what happened and says the window only when known", () => {
  const s = [{ t: T0, tok: 10_000 }, { t: T0 + 1, tok: 184_000 }];
  const e = [{ kind: "compact", t: T0 }, { kind: "limit", t: T0 }, { kind: "compact", t: T0 }];
  assert.equal(seriesSummary(s, e, null), "184k now · peak 184k · 2 compactions · 1 usage limit");
  assert.equal(seriesSummary(s, [], 200_000), "92% of 200k · peak 92%");
  assert.equal(seriesSummary([], [], null), null);
});

// ── the shared axis ───────────────────────────────────────────────────────
//
// The point of the whole thing: 100% means the same on every chart. These pin
// the two ways that quietly stops being true — an axis re-fitted to the data,
// and a chart that falls back to tokens without saying so.

test("the axis is 0–100% of the window, whatever the data does", () => {
  const small = plot([{ t: T0, tok: 12_000 }], [], [], 200_000);
  const big = plot([{ t: T0, tok: 190_000 }], [], [], 200_000);
  // Same top, same ticks — a 12k conversation and a 190k one are comparable.
  assert.equal(small.yMax, big.yMax);
  assert.deepEqual(small.yTicks, big.yTicks);
  assert.equal(small.yMax, 200_000);
  assert.deepEqual(small.yTicks.map((v) => fmtYTick(small, v)), ["0%", "25%", "50%", "75%", "100%"]);
  // And the curve is NOT stretched to fill the box: 12k of 200k sits low.
  assert.ok(small.py(12_000) > small.y + small.h * 0.8);
});

test("two different windows put the same PERCENTAGE at the same height", () => {
  const a = plot([{ t: T0, tok: 100_000 }], [], [], 200_000);
  const b = plot([{ t: T0, tok: 500_000 }], [], [], 1_000_000);
  assert.equal(a.py(100_000), b.py(500_000));
  assert.equal(fmtYTick(a, 100_000), "50%");
  assert.equal(fmtYTick(b, 500_000), "50%");
});

test("a series that exceeds its window grows the axis in whole 25% steps", () => {
  const p = plot([{ t: T0, tok: 260_000 }], [], [], 200_000);
  assert.equal(p.yMax, 300_000);        // 150%, not a fitted 260k
  assert.equal(fmtYTick(p, p.yMax), "150%");
  // The gridlines are still at the same percentages as every other chart.
  assert.deepEqual(p.yTicks.map((v) => fmtYTick(p, v)), ["0%", "25%", "50%", "75%", "100%", "125%", "150%"]);
});

test("no window ⇒ a token axis, and the ticks SAY tokens", () => {
  const p = plot([{ t: T0, tok: 184_000 }], [], [], null);
  assert.equal(p.windowTok, null);
  assert.match(fmtYTick(p, p.yMax), /k$/);
  assert.doesNotMatch(fmtYTick(p, p.yMax), /%/);
  assert.equal(fmtReading(184_000, null), "184k");
});

test("pctScale never rounds a window down", () => {
  for (const w of [200_000, 1_000_000]) {
    for (const peak of [1, w / 3, w, w * 0.999, w * 1.4]) {
      const { top, ticks } = pctScale(w, peak);
      assert.ok(top >= w, `${top} < window ${w}`);
      assert.ok(top >= peak, `${top} < peak ${peak}`);
      assert.equal(ticks[ticks.length - 1], top);
    }
  }
});

test("a reading is worded once, percentage first", () => {
  assert.equal(fmtReading(100_000, 200_000), "50% · 100k");
  assert.equal(fmtReading(100_000, null), "100k");
});

// ── the compressed time axis ──────────────────────────────────────────────

test("a long dead stretch is compressed, and reported", () => {
  // The measured case: a wall on Wednesday, forty minutes of work on Friday.
  const wall = T0;
  const work = T0 + 41 * 3600_000;
  const s = Array.from({ length: 20 }, (_, i) => ({ t: work + i * 120_000, tok: 10_000 + i * 1_000 }));
  const p = plot(s, [{ kind: "limit", t: wall, resetAt: wall + 3600_000 }], [], 200_000);
  assert.equal(p.breaks.length, 1);
  // The forty minutes of readings now get most of the plot, not 2% of it.
  const used = p.px(s[s.length - 1].t) - p.px(s[0].t);
  assert.ok(used > p.w * 0.6, `readings got ${Math.round((used / p.w) * 100)}% of the width`);
  // And the wall is still on the chart, at the far left.
  assert.ok(p.px(wall) < p.x + 2);
});

test("an ordinary pause is NOT compressed", () => {
  const s = [
    { t: T0, tok: 10_000 },
    { t: T0 + 20 * 60_000, tok: 20_000 },
    { t: T0 + 40 * 60_000, tok: 30_000 },
  ];
  assert.equal(plot(s, [], [], 200_000).breaks.length, 0);
});

test("px and tx are exact inverses across a break", () => {
  const s = [
    { t: T0, tok: 1 },
    { t: T0 + 60_000, tok: 2 },
    { t: T0 + 40 * 3600_000, tok: 3 },
    { t: T0 + 40 * 3600_000 + 60_000, tok: 4 },
  ];
  const p = plot(s, [], [], 200_000);
  assert.equal(p.breaks.length, 1);
  for (const x of s) {
    const back = p.tx(p.px(x.t));
    assert.ok(Math.abs(back - x.t) < 1_000, `${x.t} → ${p.px(x.t)} → ${back}`);
  }
  // A pointer anywhere still resolves to the reading a person would point at.
  assert.equal(nearestSample(p, s, p.px(s[2].t) + 1).t, s[2].t);
  assert.equal(nearestSample(p, s, p.x + 1).t, s[0].t);
});

test("px stays monotonic and inside the plot, breaks or not", () => {
  // Thirty readings, every fifth one after a six-hour silence — more dead
  // stretches than MAX_BREAKS, which is the case that has to stay sane.
  const s = [];
  let t = T0;
  for (let i = 0; i < 30; i++) {
    t += i % 5 === 0 ? 6 * 3600_000 : 60_000;
    s.push({ t, tok: 1_000 * (i + 1) });
  }
  const p = plot(s, [], [], 200_000);
  let prev = -Infinity;
  for (const x of s) {
    const px = p.px(x.t);
    assert.ok(px >= prev - 0.001, "x went backwards");
    assert.ok(px >= p.x - 0.001 && px <= p.x + p.w + 0.001, `${px} outside the plot`);
    prev = px;
  }
});

test("a session that hit a wall and never came back keeps a plain axis", () => {
  // One reading, then nothing but a wall and its reset: there is no live span
  // to expand into, so compressing would divide by zero.
  const s = [{ t: T0, tok: 50_000 }];
  const p = plot(s, [{ kind: "limit", t: T0 + 60_000, resetAt: T0 + 40 * 3600_000 }], [], 200_000);
  assert.ok(Number.isFinite(p.px(T0)));
  assert.ok(Number.isFinite(p.px(T0 + 40 * 3600_000)));
});

test("timeScale degenerates safely", () => {
  const flat = timeScale([T0], 0, 100, T0, T0);
  assert.ok(Number.isFinite(flat.px(T0)));
  assert.deepEqual(flat.breaks, []);
  assert.ok(GAP_BREAK_MS > 0);
});

test("fmtGap says minutes, hours or days", () => {
  assert.equal(fmtGap(30 * 60_000), "30 min");
  assert.equal(fmtGap(3.5 * 3600_000), "3.5 h");
  assert.equal(fmtGap(41 * 3600_000), "1.7 d");
});

// ── what the axis CLAIMS, and whose claim it is ────────────────────────────
//
// The whole value of a fixed 0–100% axis is that two sessions' charts can be
// put side by side. That only holds if the chart names the scale it is on — and
// admits the one case where it is not on the shared one. `windowFrom` travels
// with the number for exactly this sentence, so the sentence is pinned here
// rather than left as four nested ternaries inside a sheet's JSX.

test("a measured window is the shared scale, and says the model it was seen on", () => {
  const s = axisNote("measured", 200_000, "claude-opus-5");
  assert.match(s, /^100% is 200k/);
  assert.match(s, /claude-opus-5/);
  assert.match(s, /SEEN to hold/);
  // With no model named it still reads as a sentence rather than "undefined".
  assert.match(axisNote("measured", 200_000, undefined), /this model has been SEEN/);
});

test("the model-id window admits it is an assumption", () => {
  // The weakest source and the one measured wrong: the CLI's log records the
  // base id even for a 1M conversation.
  const s = axisNote("model", 200_000, "claude-opus-5");
  assert.match(s, /assumed from the model id \(claude-opus-5\)/);
  assert.match(s, /correct itself/);
});

test("a CONFIG window is ATTRIBUTED, never presented as a measurement", () => {
  // othercli's `/config/providers` `limit.context` is what the tool believes it
  // is allowed to send. Nobody watched it happen, and a local runner may be
  // holding far less. The number is still the best axis available — what
  // changes is whose claim it is.
  const s = axisNote("config", 128_000, "ollama/gemma4:e4b", "othercli");
  assert.match(s, /^100% is 128k/);
  assert.match(s, /othercli’s configuration states it/);
  assert.match(s, /ollama\/gemma4:e4b/);
  // The two things that make it honest: it is a SETTING, and it can be wrong
  // in a direction nothing on this screen would reveal.
  assert.match(s, /not something anybody watched happen/);
  assert.match(s, /may be holding less/);
  // And it must not borrow the vocabulary of the sources that WERE observed.
  assert.doesNotMatch(s, /SEEN to hold/);
  assert.doesNotMatch(s, /printed on screen/);
});

test("the config sentence needs no edit for a third backend, and never says “undefined”", () => {
  // Every wording here takes the backend's own label. A host that never named
  // one falls back to a neutral noun rather than printing a hole.
  assert.match(axisNote("config", 128_000, "x/y", "Cline"), /Cline’s configuration/);
  const bare = axisNote("config", 128_000, undefined, undefined);
  assert.match(bare, /this backend’s configuration/);
  assert.doesNotMatch(bare, /undefined/);
  // No model to name ⇒ the clause is absent, not empty.
  assert.doesNotMatch(bare, / for /);
});

test("no window is the token axis, whatever the source claimed", () => {
  // A "100% is null" sentence is worse than admitting the axis is not shared.
  for (const from of ["none", "config", "model", "measured", "screen", undefined]) {
    const s = axisNote(from, null, "m", "othercli");
    assert.match(s, /axis is in tokens/, String(from));
    assert.match(s, /cannot be compared/, String(from));
  }
  // A zero or a negative is the same case — never a divide-by-zero percentage.
  assert.match(axisNote("config", 0, "m", "othercli"), /axis is in tokens/);
});

test("the screen-printed window is stated flatly — it is a direct statement", () => {
  const s = axisNote("screen", 1_000_000, "claude-opus-5[1m]", "Claude Code");
  assert.match(s, /^100% is the 1M window the CLI printed on screen\.$/);
});

// ── the spend chart ────────────────────────────────────────────────────────
//
// The second series is the one with the most convincing wrong answers in it:
// a total that is really a cumsum of the readings, an axis fitted to a single
// request so the curve rides the ceiling, a subagent share silently folded
// into a curve over time. Each of these pins one of them.

/** Readings with the running total beside them, the way the host emits it. */
const spendSeries = [
  { t: T0, tok: 30_000, used: 30_500 },
  { t: T0 + 60_000, tok: 90_000, used: 121_000 },
  { t: T0 + 120_000, tok: 20_000, used: 141_500 },
];

test("no running total, no spend chart — never a cumsum of the readings", () => {
  assert.equal(hasSpend([{ t: T0, tok: 30_000 }]), false);
  assert.equal(spendFacts([{ t: T0, tok: 30_000 }], 141_500, null), null);
  assert.equal(hasSpend(spendSeries), true);
});

test("the curve ends at the conversation's own spend; the total is the host's", () => {
  const f = spendFacts(spendSeries, 400_000, 258_500);
  assert.equal(f.end, 141_500);
  assert.equal(f.total, 400_000);
  assert.equal(f.agents, 258_500);
  // The axis has to hold the dashed line as well as the curve.
  assert.equal(f.top, 400_000);
});

test("a total below the curve is dropped, not drawn under it", () => {
  // An older or partial agent read could answer with less than the main
  // conversation alone spent. A reference line UNDER the last point is a chart
  // contradicting itself; absent is the honest shape.
  const f = spendFacts(spendSeries, 100_000, 10_000);
  assert.equal(f.total, null);
  assert.equal(f.agents, null);
  assert.equal(f.top, 141_500);
});

test("with no subagents there is no dashed line and no subagent sentence", () => {
  const f = spendFacts(spendSeries, 141_500, 0);
  assert.equal(f.agents, null);
  assert.doesNotMatch(spendSummary(f, false), /subagent/);
  assert.doesNotMatch(spendNote(f, false).more, /dashed|grey band/);
});

test("the headline names the whole total, and says when it is only a floor", () => {
  const f = spendFacts(spendSeries, 400_000, 258_500);
  assert.match(spendSummary(f, false), /^400k spent so far/);
  assert.match(spendSummary(f, false), /259k of it in subagents/);
  assert.match(spendSummary(f, true), /at least/);
  // A truncated log is an ABSENCE: it stays in the open lead, never folded.
  assert.match(spendNote(f, true).lead, /starts part-way up/);
  assert.equal(spendNote(f, false).lead, null);
});

// ── the money ─────────────────────────────────────────────────────────────
//
// The launcher row prints a cost, so this screen's headline has to lead with
// the same figure: a sheet opened from a row that said "$4.21" and headed
// "38M spent" is two readings of one conversation, and the reader has no way to
// tell which one to believe.

const MONEY = { total: 4.21, agents: 2.5, unpricedTok: null };

test("the headline leads with the money the row prints, and keeps the tokens", () => {
  const f = spendFacts(spendSeries, 400_000, 258_500, MONEY);
  assert.equal(f.costUsd, 4.21);
  assert.equal(f.agentCostUsd, 2.5);
  const s = spendSummary(f, false);
  assert.match(s, /^\$4\.21 at list prices · 400k spent so far/);
  assert.match(s, /\$2\.50 \/ 259k of it in subagents/);
  assert.match(spendSummary(f, true), /at least/);
});

test("a cost of zero is no cost at all — the screen says tokens, as it always did", () => {
  // `$0` beside a conversation that visibly ran reads as "this was free". The
  // honest shape is the reading this screen had before any of it existed.
  for (const cost of [null, undefined, { total: 0, agents: 0, unpricedTok: null }, { total: null, agents: null, unpricedTok: null }]) {
    const f = spendFacts(spendSeries, 400_000, 258_500, cost);
    assert.equal(f.costUsd, null, JSON.stringify(cost));
    assert.equal(f.agentCostUsd, null, JSON.stringify(cost));
    assert.match(spendSummary(f, false), /^400k spent so far/);
    assert.doesNotMatch(spendNote(f, false).more, /list prices|published rates/);
  }
});

test("an agent cost never rides without a total that contains it", () => {
  const f = spendFacts(spendSeries, 400_000, 258_500, { total: 0, agents: 2.5, unpricedTok: null });
  assert.equal(f.agentCostUsd, null);
});

test("the note says what the dollar figure is, and what it left out", () => {
  const n = spendNote(spendFacts(spendSeries, 400_000, 258_500, MONEY), false);
  const s = n.more;
  assert.match(s, /what the API would have charged/);
  assert.match(s, /priced per request on the model that ran it/);
  assert.match(s, /nothing to do with what a subscription costs/);
  assert.equal(n.lead, null, "nothing was unpriced here");
  // Tokens no rate covered are NAMED, in the OPEN lead — an absence never folds.
  const some = spendNote(spendFacts(spendSeries, 400_000, 258_500, { ...MONEY, unpricedTok: 900_000 }), false);
  assert.match(some.lead, /900k of these tokens ran on a model with no published rate/);
});

test("the note names the grey band where the agents are drawn, the gap where they are not", () => {
  const f = spendFacts(spendSeries, 400_000, 258_500);
  const drawn = spendNote(f, false, true).more;
  assert.match(drawn, /grey band on top is the 259k/);
  assert.match(drawn, /only rises/);
  assert.doesNotMatch(drawn, /no clock/);
  // An older host sends no agent series: then the gap to the dashed line is it.
  assert.match(spendNote(f, false, false).more, /gap between it and the curve/);
});

test("the agents' band stacks on the parent's curve, step-held, and ends on the total", () => {
  const p = makePlot({
    width: 300, height: 100, pad: PAD, samples: spendSeries, events: [],
    windowTok: null, value: USED, refs: [400_000],
  });
  const cum = [[T0 + 30_000, 100_000], [T0 + 90_000, 258_500]];
  const b = agentSpendBand(p, spendSeries, cum);
  const top = b.top.slice(1).split("L").map((xy) => xy.split(",").map(Number));
  // The last top point is the parent's end plus the agents' total — the dashed line.
  assert.equal(top[top.length - 1][1], Number(p.py(141_500 + 258_500).toFixed(1)));
  // A STEP at each agent point: two top points share its x.
  const x1 = Number(p.px(T0 + 90_000).toFixed(1));
  assert.equal(top.filter(([x]) => x === x1).length, 2, "a vertical step, not a ramp");
  // The band never starts before the agents' first point.
  assert.ok(top.every(([x]) => x >= Number(p.px(T0 + 30_000).toFixed(1))));
  assert.match(b.area, /Z$/);
  // An older host: nothing to draw.
  assert.deepEqual(agentSpendBand(p, spendSeries, undefined), { area: "", top: "" });
});

test("the y axis is fitted to the TOTAL, not to one request", () => {
  const p = makePlot({
    width: 300, height: 100, pad: PAD, samples: spendSeries, events: [],
    windowTok: null, value: USED, refs: [400_000],
  });
  // The dashed line must be inside the domain — the rule the plot header
  // states, and the one that matters most here: on a fan-out session the agent
  // share is most of the bill, so an axis fitted to the curve would draw the
  // total off the top of the chart.
  assert.ok(p.yMax >= 400_000, `yMax ${p.yMax}`);
  assert.ok(p.py(400_000) >= p.y);
  // And the curve is drawn through `used`, not through `tok`: the last point
  // sits far ABOVE the 20k reading it shares an instant with.
  const line = linePath(p, spendSeries, USED);
  assert.ok(line.startsWith("M"));
  assert.ok(p.py(141_500) < p.py(20_000));
  assert.match(areaPath(p, spendSeries, USED), /^M[\d.]+,[\d.]+L/);
});

test("the default accessor is unchanged — the context chart draws readings", () => {
  const p = makePlot({
    width: 300, height: 100, pad: PAD, samples: spendSeries, events: [],
    windowTok: 200_000, refs: [],
  });
  assert.equal(linePath(p, spendSeries), linePath(p, spendSeries, (s) => s.tok));
});

// ── what those tokens were ───────────────────────────────────────────────

/** A split shaped like a real one: almost all of it cache reads. */
const SPLIT = { input: 4_000, output: 30_000, cacheRead: 3_000_000, cacheWrite: 100_000, cacheWrite1h: 84_000, turns: 40 };
const AGENTS = { input: 500, output: 9_000, cacheRead: 400_000, cacheWrite: 20_000, cacheWrite1h: 0, turns: 12 };

test("the split folds the agents IN, and keeps them nameable", () => {
  const s = spendSplit(SPLIT, AGENTS);
  assert.equal(s.all.cacheRead, 3_400_000);
  assert.equal(s.all.turns, 52);
  assert.deepEqual(s.main, SPLIT);
  assert.deepEqual(s.agents, AGENTS);
  // The inputs are not mutated — `all` is built on a fresh tally, or a second
  // render would keep adding the agents to the document's own object.
  assert.equal(SPLIT.cacheRead, 3_000_000);
});

test("no measurement is absent, never a bar of zeros", () => {
  // An older host sends no split at all; a backend whose log records no usage
  // sends one of zeros. A 100%-wide bar of nothing is a claim.
  assert.equal(spendSplit(undefined, undefined), null);
  assert.equal(spendSplit(null, AGENTS), null);
  assert.equal(spendSplit({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, turns: 0 }, null), null);
  // Agents that spent nothing are ABSENT rather than a tally of zeros, which
  // would read as "they ran and cost nothing".
  assert.equal(spendSplit(SPLIT, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, turns: 0 }).agents, null);
});

test("the headline states the share rather than making it eyeballable", () => {
  const s = splitSummary(spendSplit(SPLIT, AGENTS));
  assert.match(s, /96% of everything sent in came out of the cache/);
  // It does NOT restate the total — `spendSummary` is three lines above it.
  assert.doesNotMatch(s, /spent/);
  assert.equal(splitSummary(spendSplit({ input: 0, output: 5, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, turns: 1 }, null)), null);
});

test("the note ties this screen to the all-sessions one", () => {
  const n = splitNote(spendSplit(SPLIT, AGENTS), false);
  // Method folds…
  assert.match(n.more, /all-sessions token screen/);
  assert.match(n.more, /slice of that total/);
  assert.match(n.more, /REQUESTS, not prompts/);
  // …where the agents are stays open, and makes no claim about a clock.
  assert.match(n.lead, /Subagents are IN this bar: 430k/);
  assert.doesNotMatch(n.lead + n.more, /no clock|as the gap/);
});

test("a truncated log makes every kind a floor, and says so instead", () => {
  const n = splitNote(spendSplit(SPLIT, null), true);
  assert.match(n.lead, /A floor/);
  assert.doesNotMatch(n.lead, /Subagents are IN/);
});

// ── stacked bands ─────────────────────────────────────────────────────────
//
// A stack is the one chart form where being slightly wrong is invisible twice
// over: the envelope still looks right, and so does every individual band. The
// cases below are the three ways it goes wrong silently — bands that do not add
// up to the line they are drawn inside, a stack whose colours move, and a
// cumulative chart stacked from per-request values.

const kindSample = (t, kinds, cum, model) => ({
  t, tok: kinds[0] + kinds[2] + kinds[3], used: cum.reduce((n, v) => n + v, 0), kinds, cum,
  ...(model != null ? { model } : {}),
});

const kindSeries3 = [
  kindSample(T0, [10, 5, 80, 10], [10, 5, 80, 10], 0),
  kindSample(T0 + 60_000, [20, 5, 160, 20], [30, 10, 240, 30], 0),
  kindSample(T0 + 120_000, [30, 5, 240, 30], [60, 15, 480, 60], 1),
];

test("the stack's top edge IS the line it is drawn inside", () => {
  // The whole reason the line is kept: a reader who learnt the shape is not
  // asked to learn a second one. If the bands do not reach it, the chart shows
  // a gap nobody can explain — and if they overshoot, the line is inside the
  // fill and reads as a threshold.
  const p = makePlot({
    width: 300, height: 120, pad: { top: 8, right: 8, bottom: 18, left: 40 },
    samples: kindSeries3, events: [], refs: [], windowTok: null,
  });
  const series = kindSeries(kindSeries3, "kinds", (id) => id !== "output");
  const bands = stackBands(p, kindSeries3, series);
  assert.equal(bands.length, 3, "the three kinds that ARE context");
  assert.ok(!bands.some((b) => b.key === "output"), "output is not context until the turn after");
  // Band totals sum to the readings' own sum.
  const stacked = bands.reduce((n, b) => n + b.total, 0);
  assert.equal(stacked, kindSeries3.reduce((n, s) => n + s.tok, 0));
});

test("a per-request split is HELD until the next request, never drawn as a wedge between two", () => {
  // A cold rebuild (all cache WRITE) and the warm turn after it (all cache
  // READ): straight edges drew the writes shrinking across the whole gap.
  const two = [
    kindSample(T0, [0, 0, 0, 100], [0, 0, 0, 100], 0),
    kindSample(T0 + 60_000, [0, 0, 100, 0], [0, 0, 100, 100], 0),
  ];
  const p = makePlot({
    width: 300, height: 120, pad: { top: 8, right: 8, bottom: 18, left: 40 },
    samples: two, events: [], refs: [], windowTok: null,
  });
  const write = stackBands(p, two, kindSeries(two, "kinds", (id) => id !== "output")).find((b) => b.key === "cacheWrite");
  const pts = write.d.slice(1, -1).split("L").map((xy) => xy.split(",").map(Number));
  const x1 = p.px(T0 + 60_000);
  // At the second request's x the write band still spans the whole line
  // (held), and only then drops to nothing — a vertical, not a diagonal.
  const atX1 = pts.filter(([x]) => Math.abs(x - x1) < 0.1).map(([, y]) => y);
  assert.ok(atX1.some((y) => Math.abs(y - p.py(100)) < 0.1), "held at full height up to the next request");
  assert.ok(atX1.some((y) => Math.abs(y - p.py(0)) < 0.1), "and drops to nothing there");
  // The cumulative (spend) stack is a running total and stays a straight line.
  assert.ok(kindSeries(two, "cum").every((k) => !k.perRequest));
});

test("bands come out in the palette's order, bottom first, whatever their size", () => {
  // Cache read is 80% of this fixture and input is 8%. A stack that sorts
  // itself by size per chart is a stack whose colours move between two charts
  // of the same thing.
  const series = kindSeries(kindSeries3, "kinds", (id) => id !== "output");
  assert.deepEqual(series.map((s) => s.key), ["input", "cacheRead", "cacheWrite"]);
  assert.deepEqual(series.map((s) => s.slot), [0, 2, 3]);
});

test("no per-sample split ⇒ no stack, and the chart is what it always was", () => {
  const plain = [{ t: T0, tok: 100, used: 120 }, { t: T0 + 1000, tok: 200, used: 260 }];
  assert.equal(kindSeries(plain, "kinds"), null);
  assert.equal(kindSeries(plain, "cum"), null);
  assert.equal(modelSeries(plain, modelSlots(["claude-opus-5"], false), "kinds"), null);
});

test("the spend stack reads the CUMULATIVE tuple, and only ever rises", () => {
  const series = kindSeries(kindSeries3, "cum");
  assert.equal(series.length, 4, "all four — output IS spend");
  const cacheRead = series.find((s) => s.key === "cacheRead");
  assert.deepEqual(kindSeries3.map((s) => cacheRead.at(s)), [80, 240, 480]);
  // …and the per-request tuple does NOT rise, which is exactly why the two are
  // two fields rather than one.
  const perReq = kindSeries(kindSeries3, "kinds").find((s) => s.key === "cacheRead");
  assert.deepEqual(kindSeries3.map((s) => perReq.at(s)), [80, 160, 240]);
});

// ── who gets a colour ─────────────────────────────────────────────────────

test("a model's slot is its FAMILY's, fixed app-wide; the rest fold into one grey band", () => {
  const four = modelSlots(["claude-sonnet-5", "claude-opus-5", "claude-fable-5-1", "claude-haiku-4-5"], false);
  assert.deepEqual(four.named.map((m) => [m.id, m.slot]),
    [["claude-opus-5", 0], ["claude-sonnet-5", 1], ["claude-haiku-4-5", 2], ["claude-fable-5-1", 3]]);
  assert.equal(four.rest, null, "nothing left over ⇒ no leftover band");
  assert.equal(four.slotOf(0), 1, "sonnet is slot 1 even as the biggest model");
  const more = modelSlots(["claude-opus-5", "claude-opus-4-7", "gpt-5"], false);
  assert.deepEqual(more.named.map((m) => m.id), ["claude-opus-5"], "a second opus is not a second blue");
  assert.equal(more.rest.slot, REST_SLOT);
  assert.equal(more.slotOf(1), REST_SLOT);
  assert.match(more.rest.name, /2 more/);
});

test("the leftover band never shares a slot with a named model", () => {
  for (const models of [["claude-opus-5"], ["a", "b"], ["claude-opus-5", "claude-haiku-4-5", "x", "y", "z"]]) {
    for (const unattributed of [false, true]) {
      const s = modelSlots(models, unattributed);
      if (s.rest) assert.ok(!s.named.some((m) => m.slot === s.rest.slot), `${models.length}/${unattributed}`);
      assert.ok(s.named.every((m) => m.slot < 4), "named models stay inside the validated palette");
    }
  }
});

test("a request no record named a model for lands in the leftover band, not slot 0", () => {
  const s = modelSlots(["claude-opus-5"], true);
  assert.equal(s.slotOf(0), 0);
  assert.equal(s.slotOf(undefined), s.rest.slot);
  assert.match(s.rest.name, /unattributed/);
});

test("a model band is named by its ALIAS, so a dated snapshot is not a second model", () => {
  assert.equal(modelLabel("claude-haiku-4-5-20251001"), "haiku-4-5");
  assert.equal(modelLabel("claude-opus-5[1m]"), "opus-5");
  assert.equal(modelLabel("something-else"), "something-else");
});

test("the model stack attributes every token, and to the model that ran it", () => {
  const slots = modelSlots(["claude-opus-5", "claude-haiku-4-5"], false);
  const series = modelSeries(kindSeries3, slots, "kinds");
  assert.deepEqual(series.map((s) => s.name), ["opus-5", "haiku-4-5"]);
  // Sample 3 ran on model index 1; the opus band must be zero there.
  assert.equal(series[0].at(kindSeries3[2]), 0);
  assert.ok(series[1].at(kindSeries3[2]) > 0);
  const whole = kindSeries3.reduce((n, s) => n + s.kinds.reduce((m, v) => m + v, 0), 0);
  assert.equal(series.reduce((n, s) => n + kindSeries3.reduce((m, x) => m + s.at(x), 0), 0), whole);
});

// ── the subagents ─────────────────────────────────────────────────────────

const run = (at, model, over = {}) => ({ id: `a${at}`, at, endAt: at, tok: 1000, model, ...over });

const lanePlot = () => makePlot({
  width: 300, height: 90, pad: { top: 8, right: 8, bottom: 18, left: 40 },
  samples: kindSeries3, events: [], refs: [], windowTok: null,
});

test("agents are bars over their own span, packed into the fewest lanes", () => {
  const p = lanePlot();
  const slots = modelSlots(["claude-opus-5", "claude-haiku-4-5"], false);
  const a = run(T0, 0, { endAt: T0 + 60_000 });
  const b = run(T0 + 10_000, 1, { endAt: T0 + 30_000 });   // overlaps a
  const c = run(T0 + 70_000, 1, { endAt: T0 + 110_000 });  // after both: reuses lane 0
  const { bars, lanes } = agentLanes(p, [c, b, a], slots);
  assert.equal(lanes, 2);
  const by = new Map(bars.map((x) => [x.run.id, x]));
  assert.equal(by.get(a.id).lane, 0);
  assert.equal(by.get(b.id).lane, 1);
  assert.equal(by.get(c.id).lane, 0, "first fit: the free lane is reused");
  // x spans the agent's own time on the chart's own axis.
  assert.equal(by.get(a.id).x, p.px(T0));
  assert.ok(Math.abs(by.get(a.id).x + by.get(a.id).w - p.px(T0 + 60_000)) < 1e-9);
  assert.equal(by.get(b.id).slot, 2, "coloured by the model's one slot (haiku)");
  // No two bars in one lane overlap.
  for (const x of bars) for (const y of bars) {
    if (x !== y && x.lane === y.lane) assert.ok(x.x + x.w <= y.x || y.x + y.w <= x.x);
  }
});

test("a one-request agent is still a mark, and one before the axis still draws", () => {
  const p = lanePlot();
  const { bars } = agentLanes(p, [run(T0 - 86_400_000, 0), run(T0 + 999_999_999, 0)], null);
  assert.equal(bars.length, 2);
  assert.ok(bars.every((b) => b.w >= 3 && b.x >= p.x && b.x + b.w <= p.x + p.w + 1e-9));
});

test("the dearest agent is flagged, exactly once", () => {
  const { bars } = agentLanes(lanePlot(), [run(T0, 0, { tok: 5 }), run(T0 + 1, 0, { tok: 9 })], null);
  assert.deepEqual(bars.filter((b) => b.dearest).map((b) => b.run.tok), [9]);
});

test("lanes stay a fixed small height, then squeeze instead of growing without end", () => {
  assert.deepEqual(laneGeom(6), { laneH: 13, barH: 10, plotH: 78 });
  const many = laneGeom(20);
  assert.ok(many.plotH <= 110 && many.barH >= 3);
  assert.equal(laneGeom(0).plotH, 13, "an empty strip is one lane tall, never zero");
});

test("a tap picks the bar in its lane, else the nearest one", () => {
  const p = lanePlot();
  const { bars } = agentLanes(p, [run(T0, 0, { endAt: T0 + 60_000 }), run(T0 + 10_000, 0, { endAt: T0 + 20_000 })], null);
  const inLane1 = agentAtPoint(bars, 13, 8, p.px(T0 + 100_000), 8 + 13 + 5);
  assert.equal(inLane1.lane, 1);
  assert.equal(agentAtPoint([], 13, 8, 0, 0), null);
});

test("concurrency is counted in time, and a hand-over is not an overlap", () => {
  assert.equal(agentConcurrency([run(0, 0, { endAt: 10 }), run(10, 0, { endAt: 20 })]), 1);
  assert.equal(agentConcurrency([run(0, 0, { endAt: 10 }), run(5, 0, { endAt: 20 }), run(6, 0, { endAt: 7 })]), 3);
});

test("the tapped agent reads as one line: type, model, span, tokens, window, cost", () => {
  const text = agentReadout(run(T0, 1, { type: "Explore", endAt: T0 + 600_000, tok: 9_000_000, peakTok: 967_000, costUsd: 12.5 }),
    ["claude-opus-5", "claude-haiku-4-5"], 3_600_000);
  assert.match(text, /^Explore · haiku-4-5 · /);
  assert.match(text, /10 min/);
  assert.match(text, /9M spent · window peaked at 967k · \$12\.50/);
});

test("the subagent headline says how many at once, and names the dearest", () => {
  const text = agentSummary([
    run(T0, 0, { tok: 500, endAt: T0 + 5_000 }),
    run(T0 + 1000, 1, { tok: 9_000_000, endAt: T0 + 400_000 }),
  ], ["claude-opus-5", "claude-haiku-4-5"]);
  assert.match(text, /2 subagents · up to 2 at once/);
  assert.doesNotMatch(text, /STARTED/);
  assert.match(text, /dearest 9M on haiku-4-5 \(outlined\)/);
  assert.match(agentSummary([], []), /No subagents/);
});

test("agent tokens no chart can place are said in the open, never zero", () => {
  assert.match(agentUndatedText([run(T0, 0, { tok: 1_000 })], 51_000), /50k of the subagents' tokens are in logs with no timestamp/);
  assert.equal(agentUndatedText([run(T0, 0, { tok: 1_000 })], 1_000), null);
  assert.equal(agentUndatedText([], undefined), null);
});

test("the row spark draws the agents' envelope behind the line, on the same axis", () => {
  const g = sparkGeom(spark({ windowTok: 200_000, agentEnv: [0, 150_000, 0, 0, 400_000] }), 72, 18);
  assert.match(g.agentArea, /^M0\.0,18L/);
  assert.equal(g.agentPeak, 400_000);
  // Clamped at the axis top, never re-scaling the parent's curve for an agent.
  assert.equal(g.line, sparkGeom(spark({ windowTok: 200_000 }), 72, 18).line);
  assert.equal(sparkGeom(spark(), 72, 18).agentArea, null, "absent ⇒ nothing");
  assert.equal(sparkGeom(spark({ agentEnv: [1, 2] }), 72, 18).agentArea, null, "misaligned ⇒ nothing");
});

test("a model that only the SUBAGENTS ran gets no band on the request charts", () => {
  // The model table spans the conversation AND its agents, so a fan-out that
  // ran opus workers under a sonnet parent puts opus in the table with nothing
  // in a single sample. Unfiltered, that is a band of nothing and a legend
  // entry reading `opus-5 0 0%` — measured on a real session here.
  // Every request ran on the parent's model; the second entry is the agents'.
  const own = kindSeries3.map((s) => ({ ...s, model: 0 }));
  const slots = modelSlots(["claude-sonnet-5", "claude-opus-5"], false);
  const series = modelSeries(own, slots, "kinds");
  assert.deepEqual(series.map((s) => s.name), ["sonnet-5"], "the agents-only model gets no band");
  assert.ok(series.every((s) => own.some((x) => s.at(x) > 0)), "no empty band survives");
  // The slot still comes from the TABLE, so dropping an empty band moves no
  // colour on the bands that remain — and the agents' model keeps slot 1 for
  // the chart that DOES draw it.
  assert.equal(series[0].slot, 1, "sonnet's fixed slot");
  assert.equal(slots.slotOf(1), 0, "opus keeps ITS slot for the chart that does draw it");
});

test("an agent's own window shares the axis: its hours are not compressed, and its peak is in the domain and the summary", () => {
  // Measured: the parent read 31% while an agent under it held 967k, and the
  // hours the agent worked — parent log silent — were drawn as break stripes.
  const H = 3_600_000;
  const parent = [{ t: T0, tok: 300_000, used: 300_000 }, { t: T0 + 600_000, tok: 305_000, used: 305_000 }, { t: T0 + 6 * H + 900_000, tok: 309_000, used: 309_000 }, { t: T0 + 6 * H + 1_200_000, tok: 310_000, used: 310_000 }];
  const agents = [{ id: "a1", at: T0 + H, endAt: T0 + 5 * H, tok: 1, peakTok: 967_000,
    ctx: Array.from({ length: 13 }, (_, i) => [T0 + 600_000 + i * H / 2, i === 12 ? 967_000 : 100_000 + i * 60_000]) }];
  const box = { width: 300, height: 120, pad: { top: 8, right: 8, bottom: 18, left: 40 }, samples: parent, events: [], refs: [], windowTok: 1_000_000 };
  assert.ok(makePlot(box).breaks.length > 0, "without the agents the silent parent is a break");
  const p = makePlot({ ...box, agents });
  assert.equal(p.breaks.length, 0, "with them, those hours are drawn at full width");
  const [line] = agentLines(p, agents);
  assert.ok(line.d.includes(p.py(967_000).toFixed(1)), "the agent's peak is on the chart");
  assert.equal(agentPeak(agents), 967_000);
  assert.match(seriesSummary(parent, [], 1_000_000, agents), /an agent held 967k/);
  assert.equal(/agent/.test(seriesSummary(parent, [], 1_000_000, [])), false);
});
