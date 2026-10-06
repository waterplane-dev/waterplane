/**
 * The context graph's axes: the piecewise time axis, the plot box and its y domain.
 *
 * Moved out of `contextPlot.ts` unchanged (docs/notes/charts-architecture.md); that file is the
 * facade that re-exports every module in `contextPlot/`.
 */

import {
  contextPct,
  type AgentRun,
  type ContextEvent,
  type ContextSample,
} from "@waterplane/shared";
import { fmtTokens } from "../kit/chart/chartFmt.ts";
import { pctScale, yScale, plotBox, plotY } from "../kit/chart/chartScale.ts";

// ── the time axis, and why it is not a straight line ──────────────────────

/**
 * A stretch with no readings in it longer than this is COMPRESSED, and marked.
 *
 * This app exists for sessions that hit a usage wall in the evening and resume
 * the next morning, so a strictly proportional time axis is not a neutral
 * choice here — it is the choice that makes the chart useless. Measured on a
 * real session: one wall on a Wednesday, forty minutes of work on the Friday,
 * and every reading crammed into the right-hand 2% of the plot with the other
 * 98% empty. Forty-five minutes is above an ordinary pause mid-task and well
 * below the stretches that cause that.
 */
export const GAP_BREAK_MS = 45 * 60_000;
/** Compressed stretches drawn at most. Past a handful the axis is more break
 *  than chart; the longest ones win, the rest stay proportional. */
export const MAX_BREAKS = 8;
/** How wide a compressed stretch is drawn. Wide enough for the ⁄⁄ mark and for
 *  a wall band that fell inside it to still be a visible sliver. */
export const BREAK_PX = 18;

/** One compressed stretch, for the marker and for the sentence naming it. */
export interface TimeBreak { x: number; w: number; from: number; to: number }

interface Seg { t0: number; t1: number; x0: number; w: number; dead: boolean }

export interface TimeScale {
  t0: number; t1: number;
  px: (t: number) => number;
  /** The inverse, so hit-testing works on a broken axis too. */
  tx: (x: number) => number;
  breaks: TimeBreak[];
}

/**
 * A piecewise-linear time axis: proportional everywhere something happened,
 * and a fixed narrow strip wherever nothing did for a long time.
 *
 * `marks` are the instants that must keep their relative spacing — the
 * readings, plus the domain edges. Everything between two consecutive marks is
 * one stretch; a long one is compressed and reported in `breaks` so the caller
 * can draw the discontinuity rather than hide it. An axis that silently
 * collapses time is a lie; one that says where it did is a convention.
 */
export function timeScale(marks: number[], x0: number, w: number, t0: number, t1: number): TimeScale {
  const pts = [...new Set([t0, ...marks, t1])].filter((t) => t >= t0 && t <= t1).sort((a, b) => a - b);
  const span = t1 - t0;
  const linear = (): TimeScale => ({
    t0, t1,
    px: (t) => x0 + ((t - t0) / (span || 1)) * w,
    tx: (x) => t0 + ((x - x0) / (w || 1)) * (span || 1),
    breaks: [],
  });
  if (span <= 0 || pts.length < 2) return linear();

  // The longest stretches with nothing in them, up to the cap.
  const dead = pts.slice(0, -1)
    .map((a, i) => ({ from: a, to: pts[i + 1] }))
    .filter((g) => g.to - g.from > GAP_BREAK_MS)
    .sort((a, b) => (b.to - b.from) - (a.to - a.from))
    .slice(0, MAX_BREAKS)
    .sort((a, b) => a.from - b.from);
  if (!dead.length) return linear();

  const breakW = Math.min(BREAK_PX, w / (dead.length * 3 || 1));
  const liveSpan = span - dead.reduce((n, g) => n + (g.to - g.from), 0);
  const liveW = w - dead.length * breakW;
  // Everything is dead time — a session that hit a wall and never came back.
  // Nothing to expand into, so keep the plain axis rather than divide by zero.
  if (liveSpan <= 0 || liveW <= 0) return linear();

  const segs: Seg[] = [];
  let acc = x0;
  let prev = t0;
  for (const g of dead) {
    if (g.from > prev) {
      const sw = ((g.from - prev) / liveSpan) * liveW;
      segs.push({ t0: prev, t1: g.from, x0: acc, w: sw, dead: false });
      acc += sw;
    }
    segs.push({ t0: g.from, t1: g.to, x0: acc, w: breakW, dead: true });
    acc += breakW;
    prev = g.to;
  }
  if (t1 > prev) {
    segs.push({ t0: prev, t1, x0: acc, w: x0 + w - acc, dead: false });
  }

  const px = (t: number): number => {
    if (t <= t0) return x0;
    if (t >= t1) return x0 + w;
    for (const s of segs) {
      if (t <= s.t1) return s.x0 + (s.t1 > s.t0 ? ((t - s.t0) / (s.t1 - s.t0)) * s.w : 0);
    }
    return x0 + w;
  };
  const tx = (x: number): number => {
    if (x <= x0) return t0;
    if (x >= x0 + w) return t1;
    for (const s of segs) {
      if (x <= s.x0 + s.w) return s.t0 + (s.w > 0 ? ((x - s.x0) / s.w) * (s.t1 - s.t0) : 0);
    }
    return t1;
  };
  return { t0, t1, px, tx, breaks: segs.filter((s) => s.dead).map((s) => ({ x: s.x0, w: s.w, from: s.t0, to: s.t1 })) };
}

export interface Plot {
  /** Inner plot box, in SVG user units. */
  x: number; y: number; w: number; h: number;
  /** Domains. `yMax` is the LAST of `yTicks`, never a separate rounding. */
  t0: number; t1: number; yMax: number;
  /** Tick positions, in TOKENS. `fmtYTick` turns one into its label. */
  yTicks: number[];
  /** The window the axis calls 100%, or null when it is a token axis. */
  windowTok: number | null;
  /** Domain → plot coordinate. Piecewise: see `timeScale`. */
  px: (t: number) => number;
  /** Plot coordinate → domain, the exact inverse of `px`. */
  tx: (x: number) => number;
  py: (v: number) => number;
  /** Stretches the axis compressed, so the caller can DRAW the break. */
  breaks: TimeBreak[];
}

export interface PlotInput {
  width: number;
  height: number;
  pad: { top: number; right: number; bottom: number; left: number };
  samples: ContextSample[];
  /**
   * The window the axis calls 100%, or null when the model is unrecognised —
   * in which case the axis falls back to tokens fitted to the data, and the
   * caller is expected to SAY that the scale is not the shared one.
   */
  windowTok: number | null;
  /** Reference lines that MUST fit inside the y domain (the observed
   *  auto-compact point). The window itself is the axis top, not a ref. */
  refs: number[];
  /** Events widen the time domain too — a wall after the last reading is the
   *  most interesting thing on the chart and must not fall off the right. */
  events: ContextEvent[];
  /**
   * What the y axis has to CONTAIN — the reading by default, the running total
   * for the spend chart.
   *
   * The axis is fitted to this and to `refs`. Left at the default while
   * plotting `used`, every cumulative curve would be drawn clipped to the top
   * of a domain fitted to a single request, i.e. a flat line along the ceiling
   * — the failure this file's header calls the one kind that is invisible.
   */
  value?: SampleValue;
  /**
   * How many y ticks to aim for — fewer on a short chart.
   *
   * Only reaches the TOKEN axis: the percentage axis is in whole 25% steps on
   * every chart in the app, which is what makes two of them comparable, and a
   * caller must not be able to talk it out of that.
   */
  yWant?: number;
  /**
   * The session's subagents, whose OWN windows (`AgentRun.ctx`) share this
   * chart. Their times anchor the x axis like the readings do: while a
   * fan-out runs, the parent log is silent — so a scale built from the
   * parent's readings alone compressed exactly the hours the agents worked
   * into break stripes. On the reading axis their peaks are in the y domain.
   */
  agents?: AgentRun[];
}

/** Every dated point of every agent's own window. */
function agentTimes(agents: AgentRun[] | undefined): number[] {
  return (agents ?? []).flatMap((a) => (a.ctx ?? []).map(([t]) => t));
}

export function makePlot(inp: PlotInput): Plot {
  const { width, height, pad, samples, refs, events, windowTok } = inp;
  const aTimes = agentTimes(inp.agents);
  const { w, h } = plotBox(width, height, pad);

  const times = [
    ...samples.map((s) => s.t),
    ...events.map((e) => e.t),
    // A block's own reset instant is part of the story; the band has to fit.
    ...events.flatMap((e) => (e.resetAt != null ? [e.resetAt] : [])),
    ...aTimes,
  ];
  let t0 = times.length ? Math.min(...times) : 0;
  let t1 = times.length ? Math.max(...times) : 1;
  // A single reading, or several inside one millisecond, would divide by zero.
  if (t1 <= t0) { t0 -= 30_000; t1 += 30_000; }

  const value = inp.value ?? TOK;
  const own = samples.reduce((m, s) => (value(s) > m ? value(s) : m), 0);
  // Agent windows are READINGS, so they are in the domain only on the
  // reading axis; a caller plotting something else (the running total) has
  // passed its own `value`.
  const peak = inp.value ? own : Math.max(own, ...(inp.agents ?? []).map((a) => a.peakTok ?? 0));
  // Every reference line is inside the domain by construction — see the header.
  const { top: yMax, ticks: yTicks } = windowTok
    ? pctScale(windowTok, Math.max(peak, ...refs))
    : yScale(Math.max(peak, ...refs, 1), inp.yWant);
  // Only the READINGS anchor the axis. An event inside a compressed stretch is
  // drawn inside it — a wall that kept its full proportional width would take
  // the plot over, since being blocked is the longest thing that happens here.
  const ts = timeScale([...samples.map((s) => s.t), ...aTimes].sort((a, b) => a - b), pad.left, w, t0, t1);

  return {
    x: pad.left, y: pad.top, w, h, t0, t1, yMax, yTicks, windowTok,
    px: ts.px, tx: ts.tx, breaks: ts.breaks,
    py: plotY(pad.top, h, yMax),
  };
}

/** "2 d" / "3 h 40" / "45 min" — how much time a compressed stretch holds. */
export function fmtGap(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 90) return `${m} min`;
  const h = m / 60;
  if (h < 36) return `${Math.round(h * 10) / 10} h`;
  return `${Math.round(h / 24 * 10) / 10} d`;
}

/** A y tick's label: a percentage on the shared axis, tokens when there is no
 *  window and the chart has already said the scale is its own. */
export function fmtYTick(p: Plot, v: number): string {
  const pct = contextPct(v, p.windowTok);
  return pct == null ? fmtTokens(v) : `${Math.round(pct)}%`;
}

/**
 * A reading, worded ONCE — for the crosshair and for the table row.
 *
 * The two are the chart and its table twin, and a twin that words a value
 * differently from the chart is not a twin.
 */
export function fmtReading(tok: number, windowTok: number | null): string {
  const pct = contextPct(tok, windowTok);
  return pct == null ? fmtTokens(tok) : `${Math.round(pct)}% · ${fmtTokens(tok)}`;
}

// ── paths ─────────────────────────────────────────────────────────────────

/**
 * What a path is drawn THROUGH — the reading, or the running total beside it.
 *
 * A parameter rather than a second pair of path builders: the two curves share
 * every rule that matters (the piecewise time axis, the clamp into the y
 * domain, the `L`-not-splice of the area's first command), and a copy of this
 * geometry that drifted would be a chart that looks right and is not.
 */
export type SampleValue = (s: ContextSample) => number;
export const TOK: SampleValue = (s) => s.tok;
export const USED: SampleValue = (s) => s.used ?? 0;
