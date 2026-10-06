/**
 * The repo-health charts' geometry, pinned without a browser.
 *
 * `repoHealthPlot.ts` has no DOM and no imports at all, so it runs the way
 * `repoHealthWords.test.mjs` and `setupRemedy.test.mjs` run — `node --test`
 * straight over the TypeScript:
 *
 *     node --test packages/web/src/repoHealthPlot.test.mjs
 *
 * Two kinds of thing are worth pinning here, and they fail in opposite ways.
 *
 * The geometry fails LOUDLY-LOOKING-FINE: a line joined across a day nobody
 * measured is a perfectly smooth curve, a flat series divided by its own zero
 * span is a path full of `NaN` that paints nothing, and a stack whose bands
 * are added as pixel heights is a chart with hairlines through it. All three
 * render without an error and all three are wrong.
 *
 * The last test is not about geometry at all. It is the guard that keeps the
 * READING — the percentile rank and the slope sign — defined once, in
 * `tools/repohealth/`, beside the frozen constants and the fixture that pin
 * them. The same shape of assertion `tools/repohealth.test.mjs` uses to keep
 * the paid judge off the free path: strip the comments, then check the code
 * cannot even name the thing. A rule that is only prose fails silently, weeks
 * later, in a diff nobody reads as a change.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  FOLDED_KEY,
  FOLDED_SLOT,
  MIN_READINGS,
  SLOTS,
  columnsGeom,
  dumbbellGeom,
  foldPartSeries,
  indexTicks,
  nearestPlotted,
  sparkGeom,
  stackGeom,
} from "./repoHealthPlot.ts";

const SRC = fileURLToPath(new URL("./repoHealthPlot.ts", import.meta.url));

/** Every `M` in a path — one per unbroken stretch of readings. */
const runs = (d) => (d.match(/M/g) ?? []).length;

// ───────────────────────────────────────────────────────────────────────────
// A null is a cut.
// ───────────────────────────────────────────────────────────────────────────

test("a hole breaks the line instead of being drawn through", () => {
  const g = sparkGeom([1, 2, null, 4, 5], 100, 20);
  assert.equal(runs(g.d), 2, "two stretches, not one line across the gap");
  assert.equal(g.readings, 4);
  assert.equal(g.holes, 1);
  // And the gap keeps its place on the axis: x is the reading INDEX, so the
  // second stretch starts three fifths of the way across, not straight after
  // the first. A gap that closed up would silently re-date every point after it.
  assert.match(g.d, /M75\.0,/);
});

test("a hole is never interpolated and never drawn at zero", () => {
  // The floor of this box is y=19.5 and its ceiling y=0.5. If the missing day
  // were drawn at 0 the path would touch the floor; if it were interpolated
  // there would be a point at x=50 at all.
  const g = sparkGeom([10, 10, null, 10, 10], 100, 20);
  assert.equal(runs(g.d), 2);
  assert.ok(!g.d.includes("M50.0,") && !g.d.includes("L50.0,"), "no coordinate at the hole's index");
});

test("a reading with holes on both sides is a dot, not a dropped point", () => {
  const g = sparkGeom([1, null, 7, null, 3], 100, 20);
  assert.equal(g.d, "", "nothing to join");
  assert.equal(g.dots.length, 3, "three islands, all visible");
  assert.equal(g.readings, 3);
});

test("under two readings there is no curve at all — the caller says why", () => {
  assert.equal(MIN_READINGS, 2);
  assert.equal(sparkGeom([], 100, 20), null);
  assert.equal(sparkGeom([null, null, null], 100, 20), null);
  assert.equal(sparkGeom([4], 100, 20), null);
  assert.equal(sparkGeom([null, 4, null], 100, 20), null);
  assert.ok(sparkGeom([4, 5], 100, 20));
});

// ───────────────────────────────────────────────────────────────────────────
// A series that never moved is a measurement.
// ───────────────────────────────────────────────────────────────────────────

test("a constant series draws at mid-height, not at NaN and not on the floor", () => {
  const g = sparkGeom([7, 7, 7, 7], 100, 20);
  assert.equal(g.flat, true);
  assert.doesNotMatch(g.d, /NaN/, "(v - lo) / (hi - lo) is 0/0 for a flat series");
  // Every y is exactly half the box.
  for (const [, y] of [...g.d.matchAll(/[ML]([\d.]+),([\d.]+)/g)].map((m) => [m[1], m[2]])) {
    assert.equal(Number(y), 10, "a flat series sits in the middle of its own box");
  }
  assert.equal(g.endY, 10);
});

test("a series with a single reading repeated among holes is still flat, not absent", () => {
  const g = sparkGeom([3, null, 3], 100, 20);
  assert.equal(g.flat, true);
  assert.equal(g.readings, 2);
});

test("each series is fitted to its own low and high — there is no shared axis", () => {
  // Six tiles carry six units; a shared axis across them would be a claim that
  // lines, chars and a dimensionless rate are comparable magnitudes.
  const a = sparkGeom([100, 200], 100, 20);
  const b = sparkGeom([0.1, 0.2], 100, 20);
  assert.deepEqual([a.lo, a.hi], [100, 200]);
  assert.deepEqual([b.lo, b.hi], [0.1, 0.2]);
  assert.equal(a.endY, b.endY, "the same shape, each in its own units");
});

// ───────────────────────────────────────────────────────────────────────────
// The stack: a top edge is a total, so it may never be short.
// ───────────────────────────────────────────────────────────────────────────

const claude = { key: "claudeMd", label: "CLAUDE.md", slot: 0, values: [10, 12, 11] };
const desc = { key: "desc", label: "descriptions", slot: 1, values: [5, 6, 9] };

test("the bands sum to the total in value space, at every column", () => {
  const g = stackGeom([claude, desc], 100, 40);
  assert.deepEqual(g.totals, [15, 18, 20]);
  assert.equal(g.top, 20);
  // The top edge IS the total, so its y at the last column is the ceiling of
  // the box — proof the two bands were accumulated as numbers and converted
  // once, rather than each rounded to pixels and added.
  const ys = [...g.topLine.matchAll(/[ML][\d.]+,([\d.]+)/g)].map((m) => Number(m[1]));
  assert.equal(ys[2], 0.5, "the tallest total reaches the top of the box");
  const mid = 39.5 - (18 / 20) * 39;
  assert.equal(ys[1], Number(mid.toFixed(1)));
});

test("a column where any band is absent is a hole in every band", () => {
  // Drawing the others anyway would report a total short by an unknown amount,
  // in the one mark a reader takes as the sum.
  const g = stackGeom(
    [{ ...claude, values: [10, 12, null, 11, 11] }, { ...desc, values: [5, 6, 9, 9, 9] }],
    100, 40,
  );
  assert.deepEqual(g.totals, [15, 18, null, 20, 20]);
  assert.equal(runs(g.topLine), 2);
  for (const b of g.bands) assert.equal(runs(b.d), 2, `${b.key} breaks where the total does`);
});

test("a lone column is a hairline, never a band that silently vanishes", () => {
  // A stretch of one column has no width, so its polygon is empty. In a gappy
  // history that is most of the chart disappearing with nothing saying so.
  const g = stackGeom(
    [{ ...claude, values: [10, null, 11, null, 12] }, { ...desc, values: [5, null, 6, null, 7] }],
    100, 40,
  );
  assert.equal(g.bands[0].d, "", "nothing has a neighbour to make a shape with");
  assert.equal(g.bands[0].stubs.length, 3);
  assert.equal(g.bands[1].stubs.length, 3);
  const s = g.bands[0].stubs[0];
  assert.ok(s.y0 > s.y1, "the stub spans the band's own slice of the column");
});

test("each band carries its own latest value, and null where the column is absent", () => {
  const g = stackGeom([claude, desc], 100, 40);
  assert.deepEqual(g.bands.map((b) => b.last), [11, 9]);
  const gone = stackGeom(
    [{ ...claude, values: [10, 12, null] }, { ...desc, values: [5, 6, 9] }],
    100, 40,
  );
  assert.deepEqual(gone.bands.map((b) => b.last), [null, null]);
});

test("a ragged set is refused rather than drawn misaligned", () => {
  assert.equal(stackGeom([claude, { ...desc, values: [5, 6] }], 100, 40), null);
});

test("the stack is zero-based — a band is never cut off at the bottom", () => {
  const g = stackGeom([{ ...claude, values: [1, 1, 1] }, { ...desc, values: [99, 99, 99] }], 100, 40);
  assert.equal(g.top, 100);
  const bottom = [...g.bands[0].d.matchAll(/[ML][\d.]+,([\d.]+)/g)].map((m) => Number(m[1]));
  assert.ok(bottom.includes(39.5), "the first band starts at the baseline, not at its own floor");
});

// ───────────────────────────────────────────────────────────────────────────
// The dumbbell, the bar and the tape.
// ───────────────────────────────────────────────────────────────────────────

test("every dumbbell row shares one x scale — the comparison is between areas", () => {
  const g = dumbbellGeom(
    [
      { key: "host", label: "host", from: 20, to: 40 },
      { key: "web", label: "web", from: 10, to: 80 },
    ],
    100, 20,
  );
  assert.equal(g.max, 80);
  assert.equal(g.rows[1].x2, 100, "the biggest reaches the right edge");
  assert.equal(g.rows[0].x2, 50, "and everything else is against it");
  assert.equal(g.height, 40);
});

test("an end that was not measured has no coordinate, so nothing invents a bar", () => {
  const g = dumbbellGeom([{ key: "a", label: "a", from: null, to: 40 }], 100, 20);
  assert.equal(g.rows[0].x1, null);
  assert.equal(g.rows[0].x2, 100);
});

test("the tape keeps the order it arrived in", () => {
  // The tool hands it over biggest-first. Re-sorting here would be this module
  // deciding an order, which is the one thing its header says it never does.
  const g = columnsGeom([100, 50, 10], 30, 20, 1);
  assert.equal(g.max, 100);
  assert.ok(g.bars[0].h > g.bars[1].h && g.bars[1].h > g.bars[2].h);
  assert.equal(g.bars[0].x, 0);
});

test("the smallest column is still a column", () => {
  const g = columnsGeom([10_000, 1], 100, 40);
  assert.ok(g.bars[1].h >= 1, "a 1-line file is a mark, not a gap in the row");
});

test("no tape is null, never an empty chart", () => {
  assert.equal(columnsGeom([], 100, 20), null);
  assert.equal(columnsGeom([0, 0], 100, 20), null);
});

// ───────────────────────────────────────────────────────────────────────────
// The axes, and what a finger can land on.
// ───────────────────────────────────────────────────────────────────────────

test("a tick marks a READING, and sits where that reading sits", () => {
  // The middle tick is the middle READING, never the middle date: this
  // history has a 57-day hole, so "half way along the axis" and "half way
  // through the span" are weeks apart, and labelling by date arithmetic puts
  // a caption under a place on the axis that day never occupied.
  const t = indexTicks(5, 100, 3);
  assert.deepEqual(t.map((x) => x.i), [0, 2, 4]);
  assert.deepEqual(t.map((x) => x.x), [0, 50, 100]);
});

test("two readings get two ticks, not the same label twice", () => {
  assert.deepEqual(indexTicks(2, 100, 3).map((t) => t.i), [0, 1]);
  // Three readings cannot have a middle that is also an end.
  assert.deepEqual(indexTicks(3, 100, 3).map((t) => t.i), [0, 1, 2]);
  assert.equal(indexTicks(0, 100, 3).length, 0);
  assert.deepEqual(indexTicks(1, 100, 3), [{ i: 0, x: 100 }]);
});

test("the crosshair can only land on a day that was read", () => {
  // The hole at index 2 is nowhere in `pts`, so a finger over the middle of
  // the box snaps to a neighbour. A crosshair that could stop in a gap would
  // have to print a reading for a day nobody measured.
  const g = sparkGeom([1, 2, null, 4, 5], 100, 20);
  assert.deepEqual(g.pts.map((p) => p.i), [0, 1, 3, 4]);
  assert.equal(nearestPlotted(g.pts, 50).i, 1, "nearer the reading at x=25 than the one at x=75");
  assert.equal(nearestPlotted(g.pts, 60).i, 3);
  assert.equal(nearestPlotted(g.pts, -40).i, 0, "off the left edge is still a reading, never null");
  assert.equal(nearestPlotted([], 10), null);
});

test("a point carries its INDEX back, not a copy of itself", () => {
  // Everything a readout says about a day — the date, the sha, the unit —
  // lives on the caller's `points[i]`. Carrying the index is what keeps this
  // module free of the wire's shape.
  const g = sparkGeom([7, 8, 9], 100, 20);
  assert.deepEqual(g.pts.map((p) => p.i), [0, 1, 2]);
  assert.equal(g.pts[2].x, g.endX);
  assert.equal(g.pts[2].y, g.endY);
});

test("the same reading is a different pixel at a different width", () => {
  // Which is why a crosshair holds the INDEX and looks the pixel up again
  // every render. Held as coordinates it survives the phone rotating, and
  // then the ring is painted at the old orientation's x while the readout
  // still names the old day — the two halves of one chart describing two
  // different points, with nothing on screen saying so.
  const vals = [1, 2, 3, 4, 5];
  const narrow = sparkGeom(vals, 100, 20);
  const wide = sparkGeom(vals, 300, 20);
  const i = 3;
  const a = narrow.pts.find((p) => p.i === i);
  const b = wide.pts.find((p) => p.i === i);
  assert.equal(a.i, b.i);
  assert.notEqual(a.x, b.x, "75 against 225 — a stale pixel is three quarters of a box out");
});

test("the y labels land ON the fitted edges, which are not zero", () => {
  const g = sparkGeom([100, 200], 100, 20);
  assert.equal(g.hiY, 0.5, "the high sits at the top of the box");
  assert.equal(g.loY, 19.5, "and the low at the bottom — the axis is FITTED");
  // Which is the whole reason both get printed: an unlabelled fitted axis
  // reads as a zero-based one, and a 100→200 rise on it looks like a collapse
  // to nothing followed by a full box.
  assert.equal(g.lo, 100);
  assert.equal(g.hi, 200);
});

test("a flat series has one edge, so the caller prints one label", () => {
  const g = sparkGeom([7, 7, 7], 100, 20);
  assert.equal(g.hiY, 10);
  assert.equal(g.loY, 10, "both at mid-height: there is one value, not a span");
});

test("the stack's crosshair skips a column that is missing a band", () => {
  // `totals` is null there for the reason the header gives — a top edge that
  // is short by an unknown amount is a lie in the one mark a reader takes as
  // the sum — so there is nothing to point at either.
  const g = stackGeom(
    [
      { key: "a", label: "a", slot: 0, values: [1, null, 3] },
      { key: "b", label: "b", slot: 1, values: [1, 2, 3] },
    ],
    100, 20,
  );
  assert.deepEqual(g.pts.map((p) => p.i), [0, 2]);
  assert.equal(nearestPlotted(g.pts, 50).i, 0);
});

test("the stack's axis is zero-based, and says so with both labels", () => {
  const g = stackGeom(
    [{ key: "a", label: "a", slot: 0, values: [10, 20] }],
    100, 20,
  );
  assert.equal(g.top, 20);
  assert.equal(g.topY, 0.5);
  assert.equal(g.zeroY, 19.5, "zero is the floor — a fitted floor would cut off the bottom band");
});

test("a stack folds its tail the same way a single bar does", () => {
  const parts = [
    { key: "a", label: "a", values: [1, 2] },
    { key: "b", label: "b", values: [1, 2] },
    { key: "c", label: "c", values: [1, 2] },
    { key: "d", label: "d", values: [1, 2] },
    { key: "e", label: "e", values: [1, 2] },
  ];
  const out = foldPartSeries(parts, "the rest");
  assert.equal(out.length, SLOTS, "four bands, never a generated fifth");
  assert.deepEqual(out.map((p) => p.slot), [0, 1, FOLDED_SLOT === -1 ? 2 : 2, FOLDED_SLOT]);
  assert.equal(out[3].label, "the rest (2)");
  assert.deepEqual(out[3].values, [2, 4], "the tail is summed, not dropped");
});

test("four or fewer packages each keep their own slot", () => {
  const parts = [
    { key: "a", label: "a", values: [1] },
    { key: "b", label: "b", values: [2] },
  ];
  assert.deepEqual(foldPartSeries(parts, "the rest").map((p) => p.slot), [0, 1]);
});

test("which parts survive the fold is the TOOL's, and the hue is still the name's", () => {
  // The failure this pins, measured on this repo: with name order deciding
  // both, the chart kept `.` (158 lines), `deploy` (122) and `packages/app`
  // (140) and folded `packages/web` (80,062) and `packages/host` (47,084)
  // into the hueless remainder. `bySize` is the tool's statement of which are
  // the big ones — 0 is the largest on the latest day — and it decides
  // membership and nothing else.
  const parts = [
    { key: ".", label: ".", values: [158], bySize: 5 },
    { key: "deploy", label: "deploy", values: [122], bySize: 7 },
    { key: "packages/app", label: "packages/app", values: [140], bySize: 6 },
    { key: "packages/host", label: "packages/host", values: [47084], bySize: 1 },
    { key: "packages/shared", label: "packages/shared", values: [22112], bySize: 2 },
    { key: "packages/web", label: "packages/web", values: [80062], bySize: 0 },
    { key: "scripts", label: "scripts", values: [2185], bySize: 4 },
    { key: "tools", label: "tools", values: [7328], bySize: 3 },
  ];
  const out = foldPartSeries(parts, "the rest");
  assert.deepEqual(out.map((p) => [p.key, p.slot]), [
    ["packages/host", 0],
    ["packages/shared", 1],
    ["packages/web", 2],
    [FOLDED_KEY, FOLDED_SLOT],
  ], "the three biggest are kept, in NAME order, and the slot is that order's");
  assert.equal(out[3].label, "the rest (5)");
  assert.deepEqual(out[3].values, [158 + 122 + 140 + 2185 + 7328]);
});

test("the fold reads the stated order and never derives one from the values", () => {
  // The property the text guard below exists for, asserted as behaviour: the
  // biggest numbers on this chart are in the parts the tool placed LAST, and
  // the fold follows what it was told rather than what it could compute.
  const parts = [
    { key: "a", label: "a", values: [1], bySize: 0 },
    { key: "b", label: "b", values: [1], bySize: 1 },
    { key: "c", label: "c", values: [1], bySize: 2 },
    { key: "d", label: "d", values: [9_000_000], bySize: 3 },
    { key: "e", label: "e", values: [8_000_000], bySize: 4 },
  ];
  const out = foldPartSeries(parts, "the rest");
  assert.deepEqual(out.map((p) => p.key), ["a", "b", "c", FOLDED_KEY]);
});

test("with nothing stated the fold is positional, exactly as it was", () => {
  // A desktop or an engine one version behind sends no such field, and the
  // answer is the behaviour that shipped — never a 0, which is the claim
  // "this is the largest" and would keep the smallest band on screen.
  const parts = [
    { key: "a", label: "a", values: [1] },
    { key: "b", label: "b", values: [1] },
    { key: "c", label: "c", values: [1] },
    { key: "d", label: "d", values: [1] },
    { key: "e", label: "e", values: [1] },
  ];
  assert.deepEqual(foldPartSeries(parts, "the rest").map((p) => p.key), ["a", "b", "c", FOLDED_KEY]);

  // One part that did not say is not a statement about the set either.
  const half = parts.map((p, i) => (i === 4 ? p : { ...p, bySize: 4 - i }));
  assert.deepEqual(foldPartSeries(half, "the rest").map((p) => p.key), ["a", "b", "c", FOLDED_KEY]);
});

test("a stated order that is not a clean cut cannot grow a fifth band", () => {
  // Four validated slots, whatever arrives. A repeated place or a gap is
  // nobody's statement, so it falls back to position rather than being
  // patched here into a cut somebody might have meant.
  const parts = ["a", "b", "c", "d", "e"].map((k) => ({ key: k, label: k, values: [1], bySize: 0 }));
  const out = foldPartSeries(parts, "the rest");
  assert.equal(out.length, SLOTS);
  assert.deepEqual(out.map((p) => p.key), ["a", "b", "c", FOLDED_KEY]);
});

test("a slot follows the entity, not its size today", () => {
  // The rule this palette exists for, and the one the wire broke: the tool
  // used to hand its packages over largest-first, so the morning `host`
  // overtook `web` the two swapped hues halfway along their own curves and
  // every earlier reading appeared to change hands. Position decides the
  // slot here, so the ORDER is the promise — `tools/repohealth.mjs` now sends
  // them by name and `tools/repohealth.test.mjs` holds it to that.
  const order = [
    { key: "host", label: "host", values: [1] },
    { key: "web", label: "web", values: [99] },
  ];
  assert.deepEqual(foldPartSeries(order, "rest").map((p) => [p.key, p.slot]), [["host", 0], ["web", 1]]);
});

test("a folded band is null where any member is, never short by one package", () => {
  // The same all-or-nothing rule a column obeys: a band summed over a missing
  // member reports a total nobody measured, inside the mark a reader takes as
  // the sum.
  const parts = [
    { key: "a", label: "a", values: [1, 1] },
    { key: "b", label: "b", values: [1, 1] },
    { key: "c", label: "c", values: [1, 1] },
    { key: "d", label: "d", values: [1, null] },
    { key: "e", label: "e", values: [1, 1] },
  ];
  const out = foldPartSeries(parts, "the rest");
  assert.deepEqual(out[3].values, [2, null]);
});

// ───────────────────────────────────────────────────────────────────────────
// The guard: the reading belongs to the tool.
// ───────────────────────────────────────────────────────────────────────────

test("this module cannot compute a reading", () => {
  // Comments may discuss it — the header explains the whole arrangement, and a
  // rule nobody can describe is a rule nobody keeps. What must not exist is
  // code that derives a rank, a slope, a median or an order.
  //
  // The tool now STATES which groups are the big ones, and that number had to
  // reach this file for the fold to stop keeping the smallest three. It
  // arrives as `PartSeries.bySize`, not under the tool's own word, and the
  // list below is unchanged. The alternative was carving an exception into
  // this guard — "the word is allowed when it comes off a prop" — which no
  // text check can express and which leaves the next reader adjudicating each
  // use. A guard worth having is blunt. What it protects is asserted above as
  // behaviour, not only as vocabulary: the fold follows the stated order even
  // when the values contradict it, and falls back to position when nothing
  // was stated.
  const code = readFileSync(SRC, "utf8").replace(/\/\*[\s\S]*?\*\/|(^|\s)\/\/[^\n]*/g, "");
  const banned = [
    [/percentile/i, "a percentile is the tool's reading, defined beside its frozen constants"],
    [/\brank\b/i, "a rank re-derived here drifts the first time RANK_WINDOW_DAYS moves"],
    [/\bslope\b/i, "the slope's sign is a reading, not a scale"],
    [/\bmedian\b|\bquantile\b|\bp95\b/i, "a quantile computed here is a second definition of the same number"],
    [/regression|\bOLS\b|\bbeta\b/i, "the trailing fit lives in tools/repohealth/series.mjs and nowhere else"],
    [/\.sort\s*\(/, "an order is a claim; the tool states it and this file draws what it was given"],
  ];
  for (const [re, why] of banned) {
    assert.doesNotMatch(code, re, `${why}. If a chart wants this number, add it to the tool.`);
  }
});

test("and it has no imports to reach one through", () => {
  const code = readFileSync(SRC, "utf8").replace(/\/\*[\s\S]*?\*\/|(^|\s)\/\/[^\n]*/g, "");
  assert.doesNotMatch(code, /^\s*import\s/m, "pure: node --test runs it straight over the TypeScript");
});

// ───────────────────────────────────────────────────────────────────────────
// The longest file changing hands.
// ───────────────────────────────────────────────────────────────────────────

test("the crown changing hands is a new run and a marked handover", async () => {
  const { holderGeom } = await import("./repoHealthPlot.ts");
  const g = sparkGeom([100, 120, 90, 95], 30, 20);
  const h = holderGeom(["a.ts", "a.ts", "b.ts", "b.ts"], g.pts);
  assert.equal(h.runs.length, 2);
  assert.equal(h.handovers.length, 1);
  assert.equal(h.handovers[0].i, 2);
  assert.equal(h.handovers[0].fromX, g.pts[1].x, "the step starts where the old holder's line ended");
  // Today's holder is slot 0 whatever came before it.
  assert.deepEqual(h.holders.map((x) => [x.path, x.slot, x.first, x.last, x.readings]),
    [["b.ts", 0, 2, 3, 2], ["a.ts", 1, 0, 1, 2]]);
});

test("a hole cuts a run, and an unnamed reading is never a handover", async () => {
  const { holderGeom } = await import("./repoHealthPlot.ts");
  const g = sparkGeom([1, null, 2, 3, 4], 40, 20);
  const h = holderGeom(["a", null, "a", null, "a"], g.pts);
  assert.equal(h.handovers.length, 0, "a name missing for a day is not the file changing");
  assert.equal(h.unnamed, true);
  assert.equal(h.runs.length, 4);
  assert.ok(h.runs[0].dot && !h.runs[0].d, "a lone reading is a dot, not a zero-length path");
});

test("past four holders the oldest fold into ink, never a fifth hue", async () => {
  const { holderGeom } = await import("./repoHealthPlot.ts");
  const g = sparkGeom([1, 2, 3, 4, 5, 6], 50, 20);
  const h = holderGeom(["f", "e", "d", "c", "b", "a"], g.pts);
  assert.deepEqual(h.holders.map((x) => x.slot), [0, 1, 2, 3, FOLDED_SLOT, FOLDED_SLOT]);
  assert.equal(h.holders[0].path, "a");
  assert.equal(h.handovers.length, 5);
});
