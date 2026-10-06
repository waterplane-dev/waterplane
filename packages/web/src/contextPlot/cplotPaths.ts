/**
 * Paths and hit-testing over the plot: the line, the area, the stacked bands and the nearest reading.
 *
 * Moved out of `contextPlot.ts` unchanged (docs/notes/charts-architecture.md); that file is the
 * facade that re-exports every module in `contextPlot/`.
 */

import {
  TOKEN_KINDS,
  sampleTotals,
  type ContextSample,
  type TokenKind,
} from "@waterplane/shared";
import { nearestByTime } from "../kit/chart/chartScale.ts";
import { f1, polyline, closedArea, bandOutline } from "../kit/chart/chartPath.ts";
import { type Plot, type SampleValue, TOK } from "./cplotAxis.ts";

/** Polyline through the readings. Empty string for an empty series, so a
 *  caller can render it unconditionally without drawing a stray `M0,0`. */
export function linePath(p: Plot, samples: ContextSample[], val: SampleValue = TOK): string {
  return polyline(samples, (s) => p.px(s.t), (s) => p.py(val(s)));
}

/**
 * The same run, closed to the baseline — the area wash under the line.
 *
 * The leading `M` of the line is replaced by an `L`, not merely dropped. Just
 * dropping it — `` `M${first},${base}${linePath(...).slice(1)}` `` — was the
 * first draft, and it renders: `M40,200` followed directly by `40,113` is
 * `M40,20040` plus an implicit lineto, so the fill began somewhere off the top
 * of the world and came back in as a wedge sticking out of the left of the
 * plot. Visible in a screenshot, invisible in a type-check, and the reason
 * there is a test asserting the path's first command.
 */
export function areaPath(p: Plot, samples: ContextSample[], val: SampleValue = TOK): string {
  const line = linePath(p, samples, val);
  if (!line) return "";
  return closedArea(line, f1(p.px(samples[0].t)), f1(p.px(samples[samples.length - 1].t)), f1(p.py(0)));
}

// ── stacked bands ─────────────────────────────────────────────────────────

/**
 * One band of a stack: what it is, and where its colour comes from.
 *
 * `key` is the IDENTITY — a token kind's id, or a model's own name — and the
 * palette slot follows it and never its rank in this particular chart. That is
 * the rule that stops a range change or a filter repainting the survivors, and
 * it is why the caller hands in a slot rather than letting this file number the
 * bands as it walks them.
 */
export interface StackSeries {
  key: string;
  name: string;
  slot: number;
  /** This band's value at one sample. Zero is a real answer and draws a band of
   *  no height; the series is never dropped for being small. */
  at: (s: ContextSample) => number;
  /** The values are what ONE request carried (`kinds`), not a running total
   *  (`cum`). Then the split is HELD from one request to the next and jumps at
   *  the next — see `stackBands`. */
  perRequest?: boolean;
}

export interface StackBand {
  key: string;
  name: string;
  slot: number;
  /** The filled outline. Empty when the series is empty — never a stray `M`. */
  d: string;
  /** What the band totals over the whole series, for the legend. */
  total: number;
}

/**
 * A stack of filled areas over the plot's own (piecewise) time axis.
 *
 * ── Why a stack, when the chart already had a curve ─────────────────────────
 *
 * The single curve answers "how much" and the composition strip at the foot of
 * the sheet answers "of what" — but the strip answers it about the whole
 * conversation at once, and the two questions people actually bring to this
 * screen are *when did that change* and *what changed it*. A session that
 * re-read a 300k window eighty times and one that wrote a fresh 300k cache
 * eighty times print an identical strip and were completely different
 * afternoons; a session that moved from opus to sonnet half-way has a curve
 * with no seam in it at all. Stacked, both are one look.
 *
 * ── The two rules that make a stack honest ──────────────────────────────────
 *
 *  - **Accumulate in VALUE space and convert once.** Adding pixel heights lets
 *    each band round independently, which opens hairline gaps between bands
 *    that are supposed to be touching — the reader sees the surface through the
 *    stack and reads it as missing data. The same rule `statsPlot.ts`'s
 *    `stacks` states, for the same reason.
 *  - **Bands come out in the caller's order, bottom first, always.** A stack
 *    that re-orders itself by size per chart is a stack whose colours move, and
 *    the bottom edge is the only one in a stack that is actually readable — so
 *    the series that must stay comparable across charts goes there.
 *
 * The top edge of the whole stack is the series the single curve drew. That is
 * deliberate and worth keeping: a reader who learnt the shape does not have to
 * learn a new one to read the composition inside it.
 */
export function stackBands(p: Plot, samples: ContextSample[], series: StackSeries[]): StackBand[] {
  if (!samples.length) return series.map((k) => ({ ...k, d: "", total: 0 }));
  const n = f1;
  // A per-request split is a fact about ONE request, not a quantity that moves
  // smoothly between two: joining a cold rebuild (all cache WRITE) to the warm
  // turn hours later (all cache READ) with straight edges drew a wedge of
  // writes shrinking across the whole gap, which never happened. So the split
  // is HELD — each request's shares of the line, from it to the next request,
  // where it jumps. The top edge is still the line: shares of the line's own
  // value sum to it, and a share times a straight line is a straight line.
  const hold = samples.length > 1 && series.length > 0 && series.every((k) => k.perRequest);
  const whole = (s: ContextSample) => series.reduce((m, k) => m + k.at(s), 0);
  return series.map((k, ki) => {
    const top: string[] = [];
    const bottom: string[] = [];
    let total = 0;
    samples.forEach((s, i) => {
      let below = 0;
      for (let j = 0; j < ki; j++) below += series[j].at(s);
      const v = k.at(s);
      total += v;
      const x = n(p.px(s.t));
      top.push(`${x},${n(p.py(below + v))}`);
      bottom.unshift(`${x},${n(p.py(below))}`);
      const next = samples[i + 1];
      if (hold && next) {
        const w = whole(s);
        const scale = w > 0 ? whole(next) / w : 0;
        const nx = n(p.px(next.t));
        top.push(`${nx},${n(p.py((below + v) * scale))}`);
        bottom.unshift(`${nx},${n(p.py(below * scale))}`);
      }
    });
    // One sample has no width to fill. The caller draws its end dot; a
    // zero-area path would render as nothing and read as a missing band.
    const d = samples.length > 1 ? bandOutline(top, bottom) : "";
    return { ...k, d, total };
  });
}

/**
 * The four token kinds as stack series, in `TOKEN_KINDS` order.
 *
 * `pick` is which tuple to read — `kinds` for what one request carried,
 * `cum` for what the conversation had spent by then — and `only` drops the
 * kinds a particular chart must not stack. The context chart passes the three
 * that ARE context: output is not in the window until the turn after, so
 * stacking it under a curve whose top edge is `tok` would draw a stack that
 * does not add up to the line it is inside.
 *
 * Null when not one sample carries the tuple — an older host — and then the
 * caller draws the single series it always drew rather than a stack of zeros.
 */
export function kindSeries(
  samples: ContextSample[],
  pick: "kinds" | "cum",
  only?: (id: TokenKind) => boolean,
): StackSeries[] | null {
  if (!samples.some((s) => s[pick])) return null;
  return TOKEN_KINDS
    .filter((k) => !only || only(k.id))
    .map((k) => ({
      key: k.id,
      name: k.name,
      slot: k.slot,
      // The tuple's order is `TOKEN_KINDS`' order, read through `sampleTotals`
      // and never by a second hand-written index — see `SampleKinds`.
      at: (s: ContextSample) => {
        const t = s[pick];
        return t ? sampleTotals(t)[k.id] : 0;
      },
      perRequest: pick === "kinds",
    }));
}

// ── hit testing ───────────────────────────────────────────────────────────

/**
 * The reading nearest a pointer x, by TIME rather than by pixel.
 *
 * Same answer at any width, which matters because the tooltip is the only way
 * to read an individual value and a phone rotating must not change which point
 * a given moment resolves to.
 */
export function nearestSample(p: Plot, samples: ContextSample[], clientX: number): ContextSample | null {
  // Through the axis's own inverse, so a compressed stretch resolves to the
  // instant it actually stands for rather than to a proportional guess.
  return nearestByTime(samples, p.tx(clientX), (s) => s.t);
}
