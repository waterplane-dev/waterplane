/**
 * Composition over time: the stacked columns, the gap-filled series and the stacked areas.
 *
 * Moved out of `statsPlot.ts` unchanged (docs/notes/charts-architecture.md); that file is the
 * facade that re-exports every module in `stats/`.
 */

import {
  type TokenTotals,
} from "@waterplane/shared";
import { familySlots, REST_SLOT } from "../../../modelHue.ts";
import { f1, bandOutline } from "../chartPath.ts";
import { DAY_MS, type DayPlot, type DayPoint } from "./splotDay.ts";
import { dayKey } from "./splotWeeks.ts";

// ── composition over time ─────────────────────────────────────────────────

/**
 * A row this screen can stack: a day, and whatever is on it.
 *
 * The token totals are optional because the stack is no longer only about
 * tokens — the subagent chart stacks a COUNT of launches over the same days,
 * and the by-model view reads a nested list rather than a flat `TokenTotals`.
 * A series says how to get its own value out of a row (`at`), and the four
 * kinds keep the short form (`id`) they have always had.
 */
export interface MixRow {
  t: number;
  day: string;
  totals?: TokenTotals;
}

/**
 * One band of a stack, and where its colour comes from.
 *
 * `slot` follows the ENTITY — a kind's fixed position, a model's rank over the
 * whole corpus — and never this chart's own ordering, which is what stops a
 * range change repainting the survivors. Exactly one of `id` and `at` is used:
 * `id` reads the row's `totals`, `at` reads the row however the caller needs.
 */
export interface MixSeries<R extends MixRow = MixRow> {
  id?: keyof TokenTotals;
  at?: (row: R) => number;
  slot: number;
  name: string;
}

function seriesValue<R extends MixRow>(k: MixSeries<R>, row: R): number {
  if (k.at) return k.at(row);
  return k.id && row.totals ? (row.totals[k.id] as number) : 0;
}

export interface Band {
  /** Which of the four kinds this band is, and its palette slot. */
  kind: string;
  slot: number;
  x: number; y: number; w: number; h: number;
  /** The raw value and its share of the day, for the readout. */
  value: number;
  pct: number;
}

/**
 * One day's column split into the four kinds, stacked.
 *
 * ── Why this exists next to a comment saying stacking is wrong ──────────────
 *
 * The per-day columns above are deliberately ONE series, because 96% of every
 * column is cache reads and the other three kinds would be sub-pixel slivers
 * pretending to be information. That argument is about the ABSOLUTE stack and
 * it still holds — so this function's default is `normalize`, which rescales
 * every column to 100% and answers the question the absolute stack could not:
 * not "how much", which the chart above already says, but "did the MIX change".
 * A week where cache writes went from 3% to 12% is a week something about the
 * session shape changed, and it is invisible in every other chart on the
 * screen.
 *
 * The absolute mode is kept (`normalize: false`) because the mix and the volume
 * are two different readings and a reader who wants both should not have to
 * hold one in their head. It carries the same sliver problem, stated on screen
 * rather than fixed here: a floor that inflates a 0.007% band would be a lie
 * about a chart whose whole job is proportion.
 *
 * Bands are emitted in the kinds' own order, bottom-first, so the colour at the
 * bottom of every column is the same colour — a stack that re-orders itself per
 * column by size is unreadable across columns, which is the only direction
 * anyone reads a stack.
 */
export function stacks<R extends MixRow>(
  p: DayPlot,
  pts: R[],
  kinds: MixSeries<R>[],
  opts: { normalize?: boolean; maxW?: number } = {},
): { point: R; bands: Band[] }[] {
  const normalize = opts.normalize !== false;
  const w = Math.max(1, Math.min(opts.maxW ?? 14, p.slot - 2));
  return pts.map((point) => {
    const whole = kinds.reduce((n, k) => n + seriesValue(k, point), 0);
    const bands: Band[] = [];
    if (whole <= 0) return { point, bands };
    // The column's own height: the full plot in normalized mode, the value's
    // height in absolute mode. Accumulated in VALUE space and converted once,
    // so rounding cannot open a hairline gap between two bands.
    let acc = 0;
    for (const k of kinds) {
      const v = seriesValue(k, point);
      if (v <= 0) continue;
      const yTop = normalize
        ? p.y + p.h - ((acc + v) / whole) * p.h
        : p.py(acc + v);
      const yBottom = normalize
        ? p.y + p.h - (acc / whole) * p.h
        : p.py(acc);
      acc += v;
      bands.push({
        kind: k.name, slot: k.slot,
        x: p.px(point.t) - w / 2, y: yTop, w,
        h: Math.max(1, yBottom - yTop),
        value: v, pct: (v / whole) * 100,
      });
    }
    return { point, bands };
  });
}

// ── the area forms ────────────────────────────────────────────────────────

/**
 * The same series, with every bucket it skipped drawn in as a zero.
 *
 * ── Why filling is honest HERE and nowhere else in this file ────────────────
 *
 * `usageSegments` cuts its line across a hole and `makeDayPlot` leaves a quiet
 * fortnight as empty axis, both for the same reason: those holes are hours
 * NOBODY MEASURED, and a line across them claims a reading that was never
 * taken. The day series is the opposite case. The scan walks every conversation
 * log on the desktop, so a day missing from `days` is not a day nobody looked
 * at — it is a day with no turns in it, which is a measured zero. The tiles say
 * so out loud ("81 active days of 109").
 *
 * That distinction is what makes an area chart drawable at all. Columns can sit
 * on an axis with holes in it, because a column stands alone; an area is a
 * boundary BETWEEN its points, and drawn over an unfilled series it slopes
 * smoothly across a fortnight off as if the work had merely tapered. Filled,
 * the same fortnight is a floor — which is what happened.
 *
 * Only between the first and last point, never beyond: before the record
 * begins there is no measurement to report as zero.
 *
 * Returns **null** rather than a truncated series when the fill would exceed
 * `maxPoints` — a window at hour resolution can be tens of thousands of
 * buckets, and half a filled series is a chart whose right-hand end silently
 * changes meaning. The caller draws columns instead and says why.
 */
export function fillSeries(pts: DayPoint[], stepMs = DAY_MS, maxPoints = 4000): DayPoint[] | null {
  if (pts.length < 2) return pts;
  const span = pts[pts.length - 1].t - pts[0].t;
  if (span / stepMs + 1 > maxPoints) return null;
  const have = new Map(pts.map((p) => [p.day, p]));
  const key = stepMs < DAY_MS ? hourKeyOf : dayKey;
  const out: DayPoint[] = [];
  const end = pts[pts.length - 1].t;
  // Half a step of slack on the comparison: an hour walk across a DST switch
  // lands 3_600_000 ms off the local top of the hour, and an exact `<=` would
  // drop the last bucket of that day.
  for (let t = pts[0].t; t <= end + stepMs / 2; t = stepDate(t, stepMs)) {
    const k = key(t);
    out.push(have.get(k) ?? { t, day: k, v: 0 });
  }
  return out;
}

/** The same fill for the mix chart's rows — a skipped day is a day whose four
 *  kinds were all zero, not a day whose split is unknown. */
export function fillMix<T extends MixRow>(
  rows: T[],
  /** A day that had nothing in it, in the CALLER's row shape.
   *
   *  Handed in rather than built here because the row carries more than its
   *  totals now — the per-model split and the subagent launches ride on it —
   *  and a blank rebuilt from `{t, day, totals}` would silently drop them, so
   *  every filled-in day would read as "no model ran" instead of "no work
   *  happened". The two look identical in a stack and only one of them is
   *  true. */
  blank: (t: number, day: string) => T,
  maxPoints = 4000,
): T[] | null {
  if (rows.length < 2) return rows;
  if ((rows[rows.length - 1].t - rows[0].t) / DAY_MS + 1 > maxPoints) return null;
  const have = new Map(rows.map((r) => [r.day, r]));
  const out: T[] = [];
  const end = rows[rows.length - 1].t;
  for (let t = rows[0].t; t <= end + DAY_MS / 2; t = stepDate(t, DAY_MS)) {
    const k = dayKey(t);
    const row = have.get(k);
    out.push(row ?? blank(t, k));
  }
  return out;
}

/**
 * Which models get a band on this screen, and which slot each wears.
 *
 * ── Folded by ALIAS, not by logged id ───────────────────────────────────────
 *
 * The log records dated snapshots (`claude-haiku-4-5-20251001`) and the
 * long-context marker beside the plain alias, which are the same model at the
 * same price. Banded by raw id they are two or three bands of one model — a
 * chart that appears to show a migration nobody performed. `normalizeModel` is
 * the same fold the model ROWS on this screen already label themselves by, so
 * the bands and the rows cannot disagree about how many models there are.
 *
 * ── Why the slot is fixed, and why not a fifth hue ──────────────────────────
 *
 * Four validated slots (`TokenComposition.tsx`), one per model family, for
 * good (`modelHue.ts`): ranking by this corpus's volume made opus blue on one
 * screen and red on the next. A second model of the same family and anything
 * no family owns fold into one grey band.
 */
export interface ModelBand {
  /** The alias — what the band is called and what a day's split is matched by. */
  alias: string;
  slot: number;
}

export function modelBands(models: { key: string; label: string }[]): {
  bands: ModelBand[];
  /** The leftover band's slot, or null when every model got one. */
  restSlot: number | null;
  restName: string;
} {
  const seen: string[] = [];
  for (const m of models) {
    const alias = m.label || m.key;
    if (!seen.includes(alias)) seen.push(alias);
  }
  // FIXED family slots (`modelHue.ts`), so a model is one colour here, in the
  // reader and on the context sheet — never re-ranked by this corpus's volume.
  const of = familySlots(seen);
  const named = seen.filter((a) => of.has(a));
  const more = seen.length - named.length;
  return {
    bands: named.map((alias) => ({ alias, slot: of.get(alias)! })).sort((x, y) => x.slot - y.slot),
    restSlot: more > 0 ? REST_SLOT : null,
    restName: `${more} more`,
  };
}

/** One bucket on, through `Date` for a day so a DST switch cannot land the
 *  walk at 23:00 of the day before (`weekDays`' rule, one level down). */
function stepDate(t: number, stepMs: number): number {
  if (stepMs !== DAY_MS) return t + stepMs;
  const d = new Date(t);
  d.setDate(d.getDate() + 1);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** `YYYY-MM-DDTHH` in the LOCAL zone — the key the host bucketed hours under. */
function hourKeyOf(t: number): string {
  const d = new Date(t);
  return `${dayKey(t)}T${String(d.getHours()).padStart(2, "0")}`;
}

export interface AreaBand {
  /** Which kind this band is, and its palette slot — the same slot the strip
   *  and the legend use, because a colour must mean one thing per screen. */
  kind: string;
  slot: number;
  /** The band's filled outline. One `d` per kind, possibly several closed
   *  sub-paths when the series was cut — see `areaRuns`. */
  d: string;
}

/**
 * A run is a stretch that may be joined by a boundary.
 *
 * In the absolute stack every bucket may be joined: a zero day is a floor and
 * drawing it is the reading. In the NORMALIZED stack it may not — a day with no
 * tokens has no mix at all, and rescaling it to 100% of nothing would invent a
 * split and hold it steady across the gap. So a normalized area is cut at every
 * empty bucket, and the hole is left in the chart.
 */
export function areaRuns<R extends MixRow>(
  rows: R[],
  normalize: boolean,
  kinds: MixSeries<R>[],
): number[][] {
  const whole = (r: R) => kinds.reduce((n, k) => n + seriesValue(k, r), 0);
  if (!normalize) return rows.length ? [rows.map((_, i) => i)] : [];
  const out: number[][] = [];
  let cur: number[] | null = null;
  rows.forEach((r, i) => {
    if (whole(r) > 0) {
      if (!cur) { cur = []; out.push(cur); }
      cur.push(i);
    } else cur = null;
  });
  return out;
}

/**
 * The four kinds as stacked areas over time.
 *
 * ── Why this exists beside `stacks` ─────────────────────────────────────────
 *
 * `stacks` draws one column per day, which is the right form while a column
 * still has a column's width. Past about six weeks on a phone a day's slot is
 * under two pixels, and a stacked bar chart at two pixels a bar is an area
 * chart drawn badly: the eye reads the envelope anyway, and every gap between
 * the bars is noise it has to read through. So the same numbers get the form
 * they have already turned into — bands whose TOP EDGE is the series, which is
 * the only encoding that stays readable as the window grows.
 *
 * It is a form switch, not a different reading: `normalize` means here exactly
 * what it means there (rescale every bucket to 100% and the chart is about the
 * mix rather than the volume), the bands come out in `kinds` order bottom-first
 * so a colour keeps its place across the whole width, and nothing is
 * floor-inflated — a 0.007% band is a hairline, which is the honest picture of
 * a 96/3/0.2 split.
 *
 * A run of ONE bucket is widened to its slot rather than dropped: an area
 * through a single point has no width and would render as nothing at all,
 * which is how a week view opened on a Monday came out blank.
 */
export function stackAreas<R extends MixRow>(
  p: DayPlot,
  rows: R[],
  kinds: MixSeries<R>[],
  opts: { normalize?: boolean } = {},
): AreaBand[] {
  const normalize = opts.normalize !== false;
  const runs = areaRuns(rows, normalize, kinds);
  const half = Math.max(0.5, p.slot / 2);
  const n = f1;
  return kinds.map((k) => {
    let d = "";
    for (const run of runs) {
      const top: string[] = [];
      const bottom: string[] = [];
      for (const i of run) {
        const r = rows[i];
        const whole = kinds.reduce((acc, kk) => acc + seriesValue(kk, r), 0);
        let below = 0;
        for (const kk of kinds) {
          if (kk === k) break;
          below += seriesValue(kk, r);
        }
        const v = seriesValue(k, r);
        // Accumulated in VALUE space and converted once — the same rule as
        // `stacks`, so rounding cannot open a hairline between two bands.
        const y = (val: number) => (normalize
          ? p.y + p.h - (whole > 0 ? val / whole : 0) * p.h
          : p.py(val));
        const x = p.px(r.t);
        if (run.length === 1) {
          top.push(`${n(x - half)},${n(y(below + v))}`, `${n(x + half)},${n(y(below + v))}`);
          bottom.unshift(`${n(x - half)},${n(y(below))}`, `${n(x + half)},${n(y(below))}`);
        } else {
          top.push(`${n(x)},${n(y(below + v))}`);
          bottom.unshift(`${n(x)},${n(y(below))}`);
        }
      }
      if (!top.length) continue;
      d += bandOutline(top, bottom);
    }
    return { kind: k.name, slot: k.slot, d };
  });
}
