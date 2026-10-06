/**
 * The repo-health charts' geometry, with no DOM and no arithmetic of its own.
 *
 * ── Why this is its own file, and what it is forbidden to contain ──────────
 *
 * `contextPlot.ts` opens with the argument for separating geometry from paint:
 * a chart is the one kind of view where being slightly wrong is invisible, so
 * the scales and the paths are plain functions over plain numbers that a test
 * can pin, and the `.tsx` beside them emits SVG and nothing else. That applies
 * here too. But this file carries a SECOND rule that `contextPlot.ts` does not
 * need, and it is the more important of the two.
 *
 * **Every reading is the tool's.** `tools/repohealth/` defines what a value
 * means against its own past — the percentile rank inside a trailing window
 * and the sign of that window's slope — once, beside a frozen constants block
 * whose changes are made loud by a committed fixture and a two-part commit.
 * A percentile, a median, an OLS fit or a "since when" computed HERE would be
 * a second definition of "is this getting worse", living outside that
 * mechanism: it would agree on the day it was written and drift silently the
 * first time `RANK_WINDOW_DAYS` moved. So this module converts values to
 * pixels and does not rank, sort, fit or summarise anything.
 *
 * `repoHealthPlot.test.mjs` asserts that BY TEXT — the same shape of guard
 * `tools/repohealth.test.mjs` uses to keep `judge.mjs` off the free path,
 * because a rule that is only prose is a rule that fails silently, weeks
 * later, in a diff nobody reads as a change. If a chart wants a number this
 * file may not produce, the number is added to the tool.
 *
 * ── x is the reading index, never the calendar ─────────────────────────────
 *
 * The series is one row per first-parent commit, reduced to days, and this
 * repo's history has a 57-day hole in it. On a calendar axis two thirds of
 * every tile would be empty and the readings would be a smudge at one end. So
 * a point's x is its POSITION in the series and the caption says so; the day
 * and the sha ride on each point for the readout.
 *
 * ── A null is a cut, never a zero and never an interpolation ───────────────
 *
 * A metric that could not be read on a day is absent, not 0. Joining across it
 * draws a line through a measurement nobody took; drawing it at the floor
 * draws a collapse that never happened. Both are wrong in the direction a
 * reader would act on, so the path simply breaks and starts again.
 *
 * Pure: no DOM, no React, no imports at all, so `node --test` runs it straight
 * over the TypeScript (`repoHealthPlot.test.mjs`).
 */

/* ── the shapes this file is handed ─────────────────────────────────────────
 *
 * Structural on purpose, exactly as `repoHealthWords.ts` is. The wire's own
 * types are `@waterplane/shared`'s `RepoHealthPlot*` and stay there; what a path
 * needs is a list of numbers and holes, and a geometry module that imports the
 * DTO gains a reason to grow a field of the DTO's own meaning into a pixel
 * function. The one call site that bridges the two is `RepoHealthTiles.tsx`,
 * where a structural mismatch is a type error at the seam rather than a second
 * copy of the model.
 */

/** A value per reading, oldest first. `null` = no reading that day. */
export type Values = readonly (number | null)[];

// ── the sparkline ──────────────────────────────────────────────────────────

/**
 * One drawn reading, keyed back to its place in the series.
 *
 * The crosshair needs a pixel to snap to AND the index that pixel came from,
 * because everything a readout says about that day — the date, the sha, the
 * value — lives on the caller's own `points[i]` and not here. Carrying the
 * index rather than a copy of the point is what keeps this module free of the
 * wire's shape, and it means a readout can print a field this file has never
 * heard of.
 */
export interface Plotted {
  i: number;
  x: number;
  y: number;
}

export interface SparkGeom {
  /**
   * One `M…L…` run per unbroken stretch of readings. A hole in the middle
   * yields two runs in one `d`; a stretch of one reading with holes on both
   * sides yields nothing drawable and is carried in `dots` instead.
   */
  d: string;
  /**
   * Every reading that was drawn, joined or not, oldest first.
   *
   * Holes are NOT in here — which is the point. A crosshair that could land
   * on a day nobody measured would have to print something for it, and the
   * only honest something is a blank; snapping to the nearest reading instead
   * means the readout always names a day that was actually read.
   */
  pts: Plotted[];
  /** Where the fitted top and bottom of the box actually are, so a y label
   *  lands ON the line it names rather than near it. Equal for a flat series
   *  (both mid-height), which is the caller's cue to print one label. */
  hiY: number;
  loY: number;
  /** Lone readings with no neighbour to join — drawn as points, so an island
   *  in a gappy series is visible rather than silently dropped. */
  dots: { x: number; y: number }[];
  /** The last reading. Null only when there is none, which cannot happen for a
   *  geom that exists. */
  endX: number;
  endY: number;
  /** Every reading in the window had the same value. The curve is then drawn
   *  at MID-height rather than divided by a zero span — a flat series is a
   *  measurement, and a chart that renders it at the floor says it collapsed. */
  flat: boolean;
  /** Readings actually drawn, and the holes they are drawn among. The caller
   *  prints both: a two-point line across fourteen indices is not a trend. */
  readings: number;
  holes: number;
  /** The fitted domain, for a caller that wants to say what the box spans.
   *  Each series carries its own unit, so there is no shared axis to quote. */
  lo: number;
  hi: number;
}

/** At least this many readings before a curve is drawn at all. One point is a
 *  value, not a shape, and the tile prints the value anyway. */
export const MIN_READINGS = 2;

/**
 * A series as a path inside a `w × h` box, x by reading index.
 *
 * Null below `MIN_READINGS` readings — the caller says so in words rather than
 * drawing a box with a dot in it. The y domain is this series' OWN low and
 * high: the six tiles carry six units (lines, chars, a dimensionless rate, a
 * count) and a shared axis across them would be a claim that they are
 * comparable.
 *
 * Half a pixel of inset top and bottom so the stroke at either extreme is
 * fully inside the box, the same guard `contextPlot.ts`'s spend miniature
 * uses.
 */
export function sparkGeom(values: Values, w: number, h: number): SparkGeom | null {
  const n = values.length;
  let readings = 0;
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of values) {
    if (v === null || !Number.isFinite(v)) continue;
    readings++;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (readings < MIN_READINGS) return null;

  const flat = hi === lo;
  const px = (i: number) => (n === 1 ? w : (i / (n - 1)) * w);
  // The flat case is the whole reason this is not `(v - lo) / (hi - lo)`:
  // that is 0/0, which renders as `NaN` in a path attribute and paints
  // nothing at all — a series that never moved would vanish instead of
  // reading as a series that never moved.
  const py = (v: number) =>
    flat ? h / 2 : (h - 0.5) - ((v - lo) / (hi - lo)) * (h - 1);

  const runs: string[] = [];
  const dots: { x: number; y: number }[] = [];
  const pts: Plotted[] = [];
  let run: string[] = [];
  const flush = () => {
    if (run.length > 1) runs.push(`M${run.join("L")}`);
    else if (run.length === 1) {
      const [x, y] = run[0].split(",");
      dots.push({ x: Number(x), y: Number(y) });
    }
    run = [];
  };
  let endX = 0;
  let endY = 0;
  for (let i = 0; i < n; i++) {
    const v = values[i];
    if (v === null || !Number.isFinite(v)) { flush(); continue; }
    const x = px(i);
    const y = py(v);
    pts.push({ i, x, y });
    run.push(`${x.toFixed(1)},${y.toFixed(1)}`);
    endX = x;
    endY = y;
  }
  flush();

  return {
    d: runs.join(""), pts, dots, endX, endY, flat, readings, holes: n - readings, lo, hi,
    hiY: py(hi), loY: py(lo),
  };
}

// ── the axes, and the thing a finger lands on ──────────────────────────────

/** One x tick: which reading it marks, and where that reading sits. */
export interface AxisTick {
  i: number;
  x: number;
}

/**
 * Where to put the x labels, as READING INDICES.
 *
 * Placed by position across the box and read back to an index, never by
 * dividing the date span — this axis is reading order (see the header), so
 * "half way along" is the middle READING and not the middle day. On a history
 * with a 57-day hole those are nowhere near each other, and labelling by date
 * arithmetic would print a caption under a place on the axis that day never
 * occupied.
 *
 * Deduped by index, so a three-reading series gets three ticks and a
 * two-reading series gets two rather than the same label twice at the same x.
 * Ascending by construction — nothing here puts anything in an order.
 *
 * `want` has NO default: how many labels fit is a fact about the box and the
 * font, which is the caller's to know. A default here would be this module
 * holding a visual decision, and a second copy of it at the call site.
 */
export function indexTicks(n: number, w: number, want: number): AxisTick[] {
  if (n <= 0) return [];
  if (n === 1) return [{ i: 0, x: w }];
  const count = Math.max(2, Math.min(want, n));
  const out: AxisTick[] = [];
  for (let k = 0; k < count; k++) {
    const i = Math.round((k / (count - 1)) * (n - 1));
    if (out.length && out[out.length - 1].i === i) continue;
    out.push({ i, x: (i / (n - 1)) * w });
  }
  return out;
}

/**
 * The drawn reading nearest an x, or null when there is none.
 *
 * Nearest by PIXEL and with no cut-off distance: a finger anywhere over the
 * box picks something, because a crosshair that goes blank between points
 * reads as a broken control rather than as a gap. What it may not do is
 * invent a point in a hole — it can only return one of the readings it was
 * handed, which is why holes never reach this function.
 */
export function nearestPlotted(pts: readonly Plotted[], x: number): Plotted | null {
  let best: Plotted | null = null;
  let bestD = Infinity;
  for (const p of pts) {
    const d = Math.abs(p.x - x);
    if (d < bestD) { bestD = d; best = p; }
  }
  return best;
}

// ── the stacked bands ──────────────────────────────────────────────────────

export interface StackInput {
  key: string;
  label: string;
  /** Palette slot. Handed IN, never numbered here: colour follows the entity
   *  and not its position in whatever chart it happens to be in. */
  slot: number;
  values: Values;
}

export interface StackBand {
  key: string;
  label: string;
  slot: number;
  /** The filled outline, one closed shape per unbroken stretch. */
  d: string;
  /**
   * Columns with no neighbour to make a shape with.
   *
   * A stretch of one column has no width, so a polygon over it is empty and
   * the band would simply vanish for that day — in a gappy history, that is
   * most of the chart disappearing with nothing saying it did. The caller
   * draws each of these as a hairline rect, which is what one column of a
   * stack actually is.
   */
  stubs: { x: number; y0: number; y1: number }[];
  /** The band's own latest value, for the legend. Null when the latest column
   *  is absent — the legend then says so rather than printing an older day. */
  last: number | null;
}

export interface StackGeom {
  bands: StackBand[];
  /** Every WHOLE column, at the top edge — what the crosshair snaps to. A
   *  column missing a band is not in here for the same reason `totals` says
   *  null there: there is no total to point at. */
  pts: Plotted[];
  /** Where `top` and zero actually are, so the two axis labels land on the
   *  edges they name. */
  topY: number;
  zeroY: number;
  /** The top edge of the whole stack: the TOTAL, as a line, so the chart that
   *  prints a total prints its split in the same mark. */
  topLine: string;
  /** Per index: the total, or null where any band had no reading. */
  totals: (number | null)[];
  /** The value the top of the box stands for. */
  top: number;
}

/**
 * Two or more series as bands that add up, over the same reading index.
 *
 * ── Why a column is all-or-nothing ─────────────────────────────────────────
 *
 * A stack's top edge is a total. If one band has no reading on a day and the
 * others do, a stack drawn anyway reports a total that is short by an unknown
 * amount, and it does it in the one mark a reader takes as the sum. So a
 * column where any band is absent is a HOLE in every band, and `totals` says
 * `null` there. The alternative — dropping the absent band to zero — is the
 * same lie with a shape.
 *
 * ── Accumulated in value space ─────────────────────────────────────────────
 *
 * Bands are summed as numbers and converted once, never added as pixel
 * heights: rounding each band independently opens hairline gaps between bands
 * that are meant to touch, and the reader sees the surface through the stack
 * and reads it as missing data. The same rule `contextPlot.ts`'s `stackBands`
 * and `statsPlot.ts`'s `stacks` state, for the same reason.
 *
 * Unlike a sparkline this axis is ZERO-BASED, because the quantity IS a total:
 * a fitted floor would draw a stack whose bottom band is cut off.
 */
export function stackGeom(inputs: readonly StackInput[], w: number, h: number): StackGeom | null {
  if (!inputs.length) return null;
  const n = inputs[0].values.length;
  if (!n) return null;
  // Every `points` array in one plot is the same length by construction. A
  // caller that has assembled a ragged set has a bug upstream; refusing is the
  // only answer that cannot draw a misaligned total.
  for (const s of inputs) if (s.values.length !== n) return null;

  const totals: (number | null)[] = [];
  let top = 0;
  let columns = 0;
  for (let i = 0; i < n; i++) {
    let sum = 0;
    let whole = true;
    for (const s of inputs) {
      const v = s.values[i];
      if (v === null || !Number.isFinite(v)) { whole = false; break; }
      sum += v;
    }
    totals.push(whole ? sum : null);
    if (whole) { columns++; if (sum > top) top = sum; }
  }
  if (columns < MIN_READINGS) return null;
  // A stack of zeros has no height to divide by; the bands are then all at the
  // baseline, which is exactly what "nothing was measured but the days exist"
  // looks like, and is not the flat case a fitted axis has to special-case.
  const px = (i: number) => (n === 1 ? w : (i / (n - 1)) * w);
  const py = (v: number) => (top > 0 ? (h - 0.5) - (v / top) * (h - 1) : h - 0.5);

  const bands: StackBand[] = inputs.map((s, si) => {
    const shapes: string[] = [];
    const stubs: { x: number; y0: number; y1: number }[] = [];
    let topEdge: string[] = [];
    let underside: string[] = [];
    const flush = () => {
      if (topEdge.length > 1) shapes.push(`M${topEdge.join("L")}L${underside.join("L")}Z`);
      else if (topEdge.length === 1) {
        const [x, y1] = topEdge[0].split(",").map(Number);
        const y0 = Number(underside[0].split(",")[1]);
        stubs.push({ x, y0, y1 });
      }
      topEdge = [];
      underside = [];
    };
    for (let i = 0; i < n; i++) {
      if (totals[i] === null) { flush(); continue; }
      let below = 0;
      for (let j = 0; j < si; j++) below += inputs[j].values[i] as number;
      const v = inputs[si].values[i] as number;
      const x = px(i).toFixed(1);
      topEdge.push(`${x},${py(below + v).toFixed(1)}`);
      underside.unshift(`${x},${py(below).toFixed(1)}`);
    }
    flush();
    const lastV = s.values[n - 1];
    return {
      key: s.key,
      label: s.label,
      slot: s.slot,
      d: shapes.join(""),
      stubs,
      last: totals[n - 1] === null ? null : (lastV as number),
    };
  });

  const runs: string[] = [];
  const pts: Plotted[] = [];
  let run: string[] = [];
  const flushLine = () => { if (run.length > 1) runs.push(`M${run.join("L")}`); run = []; };
  for (let i = 0; i < n; i++) {
    const t = totals[i];
    if (t === null) { flushLine(); continue; }
    pts.push({ i, x: px(i), y: py(t) });
    run.push(`${px(i).toFixed(1)},${py(t).toFixed(1)}`);
  }
  flushLine();

  return { bands, pts, topLine: runs.join(""), totals, top, topY: py(top), zeroY: py(0) };
}

// ── the dumbbell ───────────────────────────────────────────────────────────

export interface DumbbellInput {
  key: string;
  label: string;
  /** The near end — what a change in this area usually carries. */
  from: number | null;
  /** The far end — what it carries if every body is loaded. */
  to: number | null;
}

export interface DumbbellRow {
  key: string;
  label: string;
  y: number;
  /** Null where that end was not measured; the caller draws the end it has and
   *  says which one is missing rather than inventing a bar. */
  x1: number | null;
  x2: number | null;
}

export interface DumbbellGeom {
  rows: DumbbellRow[];
  /** The value the right edge stands for, shared by every row — the whole
   *  point of this form is comparing the areas to each other. */
  max: number;
  height: number;
}

/**
 * One row per area: where it usually sits, and where it can reach.
 *
 * A before→after pair per item is a dumbbell (one hue, two shades), and it is
 * the only form that keeps both numbers visible: two bars would invite reading
 * the difference as a stack, and a single bar of the difference would hide the
 * magnitude both ends are a fraction of.
 *
 * ONE x scale across the rows, because the comparison is between areas. The
 * scale is zero-based for the same reason a stack is: these are magnitudes.
 */
export function dumbbellGeom(
  inputs: readonly DumbbellInput[],
  w: number,
  rowH: number,
  padLeft = 0,
): DumbbellGeom {
  let max = 0;
  for (const r of inputs) {
    for (const v of [r.from, r.to]) {
      if (v !== null && Number.isFinite(v) && v > max) max = v;
    }
  }
  const span = Math.max(0, w - padLeft);
  const px = (v: number) => padLeft + (max > 0 ? (v / max) * span : 0);
  const rows = inputs.map((r, i) => ({
    key: r.key,
    label: r.label,
    y: i * rowH + rowH / 2,
    x1: r.from !== null && Number.isFinite(r.from) ? px(r.from) : null,
    x2: r.to !== null && Number.isFinite(r.to) ? px(r.to) : null,
  }));
  return { rows, max, height: inputs.length * rowH };
}

// ── the categorical palette, in geometry form ──────────────────────────────

/** The categorical palette has four validated slots and a fifth is never
 *  generated. Anything past the fourth entity folds into one band with no hue
 *  of its own, which the caller draws in ink and names in the legend. */
export const SLOTS = 4;
/** The slot a folded remainder carries: not a colour, a marker. */
export const FOLDED_SLOT = -1;
export const FOLDED_KEY = " rest";

/** One band of a stack, before the tail is folded: a name and a value per
 *  reading, with no colour yet — the slot is assigned by `foldPartSeries`. */
export interface PartSeries {
  key: string;
  label: string;
  values: Values;
  /**
   * Which of these parts are the big ones, as the TOOL stated it on the latest
   * day: 0 is the largest, ties broken by name. It decides MEMBERSHIP of the
   * fold and nothing else — the array stays in the caller's name order and a
   * hue is still assigned by name among the kept.
   *
   * Absent — on every part, or on any one of them — means nobody stated it,
   * and the fold goes back to position exactly as it did before the field
   * existed. Never treated as 0: 0 is the claim "this is the largest", which
   * would keep the smallest band on screen and fold the tree away.
   *
   * It arrives on the wire under the tool's own word for it, and the rename
   * here is deliberate. This module is held by a text guard
   * (`repoHealthPlot.test.mjs`) to computing no reading, and that guard's
   * handle is the vocabulary — a word it bans is a word no reader has to
   * adjudicate. What arrives here is not a reading of this repo: it is an
   * index in an order somebody else stated, which is the thing the `.sort()`
   * ban already says out loud — *an order is a claim; the tool states it and
   * this file draws what it was given*. So it is named for what it is to this
   * module, the guard stays blunt, and the tests below pin the property the
   * guard is there for: membership comes off this number and is never derived
   * from the values.
   */
  bySize?: number;
}

/**
 * The same fold as `foldParts`, over SERIES rather than over one day.
 *
 * Four validated slots and a fifth that is never generated, so anything past
 * the fourth entity is summed into one band with no hue of its own. Order is
 * the CALLER's throughout — a slot follows the entity, never its size on the
 * day you happen to be looking at, or a package that grew past another would
 * swap colours with it halfway along its own curve.
 *
 * WHICH parts survive the fold is the tool's, off `bySize`, and that is a
 * different question from which hue they wear. With name order deciding both,
 * this repo's chart kept `.` (158 lines), `deploy` (122) and `packages/app`
 * (140) and folded `packages/web` (80,062) and `packages/host` (47,084) into
 * the hueless remainder: three slivers and one bar, a chart of the tree's
 * smallest corners drawn with the confidence of one of its largest. So
 * membership comes off the stated order and the hue still comes off the name.
 * Nothing here derives either.
 *
 * With `bySize` absent from any part, or stating something other than a clean
 * cut at the palette's width, the fold is positional — exactly what it was
 * before the field existed, which is what a desktop one version behind gets.
 * The fallback is by construction and not a repair: past the palette there are
 * always `SLOTS` bands and never a generated fifth, whatever arrives.
 *
 * The sum is null at any index where ANY member is null. That is the same
 * all-or-nothing rule `stackGeom` applies to a column, and for the same
 * reason: a folded band short by an unknown amount reports a total nobody
 * measured, in the one mark a reader takes as the sum.
 */
export function foldPartSeries(
  parts: readonly PartSeries[],
  restLabel: string,
): (PartSeries & { slot: number })[] {
  if (parts.length <= SLOTS) return parts.map((p, i) => ({ ...p, slot: i }));
  const keeps = SLOTS - 1;
  // A stated cut is used only when it IS a cut: every part placed, and exactly
  // as many of them inside the palette as there are slots for. Anything else
  // (a repeated place, a gap, one part that did not say) is nobody's statement
  // and falls back to position rather than being patched into one here.
  const stated = parts.every((p) => typeof p.bySize === "number" && Number.isFinite(p.bySize) && p.bySize >= 0)
    && parts.filter((p) => (p.bySize as number) < keeps).length === keeps;
  const kept = (p: PartSeries, i: number) => (stated ? (p.bySize as number) < keeps : i < keeps);
  const head: (PartSeries & { slot: number })[] = [];
  const tail: PartSeries[] = [];
  parts.forEach((p, i) => {
    if (kept(p, i)) head.push({ ...p, slot: head.length });
    else tail.push(p);
  });
  const n = tail[0]?.values.length ?? 0;
  const merged: (number | null)[] = [];
  for (let i = 0; i < n; i++) {
    let sum = 0;
    let whole = true;
    for (const t of tail) {
      const v = t.values[i];
      if (v === null || v === undefined || !Number.isFinite(v)) { whole = false; break; }
      sum += v;
    }
    merged.push(whole ? sum : null);
  }
  return [...head, {
    key: FOLDED_KEY,
    label: `${restLabel} (${tail.length})`,
    values: merged,
    slot: FOLDED_SLOT,
  }];
}

// ── the tape ───────────────────────────────────────────────────────────────

export interface ColumnsGeom {
  bars: { x: number; y: number; w: number; h: number }[];
  /** What the top of the box stands for. Printed, because a column chart with
   *  no axis is a shape until the magnitude is named. */
  max: number;
}

/**
 * A distribution of today as columns, in the order it arrived.
 *
 * Not sorted here: the tool hands the tape biggest-first and re-sorting it
 * would be this module deciding an order, which is the one thing its header
 * says it does not do. A minimum height of 1 px keeps the smallest file a
 * visible column rather than a gap in the row.
 */
export function columnsGeom(values: readonly number[], w: number, h: number, gap = 1): ColumnsGeom | null {
  const n = values.length;
  if (!n) return null;
  let max = 0;
  for (const v of values) if (Number.isFinite(v) && v > max) max = v;
  if (!(max > 0)) return null;
  const slot = w / n;
  const bw = Math.max(1, slot - gap);
  const bars = values.map((v, i) => {
    const use = Number.isFinite(v) && v > 0 ? v : 0;
    const bh = Math.max(use > 0 ? 1 : 0, (use / max) * h);
    return { x: i * slot, y: h - bh, w: bw, h: bh };
  });
  return { bars, max };
}

// ── who held the longest-file crown ────────────────────────────────────────

/** One stretch of the longest-file curve held by one file. */
export interface HolderRun {
  /** Null = that reading carried no name (an engine older than the field). */
  path: string | null;
  slot: number;
  /** `M…L…` over the run's points, or "" for a run of one reading. */
  d: string;
  /** A run of ONE reading has no line to draw, so it is a dot. */
  dot: { x: number; y: number } | null;
}

/** A reading where the crown passed from one NAMED file to another. */
export interface Handover {
  i: number;
  x: number;
  y: number;
  /** Where the previous holder's line ended, so the step can be drawn. */
  fromX: number;
  fromY: number;
  slot: number;
}

export interface HolderGeom {
  runs: HolderRun[];
  handovers: Handover[];
  /** Each named file once, newest holder first, with its slot and the index
   *  range of the readings it held. `readings` counts them, not the span. */
  holders: { path: string; slot: number; first: number; last: number; readings: number }[];
  /** Whether any reading carried no name — the legend then says so. */
  unnamed: boolean;
}

/**
 * The longest-file curve cut into one run per HOLDER.
 *
 * A length alone cannot tell "App.tsx grew 400 lines" from "a different file
 * took the crown", and on a repo that splits its biggest file the second is
 * the event worth seeing: the curve drops and a new name takes over. So the
 * line changes hue where the file changes, and the change itself is a mark.
 *
 * Slots go to the NEWEST holders: the one today is slot 0 on every repo, and
 * a file the crown left long ago is the one that folds into ink when there are
 * more than four. A hole in the readings cuts a run exactly as it cuts every
 * other line here; a handover is only marked between two NAMED readings — an
 * unnamed one next to a name is not evidence the file changed.
 */
export function holderGeom(paths: readonly (string | null)[], pts: readonly Plotted[]): HolderGeom {
  const slotOf = new Map<string, number>();
  const holders: HolderGeom["holders"] = [];
  const byPath = new Map<string, HolderGeom["holders"][number]>();
  let unnamed = false;
  for (let k = pts.length - 1; k >= 0; k--) {
    const p = paths[pts[k].i] ?? null;
    if (p == null) { unnamed = true; continue; }
    let h = byPath.get(p);
    if (!h) {
      const slot = slotOf.size < SLOTS ? slotOf.size : FOLDED_SLOT;
      slotOf.set(p, slot);
      h = { path: p, slot, first: pts[k].i, last: pts[k].i, readings: 0 };
      byPath.set(p, h);
      holders.push(h);
    }
    h.first = pts[k].i;
    h.readings++;
  }

  const runs: HolderRun[] = [];
  const handovers: Handover[] = [];
  let cur: { path: string | null; at: Plotted[] } | null = null;
  const flush = () => {
    if (!cur || !cur.at.length) return;
    const slot = cur.path == null ? FOLDED_SLOT : slotOf.get(cur.path) ?? FOLDED_SLOT;
    const one = cur.at.length === 1;
    runs.push({
      path: cur.path,
      slot,
      d: one ? "" : `M${cur.at.map((q) => `${q.x.toFixed(1)},${q.y.toFixed(1)}`).join("L")}`,
      dot: one ? { x: cur.at[0].x, y: cur.at[0].y } : null,
    });
  };
  let lastNamed: { path: string; q: Plotted } | null = null;
  for (let k = 0; k < pts.length; k++) {
    const q = pts[k];
    const p = paths[q.i] ?? null;
    const prev = k > 0 ? pts[k - 1] : null;
    const hole = !prev || q.i !== prev.i + 1;
    if (!cur || hole || cur.path !== p) {
      flush();
      cur = { path: p, at: [] };
    }
    cur.at.push(q);
    if (p != null) {
      if (lastNamed && lastNamed.path !== p) {
        handovers.push({
          i: q.i, x: q.x, y: q.y, fromX: lastNamed.q.x, fromY: lastNamed.q.y,
          slot: slotOf.get(p) ?? FOLDED_SLOT,
        });
      }
      lastNamed = { path: p, q };
    }
  }
  flush();
  return { runs, handovers, holders, unnamed };
}
