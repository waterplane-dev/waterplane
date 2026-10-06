/**
 * Horizontal bars, the composition strip and the clock face.
 *
 * Moved out of `statsPlot.ts` unchanged (docs/notes/charts-architecture.md); that file is the
 * facade that re-exports every module in `stats/`.
 */

import {
  fmtCount,
  tokenTotal,
  type TokenTotals,
} from "@waterplane/shared";

// ── horizontal bars ───────────────────────────────────────────────────────

export interface BarRow<T> {
  item: T;
  label: string;
  value: number;
  /** Fraction of the largest row, 0..1 — the bar's own width. */
  frac: number;
  /** Fraction of the whole, for the "x% of everything" reading. */
  share: number;
  text: string;
}

/**
 * Rows for a horizontal bar list, scaled to the LARGEST row rather than to the
 * total.
 *
 * Scaling to the total is the intuitive choice and the wrong one: with a long
 * tail every bar but the first is a stub, and the chart stops distinguishing
 * the things it exists to compare. The share of the whole is carried as a
 * number instead, and printed.
 */
export function barRows<T>(items: T[], value: (t: T) => number, label: (t: T) => string): BarRow<T>[] {
  const vals = items.map(value);
  const max = vals.reduce((m, v) => (v > m ? v : m), 0);
  const sum = vals.reduce((a, b) => a + b, 0);
  return items.map((item, i) => ({
    item,
    label: label(item),
    value: vals[i],
    frac: max > 0 ? vals[i] / max : 0,
    share: sum > 0 ? vals[i] / sum : 0,
    text: fmtCount(vals[i]),
  }));
}

// ── the composition strip ─────────────────────────────────────────────────

export interface Segment {
  kind: string;
  slot: number;
  value: number;
  /** Percent of the whole, un-rounded — the label rounds, the geometry must not. */
  pct: number;
  /** Left edge and width as percentages, for a CSS/SVG strip. */
  x: number;
  w: number;
  /** Whether the segment is wide enough to carry a label inside it. A label
   *  that does not fit is moved out, never clipped. */
  roomy: boolean;
}

/**
 * The four kinds as one 100%-wide bar.
 *
 * `minW` is the honest part. A kind that is 0.007% of the total would render as
 * zero pixels and vanish — and a part-to-whole chart that silently omits a part
 * is not a part-to-whole chart. So every non-zero kind gets at least a visible
 * sliver, and the widths of the big segments are reduced to pay for it, which
 * is a distortion worth taking because the alternative is an omission. The
 * exact values ride in the legend either way.
 */
export function compose(
  totals: TokenTotals,
  kinds: { id: keyof TokenTotals; slot: number; name: string }[],
  minW = 1.5,
): Segment[] {
  const whole = tokenTotal(totals);
  if (whole <= 0) return [];
  const raw = kinds.map((k) => ({ k, v: totals[k.id] as number }));
  const present = raw.filter((r) => r.v > 0);
  const owed = present.reduce((n, r) => n + Math.max(0, minW - (r.v / whole) * 100), 0);
  // Pay for the slivers out of the segments that can afford it, in proportion
  // to how much they have over the floor.
  const fat = present.filter((r) => (r.v / whole) * 100 > minW);
  const fatSum = fat.reduce((n, r) => n + ((r.v / whole) * 100 - minW), 0);

  let x = 0;
  const out: Segment[] = [];
  for (const r of raw) {
    const pct = (r.v / whole) * 100;
    if (r.v <= 0) continue;
    let w = Math.max(minW, pct);
    if (fatSum > 0 && pct > minW) w = pct - (owed * (pct - minW)) / fatSum;
    out.push({ kind: r.k.name, slot: r.k.slot, value: r.v, pct, x, w, roomy: w >= 14 });
    x += w;
  }
  return out;
}

// ── the clock face ────────────────────────────────────────────────────────

export interface ClockColumn {
  /** 0..23. */
  hour: number;
  x: number; y: number; w: number; h: number;
  value: number;
  /** Share of the whole day's work, 0..1. */
  share: number;
}

/**
 * The 24-hour profile as columns, on a CATEGORICAL axis.
 *
 * Not the time axis above, and the distinction is the point: `makeDayPlot`
 * plots instants, and hour 23 is adjacent to hour 0 of the next day, not to
 * hour 22 of this one. A clock face is a position, every slot is the same
 * width, and the slot for an hour nobody ever worked is drawn empty rather than
 * skipped — "I have never once started before 9" is a reading, and it is only
 * available if the empty slots are there.
 */
export function clockColumns(
  values: number[],
  box: { x: number; y: number; w: number; h: number },
  gap = 2,
): ClockColumn[] {
  const n = values.length || 24;
  const slot = box.w / n;
  const w = Math.max(1, slot - gap);
  const peak = values.reduce((m, v) => (v > m ? v : m), 0);
  const sum = values.reduce((a, b) => a + b, 0);
  return values.map((value, hour) => {
    // Floored at a hairline for the same reason as `columns`: an hour that had
    // a little work and an hour that had none must not render identically.
    const h = peak > 0 ? Math.max(value > 0 ? 1 : 0, (value / peak) * box.h) : 0;
    return {
      hour, value,
      x: box.x + hour * slot + gap / 2,
      y: box.y + box.h - h,
      w, h,
      share: sum > 0 ? value / sum : 0,
    };
  });
}
