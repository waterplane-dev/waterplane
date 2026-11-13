/**
 * "Agent readings over time" geometry and words (`agentSeriesPlot.ts`), pinned without a browser:
 * a cut series starts where every kind is complete, markers are one row per kind and fold into one
 * mark with a count, an absent bucket cuts the line instead of drawing a zero, and the before/after
 * sentence names no side.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { addLocalDays, AGENT_POINTS_CAP, AGENT_SUB_POINTS_CAP } from "@waterplane/shared";
import {
  absentSummary, axisOf, clipBuckets, compareWords, coverFrom, DAY_GRAIN_MAX_DAYS, dayGrainOffered, dayKeyOfMs, fmtKChars, fmtReading, MARKER_KINDS, markerWords,
  modelsIn, markerPickLabel, foldedCompareWords, MARK_ROW_H, partBands, partTwinWords, placeMarkers, ratioScale, readingDef, runsOf, shapePath, slotAtX, slotX, stackTops, valuesOnAxis,
} from "./agentSeriesPlot.ts";

const at = (day, h = 12) => new Date(`${day}T${String(h).padStart(2, "0")}:00:00`).getTime();
const pt = (day, extra = {}) => ({ id: day + Math.random(), t0: at(day), repo: "/r", fresh: true, headless: false, req: 3, ...extra });

test("an uncut series is not clipped and says nothing", () => {
  assert.deepEqual(coverFrom([pt("2026-11-01")], 0), { from: null, hidden: 0, words: null });
});

test("a cut conversation list starts the axis the day after its oldest kept conversation", () => {
  const convs = Array.from({ length: AGENT_POINTS_CAP }, (_, i) => pt(i === 0 ? "2026-09-10" : "2026-10-01"));
  const subs = [pt("2026-08-01", { sub: true })];
  const c = coverFrom([...convs, ...subs], 40);
  assert.equal(c.from, "2026-09-11");
  assert.equal(c.hidden, 40);
  assert.match(c.words, /40 older sessions are not included/);
  assert.match(c.words, /2026-09-11/);
});

test("when both kinds hit their caps the later oldest wins; a kind under its cap loses nothing", () => {
  const convs = Array.from({ length: AGENT_POINTS_CAP }, () => pt("2026-09-10"));
  const subs = Array.from({ length: AGENT_SUB_POINTS_CAP }, () => pt("2026-10-05", { sub: true }));
  assert.equal(coverFrom([...convs, ...subs], 5).from, "2026-10-06");
  assert.equal(coverFrom([...convs, pt("2026-07-01", { sub: true })], 5).from, "2026-09-11");
});

test("a cut that no kind accounts for trusts neither: the later oldest point of the two", () => {
  const c = coverFrom([pt("2026-09-10"), pt("2026-09-20", { sub: true })], 3);
  assert.equal(c.from, "2026-09-21");
});

test("clipBuckets drops buckets (and a partial week) before the cover day", () => {
  const b = [{ key: "2026-09-07" }, { key: "2026-09-14" }, { key: "2026-09-21" }];
  assert.deepEqual(clipBuckets(b, "2026-09-11").map((x) => x.key), ["2026-09-14", "2026-09-21"]);
  assert.equal(clipBuckets(b, null).length, 3);
});

test("the axis is calendar-continuous: a quiet week stays a gap", () => {
  const a = axisOf(["2026-11-02", "2026-11-23"], "week");
  assert.deepEqual(a.keys, ["2026-11-02", "2026-11-09", "2026-11-16", "2026-11-23"]);
  assert.equal(axisOf(["2026-11-01", "2026-11-04"], "day").keys.length, 4);
  assert.equal(slotX(0, 4, 0, 100), 12.5);
});

test("an absent bucket cuts the line and never draws zero", () => {
  assert.deepEqual(runsOf([1, null, 2, 3, null]).map((r) => r.map((p) => p.i)), [[0], [2, 3]]);
  const axis = axisOf(["2026-11-02", "2026-11-16"], "week");
  const v = valuesOnAxis(axis, [{ key: "2026-11-02", start: { median: 5, n: 9 } }, { key: "2026-11-16", start: { absent: "2 fresh sessions" } }], (b) => b.start);
  assert.deepEqual(v, [5, null, null]);
  assert.equal(absentSummary([{ key: "k", start: { absent: "why not" } }], (b) => b.start), "why not");
  assert.equal(absentSummary([{ key: "k", start: { median: 1, n: 5 } }], (b) => b.start), null);
});

test("markers: one row per kind, same-kind marks closer than the gap fold into one that counts", () => {
  const axis = axisOf(["2026-11-02", "2026-11-09", "2026-11-16"], "week");
  const m = (t, kind, label, count) => ({ t: at(t), kind, label, ...(count ? { count } : {}) });
  const l = placeMarkers([
    m("2026-11-03", "instructions", "CLAUDE.md edit"),
    m("2026-11-04", "instructions", "skills edit", 2),
    m("2026-11-10", "model", "model a to b"),
    m("2026-10-01", "cli", "CLI 2.0"),
    m("2026-12-30", "tag", "instr/x"),
  ], axis, 40, 340, 14);
  assert.deepEqual(l.rows, ["instructions", "model"]);
  assert.equal(l.outside, 2);
  const ins = l.placed.find((p) => p.kind === "instructions");
  assert.equal(ins.count, 3);
  assert.equal(ins.markers.length, 2);
  assert.equal(ins.row, 0);
  assert.match(markerWords(ins), /3 changes/);
  assert.equal(l.placed.find((p) => p.kind === "model").row, 1);
});

test("two marks on far apart weeks stay separate; every kind has its own shape and a word", () => {
  const axis = axisOf(["2026-11-02", "2026-11-30"], "week");
  const l = placeMarkers([{ t: at("2026-11-03"), kind: "memory", label: "a" }, { t: at("2026-11-24"), kind: "memory", label: "b" }], axis, 0, 300);
  assert.equal(l.placed.length, 2);
  assert.equal(new Set(MARKER_KINDS.map((k) => k.shape)).size, MARKER_KINDS.length);
  for (const k of MARKER_KINDS) { assert.ok(k.word); assert.match(shapePath(k.shape, 10, 10, 5), /^M/); }
});

test("models: counted over the sessions the reading is over, unnamed said", () => {
  const ps = [pt("2026-11-01", { model: "a", start: 9 }), pt("2026-11-01", { model: "b", start: 9 }), pt("2026-11-01", { model: "b", start: 9 }), pt("2026-11-01", { start: 9 }),
    pt("2026-11-01", { sub: true, model: "c", start: 9 }),
    // headless helpers, forks and sessions with no first request never enter the start reading
    pt("2026-11-01", { model: "h", start: 9, headless: true }), pt("2026-11-01", { headless: true, start: 9 }), pt("2026-11-01", { model: "f", start: 9, fresh: false }), pt("2026-11-01", { model: "z" })];
  assert.deepEqual(modelsIn(ps, "start"), { models: [{ model: "b", n: 2 }, { model: "a", n: 1 }], unnamed: 1 });
  assert.deepEqual(modelsIn(ps, "subStart").models, [{ model: "c", n: 1 }]);
  // look / req: only sessions that edited / committed
  const qs = [pt("2026-11-01", { model: "a", look: 2 }), pt("2026-11-01", { model: "b", start: 9 }), pt("2026-11-01", { model: "c", commit: true }), pt("2026-11-01", { model: "d", commit: true, req: 4 })];
  assert.deepEqual(modelsIn(qs, "look").models, [{ model: "a", n: 1 }]);
  assert.deepEqual(modelsIn(qs, "req").models, [{ model: "c", n: 1 }, { model: "d", n: 1 }]);
});

test("start-context parts stack in the given order; the biggest four keep a slot, a part never measured is dropped", () => {
  const axis = axisOf(["2026-11-02", "2026-11-09"], "week");
  const parts = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { median: v, n: 6 }]));
  const buckets = [
    { key: "2026-11-02", parts: parts({ system: 10, tools: 30, claudeMd: 20, memory: 5, skills: 8, hooks: 1 }) },
    { key: "2026-11-09", parts: parts({ system: 10, tools: 30, claudeMd: 25, memory: 5, skills: 8 }) },
  ];
  const order = [{ id: "system", label: "System" }, { id: "tools", label: "Tools" }, { id: "claudeMd", label: "CLAUDE.md" }, { id: "memory", label: "Memory" }, { id: "skills", label: "Skills" }, { id: "agents", label: "Agents" }, { id: "hooks", label: "Hooks" }];
  const bands = partBands(axis, buckets, order);
  // Four parts wear a slot; the smaller ones are ONE hueless band, last, so no two bands share a grey.
  assert.deepEqual(bands.map((b) => b.id), ["system", "tools", "claudeMd", "skills", "rest"]);
  assert.equal(bands.filter((b) => b.slot !== null).length, 4);
  assert.equal(bands.filter((b) => b.slot === null).length, 1);
  assert.equal(bands.find((b) => b.id === "tools").slot, 0);
  const rest = bands.find((b) => b.id === "rest");
  assert.deepEqual(rest.members, ["Memory", "Hooks"]);
  assert.deepEqual(rest.values, [6, 5]);
  const tops = stackTops(bands, 2);
  assert.equal(tops[1][0].lo, 10);
  assert.equal(tops[1][0].hi, 40);
  // The text twin names every part of the bucket, the folded ones too.
  assert.equal(partTwinWords({ key: "2026-11-02", parts: buckets[0].parts }, order),
    "2026-11-02: System 10 · Tools 30 · CLAUDE.md 20 · Memory 5 · Skills 8 · Hooks 1 characters (median per part)");
  assert.equal(partTwinWords({ key: "k", parts: {} }, order), null);
});

test("character ticks are not rounded to whole thousands", () => {
  assert.equal(fmtKChars(2500), "2.5k");
  assert.equal(fmtKChars(1250), "1.25k");
  assert.equal(fmtKChars(750), "750");
  assert.equal(fmtKChars(1500), "1.5k");
  assert.equal(fmtKChars(20000), "20k");
  assert.equal(fmtKChars(0), "0");
});

test("a pointer picks the slot under it, clamped to the plot, so a thin slot is still reachable", () => {
  assert.equal(slotAtX(44, 200, 44, 292), 0);
  assert.equal(slotAtX(292, 200, 44, 292), 199);
  assert.equal(slotAtX(10, 200, 44, 292), 0);
  assert.equal(slotAtX(999, 200, 44, 292), 199);
  assert.equal(slotAtX(44 + 124, 200, 44, 292), 100);
  assert.equal(slotAtX(50, 0, 44, 292), -1);
});

test("the Day chip is offered only where a day slot stays reachable", () => {
  const d = (n) => ({ t0: addLocalDays(at("2026-01-01"), n) });
  assert.equal(dayGrainOffered([]), true);
  assert.equal(dayGrainOffered([d(0), d(DAY_GRAIN_MAX_DAYS)]), true);
  assert.equal(dayGrainOffered([d(0), d(DAY_GRAIN_MAX_DAYS + 1)]), false);
});

test("the before/after sentence names no side and quotes the band", () => {
  const def = readingDef("start");
  const base = { before: 30000, after: 27000, ratio: 0.9, band: [0.8, 1.2], nBefore: 40, nAfter: 38, daysBefore: 10, daysAfter: 9, model: "opus" };
  const inside = compareWords(def, { ...base, inside: true });
  const outside = compareWords(def, { ...base, ratio: 0.5, inside: false });
  assert.match(inside, /within normal variation/);
  assert.match(outside, /outside normal week-to-week variation/);
  assert.match(inside, /30k tokens/);
  assert.match(inside, /×0.8 to ×1.2/);
  assert.equal(compareWords(def, { absent: "More than one model ran in this window." }), "More than one model ran in this window.");
  const everything = [inside, outside, compareWords(readingDef("look"), { ...base, inside: true }), compareWords(readingDef("req"), { ...base, inside: false })].join("\n");
  for (const word of ["score", "grade", "healthy", "unhealthy", "good", "bad", "should", "worse", "better", "improve", "regress", "faster", "slower", "cheaper"]) {
    assert.doesNotMatch(everything, new RegExp(`\\b${word}\\b`, "i"), `"${word}" is a verdict`);
  }
});

test("the ratio strip puts the band around the ratio and the no-change rule inside the scale", () => {
  const s = ratioScale(0.9, [0.8, 1.2], 200);
  assert.ok(s.band[0] < s.ratio && s.ratio < s.band[1]);
  assert.ok(s.one > 0 && s.one < 200);
  const far = ratioScale(2.5, [0.8, 1.2], 200);
  assert.ok(far.ratio < 200 && far.ratio > far.band[1]);
});

test("readings are worded with their unit; day keys are local", () => {
  assert.equal(fmtReading(readingDef("start"), 31200), "31.2k tokens");
  assert.equal(fmtReading(readingDef("look"), 4.26), "4.3 calls");
  assert.equal(dayKeyOfMs(at("2026-03-05")), "2026-03-05");
});

test("a folded mark lists its changes to pick from, and says which one the comparison is centred on", () => {
  const axis = axisOf(["2026-11-02", "2026-11-09", "2026-11-16"], "week");
  const l = placeMarkers([{ t: at("2026-11-03"), kind: "instructions", label: "first" }, { t: at("2026-11-10"), kind: "instructions", label: "second" }], axis, 0, 60, 28);
  assert.equal(l.placed.length, 1);
  const p = l.placed[0];
  assert.equal(markerPickLabel(p.markers[1]), "2026-11-10 second");
  const w = foldedCompareWords(p, p.markers[0]);
  assert.match(w, /folds 2 changes/);
  assert.match(w, /centred on 2026-11-03/);
  assert.match(w, /1 of the others fall inside/);
  assert.match(foldedCompareWords(p, p.markers[1]), /centred on 2026-11-10/);
  assert.equal(foldedCompareWords({ ...p, markers: [p.markers[0]] }, p.markers[0]), null);
});

test("a marker row is as tall as the touch minimum", () => assert.ok(MARK_ROW_H >= 44));
