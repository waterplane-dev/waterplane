/**
 * Pins for splitting the two chart geometry modules (docs/notes/charts-architecture.md):
 * `contextPlot.ts` and `kit/chart/statsPlot.ts`, whose duplicated primitives moved into shared
 * `kit/chart/` modules. The dedupe changes STRUCTURE, never output, so two things are held:
 *
 *  1. The EXPORT SURFACE of each facade, read off the type checker (values and types alike).
 *  2. The OUTPUT: every exported pure function is run over a deterministic fixture set (seeded
 *     readings, events, agents, day rows, usage samples) and its JSON compared, as a digest per
 *     observation, with `plotpins.golden.json`, recorded BEFORE the first move. Regenerate with
 *     `WATERPLANE_REGOLDEN=1 node --test tools/plotpins.test.mjs` only for a deliberate change,
 *     named as such in its commit. A thrown error is an observation too (its message is compared).
 */
process.env.TZ = "UTC";
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import * as C from "../packages/web/src/contextPlot.ts";
import * as S from "../packages/web/src/kit/chart/statsPlot.ts";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const CONTEXT = here("../packages/web/src/contextPlot.ts");
const STATS = here("../packages/web/src/kit/chart/statsPlot.ts");
const GOLDEN = here("./plotpins.golden.json");

function surface(file) {
  const program = ts.createProgram([file], {
    module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, target: ts.ScriptTarget.ES2022,
    jsx: ts.JsxEmit.ReactJSX, noEmit: true, skipLibCheck: true, allowImportingTsExtensions: true,
  });
  const checker = program.getTypeChecker();
  const mod = checker.getSymbolAtLocation(program.getSourceFile(file));
  assert.ok(mod, `${file} did not parse as a module`);
  return checker.getExportsOfModule(mod).map((s) => {
    const target = s.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(s) : s;
    return `${s.name}:${target.flags & ts.SymbolFlags.Value ? "value" : "type"}`;
  }).sort();
}

const GOLDEN_DOC = (() => { try { return JSON.parse(readFileSync(GOLDEN, "utf8")); } catch { return { surface: {}, digests: {} }; } })();
const REGOLDEN = process.env.WATERPLANE_REGOLDEN === "1";

test("the chart facades export exactly their pinned surface", () => {
  const now = { context: surface(CONTEXT), stats: surface(STATS) };
  if (REGOLDEN) { GOLDEN_DOC.surface = now; return; }
  assert.deepEqual(now, GOLDEN_DOC.surface);
});

// ── deterministic fixtures ───────────────────────────────────────────────
let seed = 12345;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
const T0 = Date.parse("2026-09-01T10:00:00.000Z");
const PAD = { top: 8, right: 8, bottom: 18, left: 34 };

function makeSamples(n, gaps) {
  const out = [];
  let t = T0, tok = 20_000, used = 0;
  const cum = [0, 0, 0, 0];
  for (let i = 0; i < n; i++) {
    t += gaps && i % 7 === 6 ? 6 * 3600_000 : 20_000 + Math.floor(rnd() * 240_000);
    tok = Math.max(5000, Math.round(tok + (rnd() - 0.35) * 30_000));
    const kinds = [Math.round(rnd() * 900), Math.round(rnd() * 4000), Math.round(tok * 0.9), Math.round(rnd() * 12_000)];
    kinds.forEach((v, k) => { cum[k] += v; });
    used += kinds[0] + kinds[1] + kinds[3];
    out.push({ t, tok, used, kinds, cum: [...cum], model: i % 5 === 0 ? 1 : 0 });
  }
  return out;
}
const SAMPLES = makeSamples(40, true);
const SAMPLES_NOGAP = makeSamples(25, false);
const EVENTS = [
  { t: SAMPLES[10].t + 1000, kind: "compact", trigger: "auto", preTok: 180_000, postTok: 20_000, wroteTok: 20_000 },
  { t: SAMPLES[20].t + 1000, kind: "limit", resetAt: SAMPLES[20].t + 3 * 3600_000 },
  { t: SAMPLES[30].t + 1000, kind: "rebuild", prevTok: 90_000, gapMs: 3 * 3600_000, wroteTok: 90_000 },
  { t: SAMPLES[35].t + 1000, kind: "compact", trigger: "manual", preTok: 120_000, postTok: 15_000 },
];
const AGENTS = [
  { id: "a1", at: SAMPLES[3].t, endAt: SAMPLES[9].t, model: 0, type: "explore", tok: 50_000, costUsd: 0.4, peakTok: 60_000, ctx: [[SAMPLES[3].t, 10_000], [SAMPLES[6].t, 40_000], [SAMPLES[9].t, 60_000]] },
  { id: "a2", at: SAMPLES[5].t, endAt: SAMPLES[14].t, model: 1, type: "plan", tok: 30_000, peakTok: 35_000 },
  { id: "a3", at: SAMPLES[22].t, endAt: SAMPLES[22].t + 1000, tok: 1000 },
  { id: "a4", at: 0, endAt: 0, tok: 500 },
];
const AGENT_CUM = [[SAMPLES[3].t, 1000], [SAMPLES[9].t, 30_000], [SAMPLES[14].t, 50_000]];
const SPARK = {
  pts: SAMPLES.map((s) => s.tok), usedPts: SAMPLES.map((s) => s.used), agentEnv: SAMPLES.map((_, i) => (i > 3 && i < 15 ? 30_000 + i * 100 : 0)),
  marks: EVENTS.map((e) => ({ at: e.t, kind: e.kind })), peak: 200_000, windowTok: 200_000, windowFrom: "model", autoCompactTok: 160_000,
  spentTok: 5_000_000, usageTok: 5_000_000, agentTok: 80_000, costUsd: 3.21, agentCostUsd: 0.4, unpricedTok: 0, turns: 40,
};
const TOTALS = { input: 1200, output: 40_000, cacheRead: 13_000_000, cacheWrite: 300_000 };
const TOTALS2 = { input: 100, output: 9000, cacheRead: 800_000, cacheWrite: 30_000 };

// ── digest plumbing ──────────────────────────────────────────────────────
const digests = {};
const thrown = [];
function obs(name, fn) {
  let text;
  try { text = JSON.stringify(fn(), (_k, v) => (typeof v === "function" ? "[fn]" : v === undefined ? "[undef]" : typeof v === "number" && !Number.isFinite(v) ? `[${v}]` : v)); }
  catch (e) { text = `THROWS ${e && e.message}`; thrown.push(`${name}: ${e && e.message}`); }
  digests[name] = createHash("sha1").update(String(text)).digest("hex").slice(0, 12);
}
const px = (p) => { const xs = [0, 0.1, 0.33, 0.5, 0.77, 1].map((f) => p.t0 + f * (p.t1 - p.t0)); return xs.map((t) => [p.px(t), p.tx ? p.tx(p.px(t)) : 0]); };

// ── contextPlot ──────────────────────────────────────────────────────────
const plots = {};
function mk(name, o) { plots[name] = C.makePlot({ width: 300, height: 120, pad: PAD, samples: SAMPLES, events: EVENTS, refs: [], windowTok: 200_000, ...o }); return plots[name]; }
mk("pct"); mk("tok", { windowTok: null, yWant: 4 }); mk("agents", { agents: AGENTS }); mk("used", { value: C.USED, windowTok: null });
mk("small", { samples: SAMPLES_NOGAP, events: [], refs: [150_000] }); mk("one", { samples: [SAMPLES[0]], events: [] }); mk("empty", { samples: [], events: [] });
mk("over", { windowTok: 20_000 });
for (const [name, p] of Object.entries(plots)) {
  const samples = name === "small" ? SAMPLES_NOGAP : name === "one" ? [SAMPLES[0]] : name === "empty" ? [] : SAMPLES;
  obs(`c.plot.${name}`, () => ({ ...p, px: px(p), py: [0, 1000, 50_000, 190_000, 1e9].map(p.py) }));
  obs(`c.line.${name}`, () => C.linePath(p, samples));
  obs(`c.area.${name}`, () => C.areaPath(p, samples));
  obs(`c.used.line.${name}`, () => C.linePath(p, samples, C.USED));
  obs(`c.used.area.${name}`, () => C.areaPath(p, samples, C.USED));
  obs(`c.near.${name}`, () => [0, 40, 100, 200, 300, 999].map((x) => C.nearestSample(p, samples, x)));
  obs(`c.yticks.${name}`, () => p.yTicks.map((v) => C.fmtYTick(p, v)));
  obs(`c.lines.${name}`, () => C.agentLines(p, AGENTS));
  obs(`c.stack.kinds.${name}`, () => C.stackBands(p, samples, C.kindSeries(samples, "kinds") ?? []));
  obs(`c.stack.cum.${name}`, () => C.stackBands(p, samples, C.kindSeries(samples, "cum", (k) => k !== "output") ?? []));
  obs(`c.stack.model.${name}`, () => { const sl = C.modelSlots(["claude-opus-5", "claude-sonnet-5", "gpt-9"], true); return C.stackBands(p, samples, C.modelSeries(samples, ["claude-opus-5", "claude-sonnet-5", "gpt-9"], sl, "cum") ?? []); });
  obs(`c.lanes.${name}`, () => { const sl = C.modelSlots(["claude-opus-5", "claude-sonnet-5"], false); const g = C.agentLanes(p, AGENTS, sl); return [g, C.laneGeom(g.lanes), g.bars.map((b) => C.agentAtPoint(g.bars, 20, 8, b.x + 1, 8 + 5))]; });
  obs(`c.spendband.${name}`, () => C.agentSpendBand(p, samples, AGENT_CUM));
}
for (const v of [0, 1, 5, 999, 1_000, 1_499, 1_500, 9_999, 10_000, 12_345, 999_999, 1_000_000, 1_250_000, 9_999_999, 10_000_000, 123_456_789, NaN, Infinity, -5]) {
  obs(`c.fmtTokens.${v}`, () => [C.fmtTokens(v), C.fmtTokensFine(v)]);
}
for (const span of [60_000, 3600_000, 35 * 3600_000, 37 * 3600_000, 13 * 86_400_000, 15 * 86_400_000, 90 * 86_400_000]) {
  obs(`c.axisTime.${span}`, () => [0, 1, 2, 3].map((i) => C.fmtAxisTime(T0 + i * span * 0.3, span)));
}
for (const m of [0, -1, 1, 3, 6_512, 184_000, 200_000, 881_715, 1.5e9]) for (const w of [undefined, 3, 4, 8]) obs(`c.yScale.${m}.${w}`, () => C.yScale(m, w));
for (const w of [8_000, 200_000, 1_000_000]) for (const pk of [0, 1000, w * 0.9, w, w * 1.01, w * 2.6]) obs(`c.pct.${w}.${pk}`, () => C.pctScale(w, pk));
for (const ms of [1000, 59_000, 60_000, 45 * 60_000, 3600_000, 3.5 * 3600_000, 86_400_000, 2.4 * 86_400_000]) obs(`c.fmtGap.${ms}`, () => C.fmtGap(ms));
obs("c.timeScale", () => [[SAMPLES.map((s) => s.t), 34, 258], [[T0, T0 + 1000], 0, 100], [[], 0, 100]].map(([m, x, w]) => { const t0 = m[0] ?? 0; const t1 = m[m.length - 1] ?? 1; const s = C.timeScale(m, x, w, t0, t1 > t0 ? t1 : t0 + 1); return [s.breaks, [0, 0.4, 1].map((f) => s.px(t0 + f * (t1 - t0)))]; }));
obs("c.summaries", () => [C.seriesSummary(SAMPLES, EVENTS, 200_000, AGENTS), C.seriesSummary(SAMPLES, [], null), C.seriesSummary([], [], null), C.seriesSummary([SAMPLES[0]], EVENTS, 200_000), C.agentPeak(AGENTS), C.agentPeak(undefined), C.agentConcurrency(AGENTS), C.agentSummary(AGENTS, ["claude-opus-5", "claude-sonnet-5"]), AGENTS.map((a) => C.agentReadout(a, ["claude-opus-5", "claude-sonnet-5"], 3600_000)), C.agentUndatedText(AGENTS, 90_000), C.agentUndatedText(AGENTS, null), C.agentUndatedText([], 5)]);
obs("c.events", () => EVENTS.map(C.eventLabel));
obs("c.axisNote", () => ["screen", "measured", "model", "config", "none", undefined].flatMap((f) => [C.axisNote(f, 200_000, "claude-opus-5", "othercli"), C.axisNote(f, null, undefined)]));
obs("c.reading", () => [[0, 200_000], [50_000, 200_000], [200_000, 200_000], [250_000, null], [12, null]].map(([t, w]) => C.fmtReading(t, w)));
const sf = (u, a, c) => C.spendFacts(SAMPLES, u, a, c);
obs("c.spend", () => {
  const facts = [sf(null, null), sf(6_000_000, 90_000), sf(6_000_000, 90_000, { total: 3.2, agents: 0.4, unpricedTok: 100 }), sf(undefined, undefined, { total: null, agents: null, unpricedTok: null }), C.spendFacts([], null, null), C.spendFacts(SAMPLES_NOGAP, 1, 2)];
  return [facts, facts.map((f) => f && [C.spendSummary(f, false), C.spendSummary(f, true), C.spendNote(f, false), C.spendNote(f, true, true)]), C.hasSpend(SAMPLES), C.hasSpend([]), C.hasSpend([{ t: 1, tok: 1 }])];
});
obs("c.split", () => { const s = [C.spendSplit(TOTALS, TOTALS2), C.spendSplit(TOTALS, null), C.spendSplit(null, TOTALS), C.spendSplit({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, null)]; return [s, s.map((x) => x && [C.splitSummary(x), C.splitNote(x, false), C.splitNote(x, true)])]; });
obs("c.models", () => [C.modelSlots(["claude-opus-5", "claude-sonnet-5", "gpt-9", "claude-sonnet-4"], true), C.modelSlots(undefined, false), C.modelSlots([], true), C.MODEL_SLOTS, C.REST_KEY, ["claude-opus-5", "gpt-9", ""].map(C.modelLabel)]);
for (const w of [60, 120, 300]) for (const h of [18, 36]) {
  obs(`c.spark.${w}.${h}`, () => [C.sparkGeom(SPARK, w, h), C.sparkGeom({ ...SPARK, windowTok: null, agentEnv: undefined, autoCompactTok: null }, w, h), C.sparkGeom({ ...SPARK, pts: [5], usedPts: undefined, marks: [] }, w, h), C.sparkGeom({ ...SPARK, pts: [] }, w, h)]);
  obs(`c.sspark.${w}.${h}`, () => { const gs = [C.spendSparkGeom(SPARK, w, h), C.spendSparkGeom({ ...SPARK, usedPts: undefined }, w, h), C.spendSparkGeom({ ...SPARK, usedPts: [4], windowTok: null }, w, h)]; return [gs, gs.map((g) => g && C.spendSparkTitle(SPARK, g))]; });
}

// ── statsPlot ────────────────────────────────────────────────────────────
const DAYS = [];
{
  let d = Date.parse("2026-03-01T00:00:00");
  for (let i = 0; i < 90; i++) {
    const dt = new Date(d); d = dt.setDate(dt.getDate() + 1);
    if (rnd() < 0.2) continue;
    const day = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
    const totals = { input: Math.round(rnd() * 900), output: Math.round(rnd() * 40_000), cacheRead: Math.round(rnd() * 9e6), cacheWrite: Math.round(rnd() * 3e5) };
    DAYS.push({ day, t: dt.getTime(), ...totals, totals, cost: { total: rnd() * 30, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, unpricedTok: 0 }, byModel: [{ model: "claude-opus-5", ...totals }] });
  }
}
const PTS = DAYS.map((d, i) => ({ day: d.day, t: d.t, v: (i * 7919) % 13 === 0 ? 0 : Math.round(d.output + d.input + (i % 5) * 1000) }));
const HPTS = PTS.slice(0, 24).map((q, i) => ({ ...q, t: T0 + i * 3600_000 }));
const dplots = {
  day: S.makeDayPlot({ width: 340, height: 150, pad: PAD, points: PTS }),
  fixed: S.makeDayPlot({ width: 340, height: 150, pad: PAD, points: PTS, yMax: 100 }),
  few: S.makeDayPlot({ width: 200, height: 100, pad: PAD, points: PTS.slice(0, 3) }),
  one: S.makeDayPlot({ width: 200, height: 100, pad: PAD, points: PTS.slice(0, 1) }),
  none: S.makeDayPlot({ width: 200, height: 100, pad: PAD, points: [] }),
  hour: S.makeDayPlot({ width: 340, height: 150, pad: PAD, points: HPTS, stepMs: 3600_000 }),
};
const dpts = { day: PTS, fixed: PTS, few: PTS.slice(0, 3), one: PTS.slice(0, 1), none: [], hour: HPTS };
const KINDS = [{ id: "input", slot: 0, name: "Input" }, { id: "output", slot: 1, name: "Output" }, { id: "cacheRead", slot: 2, name: "Cache read" }, { id: "cacheWrite", slot: 3, name: "Cache write" }];
const ROWS = DAYS.map((d) => ({ t: d.t, day: d.day, totals: d.totals }));
const blank = (t, day) => ({ t, day, totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
for (const [name, p] of Object.entries(dplots)) {
  const pts = dpts[name];
  obs(`s.plot.${name}`, () => ({ ...p, px: [T0, p.t0, p.t1].map(p.px), py: [0, 10, 5000, 1e9].map(p.py) }));
  obs(`s.step.${name}`, () => S.stepPath(p, pts));
  obs(`s.area.${name}`, () => S.areaUnder(p, pts));
  obs(`s.cols.${name}`, () => [S.columns(p, pts), S.columns(p, pts, 4)]);
  obs(`s.nearest.${name}`, () => [0, 40, 100, 200, 300, 999].map((x) => S.nearestDay(p, pts, x)));
  obs(`s.ticks.${name}`, () => S.dayTicks(p));
  obs(`s.mean.${name}`, () => [S.rollingMean(pts), S.rollingMean(pts, 3)]);
}
for (const norm of [true, false]) {
  obs(`s.stacks.${norm}`, () => S.stacks(dplots.day, ROWS, KINDS.map((k) => ({ id: k.id, slot: k.slot, name: k.name })), { normalize: norm }));
  obs(`s.stacks.at.${norm}`, () => S.stacks(dplots.day, ROWS, [{ at: (r) => r.t % 7, slot: 0, name: "a" }, { at: () => 3, slot: 1, name: "b" }], { normalize: norm, maxW: 6 }));
  obs(`s.runs.${norm}`, () => S.areaRuns(ROWS, norm, KINDS));
  obs(`s.areas.${norm}`, () => S.stackAreas(dplots.day, ROWS, KINDS, { normalize: norm }));
  obs(`s.areas.one.${norm}`, () => S.stackAreas(dplots.few, ROWS.slice(0, 1), KINDS, { normalize: norm }));
  obs(`s.areas.fill.${norm}`, () => { const f = S.fillMix(ROWS, blank); return f && S.stackAreas(dplots.day, f, KINDS, { normalize: norm }); });
}
obs("s.fill", () => [S.fillSeries(PTS), S.fillSeries(PTS, 86_400_000, 10), S.fillSeries(HPTS, 3600_000), S.fillSeries([]), S.fillMix(ROWS, blank), S.fillMix(ROWS.slice(0, 1), blank)]);
obs("s.bars", () => [S.barRows([3, 100, 0, 7], (x) => x, (x) => `n${x}`), S.barRows([], (x) => x, String), S.barRows([0, 0], (x) => x, String)]);
obs("s.compose", () => [S.compose(TOTALS, KINDS), S.compose(TOTALS2, KINDS, 3), S.compose({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, KINDS)]);
obs("s.weeks", () => {
  const s = S.weekStart(Date.parse("2026-05-13T15:00:00"));
  const wd = S.weekDays(DAYS, s);
  return [s, S.shiftWeek(s, 1), S.shiftWeek(s, -3), S.isoWeek(s), S.dayKey(s), wd, S.weekTotals(wd), S.weekCost(wd), S.weekBounds(DAYS, Date.parse("2026-06-01T12:00:00")), S.weekBounds([], 5), S.weekLabel(s), S.weekDelta(5, 4), S.weekDelta(5, 0), S.weekDelta(0, 0)];
});
obs("s.clock", () => [S.clockColumns(Array.from({ length: 24 }, (_, i) => (i * 37) % 11), { x: 0, y: 0, w: 240, h: 60 }), S.clockColumns([], { x: 0, y: 0, w: 240, h: 60 }, 1), S.clockColumns(new Array(24).fill(0), { x: 5, y: 5, w: 100, h: 10 })]);
{
  const US = [];
  let t = T0, s = 5, w = 20, sr = T0 + 4 * 3600_000, wr = T0 + 5 * 86_400_000;
  for (let i = 0; i < 80; i++) {
    t += i % 17 === 16 ? 2 * 3600_000 : 5 * 60_000 + Math.floor(rnd() * 600_000);
    s += rnd() * 4; w += rnd() * 1.5;
    if (i === 30) { s = 3; sr += 5 * 3600_000; }
    if (i === 50) { s = 2; sr += 1000; }
    if (i === 60) { w = 4; wr += 7 * 86_400_000; }
    US.push({ t, s: i % 23 === 22 ? null : Math.round(s * 10) / 10, w: i % 31 === 30 ? null : Math.round(w * 10) / 10, sr: i > 70 ? null : sr + (i % 3) * 60_000, wr });
  }
  for (const which of ["session", "week"]) {
    obs(`s.usage.${which}`, () => { const segs = S.usageSegments(US, which); return [segs, S.burnRate(segs), S.burnRate(segs, 1), S.usageOutlook(segs, 100, US[US.length - 1].t), S.usageMarksText(segs), S.nearestUsage(segs, T0 + 3 * 3600_000), S.nearestUsage([], 5)]; });
    obs(`s.usage.gap.${which}`, () => S.usageSegments(US, which, 1000));
    obs(`s.span.${which}`, () => [S.usageSpan(which, null, T0), S.usageSpan(which, T0 + 86_400_000, T0), S.usageSpan(which, T0 - 5, T0), S.usageSpan(which, T0 + 9e8, T0, 12)]);
  }
  obs("s.usage.eps", () => [S.RESET_EPS_MS, S.DROP_EPS_PCT, S.sameWindow(null, null), S.sameWindow(5, null), S.sameWindow(0, 100_000), S.sameWindow(0, 10 * 60_000)]);
}
for (const [a, b, n] of [[T0, T0 + 3600_000, 4], [T0, T0 + 24 * 3600_000, 4], [T0, T0 + 24 * 3600_000, 2], [T0, T0 + 7 * 86_400_000, 6], [T0, T0 + 90 * 86_400_000, 4], [T0, T0, 4], [T0, T0 + 5, 1]]) obs(`s.timeTicks.${a}.${b - a}.${n}`, () => S.timeTicks(a, b, n));
obs("s.hours", () => [S.hourPoints([{ hour: "2026-05-01T10" }, { hour: "2026-05-01T11" }], () => 3, (h) => Date.parse(`${h}:00:00`)), S.DAY_MS, S.HOUR_MS]);
obs("s.modelBands", () => [S.modelBands([{ key: "claude-opus-5", label: "Opus" }, { key: "claude-sonnet-5", label: "Sonnet" }, { key: "gpt-9", label: "GPT" }, { key: "claude-haiku-5", label: "Haiku" }]), S.modelBands([])]);

test("every observation matches the golden recorded before the move", () => {
  if (REGOLDEN) {
    GOLDEN_DOC.digests = digests;
    writeFileSync(GOLDEN, JSON.stringify(GOLDEN_DOC, null, 1) + "\n");
    if (process.env.PLOTPINS_SHOW_THROWS) console.log(thrown.join("\n"));
    return;
  }
  const want = GOLDEN_DOC.digests;
  assert.deepEqual(Object.keys(digests).sort(), Object.keys(want).sort(), "the observation set changed");
  const bad = Object.keys(want).filter((k) => digests[k] !== want[k]);
  assert.deepEqual(bad, [], `${bad.length} observations differ from the golden`);
  assert.ok(Object.keys(digests).length > 250, `only ${Object.keys(digests).length} observations`);
});
