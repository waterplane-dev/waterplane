/**
 * The row miniatures: the context sparkline and the spend sparkline.
 *
 * Moved out of `contextPlot.ts` unchanged (docs/notes/charts-architecture.md); that file is the
 * facade that re-exports every module in `contextPlot/`.
 */

import {
  costText,
  type ContextEvent,
  type ContextSpark,
} from "@waterplane/shared";
import { fmtTokens } from "../kit/chart/chartFmt.ts";
import { pctScale } from "../kit/chart/chartScale.ts";
import { f1, polyline, closedArea } from "../kit/chart/chartPath.ts";

// ── the sparkline ─────────────────────────────────────────────────────────

export interface SparkGeom {
  /** Polyline through the readings, in a `w × h` box. */
  line: string;
  /** The same closed to the baseline. */
  area: string;
  /** Last reading, for the end dot. */
  endX: number; endY: number;
  /** One x per event tick, with what it was. */
  ticks: { x: number; kind: ContextEvent["kind"] }[];
  /** y of the reference line, or null when nothing was observed to draw one. */
  refY: number | null;
  /** The agents' envelope (`ContextSpark.agentEnv`) closed to the floor, on
   *  the SAME axis as the line — clamped at its top, never re-scaling the
   *  parent's curve to fit an agent. Null when the spark carries none. */
  agentArea: string | null;
  /** The envelope's highest value, for the title. */
  agentPeak: number | null;
}

/**
 * The row miniature's geometry.
 *
 * The SAME fixed axis as the chart — 0 to 100% of the model's window — which
 * is the entire reason it is worth putting a curve on a list row. Scaled to
 * each row's own peak instead, a session at 8% and one at 94% draw the identical
 * shape, and the miniature becomes decoration. A row whose window is unknown
 * falls back to its own peak and draws no reference line, so it is visibly a
 * different kind of readout rather than a comparable one that is wrong.
 */
export function sparkGeom(spark: ContextSpark, w: number, h: number): SparkGeom | null {
  const pts = spark.pts;
  if (!pts.length) return null;
  const ref = spark.autoCompactTok ?? null;
  const yMax = spark.windowTok
    ? pctScale(spark.windowTok, Math.max(spark.peak, ref ?? 0)).top
    : Math.max(spark.peak, ref ?? 0, ...pts, 1);
  const px = (i: number) => (pts.length === 1 ? w : (i / (pts.length - 1)) * w);
  const py = (v: number) => h - (Math.max(0, Math.min(v, yMax)) / yMax) * h;
  const line = polyline(pts, (_v, i) => px(i), (v) => py(v));
  return {
    line,
    // `L`, not a bare splice — see `areaPath` for what the bare splice draws.
    area: closedArea(line, "0", f1(px(pts.length - 1)), h),
    endX: px(pts.length - 1),
    endY: py(pts[pts.length - 1]),
    ticks: spark.marks.map((m) => ({ x: m.at * w, kind: m.kind })),
    refY: ref != null ? py(ref) : null,
    ...agentEnvGeom(spark.agentEnv, pts.length, px, py, h),
  };
}

/** The spark's agent envelope as a filled path — only where it is aligned with
 *  the readings and something in it is above zero. */
function agentEnvGeom(env: number[] | undefined, n: number, px: (i: number) => number, py: (v: number) => number, h: number): { agentArea: string | null; agentPeak: number | null } {
  if (!env || env.length !== n || !env.some((v) => v > 0)) return { agentArea: null, agentPeak: null };
  const line = env.map((v, i) => `L${px(i).toFixed(1)},${py(v).toFixed(1)}`).join("");
  return {
    agentArea: `M${px(0).toFixed(1)},${h}${line}L${px(n - 1).toFixed(1)},${h}Z`,
    agentPeak: Math.max(...env),
  };
}

// ── the spend miniature ───────────────────────────────────────────────────

export interface SpendSparkGeom {
  /** Polyline through the cumulative spend, in a `w × h` box. */
  line: string;
  /** The same closed to the baseline. */
  area: string;
  /** Last point, for the end dot. */
  endX: number; endY: number;
  /** y of the dashed grand total — the subagent share drawn as the GAP above
   *  the curve. Null when there is no separate total to draw, which is both
   *  "no agents" and "no host total at all". */
  totalY: number | null;
  /** What the top of the box stands for, in tokens. The title quotes it,
   *  because this axis is the row's own and not the shared one. */
  top: number;
  /** Where the curve ENDS, in tokens — the main conversation's own spend. */
  end: number;
}

/**
 * The row's second miniature: what this conversation has spent, over the same
 * sixteen readings the context curve is drawn through.
 *
 * ── Why this axis is NOT the fixed one ──────────────────────────────────────
 *
 * The context miniature's whole argument is a shared 0–100% axis, so two rows
 * can be compared at a glance. There is no equivalent ceiling for a bill: no
 * model, plan or window says what a session is allowed to spend, and any
 * constant picked here (10M? 100M?) would draw nine rows out of ten as a flat
 * line on the floor. So this one is fitted to its own session — exactly what
 * `SpendChart` does with the full series — and the magnitude is carried by the
 * figure beside it, which is the part that has to be read anyway. The two
 * miniatures are visibly different kinds of readout, which is the rule: a
 * curve that cannot fall, under a curve that drops every compaction.
 *
 * ── Why the total is a line and not the end of the curve ────────────────────
 *
 * `usedPts` is the main conversation. The agents' spend IS dated, but the spark
 * carries no series of it (sixteen more numbers on every row, for a curve the
 * sheet already draws), so here the gap between the curve's end and the dashed
 * line is their share — and on a fan-out session that gap is most of the
 * picture.
 */
export function spendSparkGeom(spark: ContextSpark, w: number, h: number): SpendSparkGeom | null {
  const pts = spark.usedPts;
  if (!pts || !pts.length) return null;
  const end = pts[pts.length - 1];
  // A curve that never left the floor is not a measurement of a cheap session;
  // it is a backend that records no output tokens. Absent, never a flat line.
  if (!(end > 0)) return null;
  // The host's own total, and only when it CONTAINS the curve — a total below
  // the line drawn over it would render as a reference under the last point,
  // i.e. a chart contradicting itself. Same guard as `spendFacts`.
  const total = spark.usageTok != null && spark.usageTok >= end ? spark.usageTok : null;
  // Drawn only where it says something the curve does not: with no agents the
  // total IS the end of the curve, and a dashed line lying on the end dot reads
  // as a threshold nobody set.
  const apart = total != null && spark.agentTok != null && spark.agentTok > 0 ? total : null;
  const top = Math.max(end, apart ?? 0, 1);
  // Half a pixel of headroom at each edge, so the 1.5 px line at the very top
  // and the baseline at the very bottom are both fully drawn.
  const px = (i: number) => (pts.length === 1 ? w : (i / (pts.length - 1)) * w);
  const py = (v: number) => (h - 0.5) - (Math.max(0, Math.min(v, top)) / top) * (h - 1);
  const line = polyline(pts, (_v, i) => px(i), (v) => py(v));
  return {
    line,
    // `L`, not a bare splice — see `areaPath`.
    area: closedArea(line, "0", f1(px(pts.length - 1)), h),
    endX: px(pts.length - 1),
    endY: py(end),
    totalY: apart != null ? py(apart) : null,
    top,
    end,
  };
}

/**
 * What the spend miniature says when there is nowhere to draw it — the row's
 * title text, and the only place its axis is named.
 *
 * A row is scanned, not studied, so the whole readout goes here: what the
 * conversation itself has spent, what its agents added, and what the top of the
 * box stands for. The last clause is not decoration: a curve at half height
 * means nothing until you know whether the top is 400k or forty million, and
 * unlike the context miniature this axis is not shared with the row above it.
 */
export function spendSparkTitle(spark: ContextSpark, g: SpendSparkGeom): string {
  const agents = spark.agentTok != null && spark.agentTok > 0 ? spark.agentTok : null;
  return [
    `spent: ${fmtTokens(g.end)} in this conversation so far`,
    agents != null ? `${fmtTokens(agents)} more in its subagents — the dashed line` : null,
    // The chip beside this curve is MONEY, so the tokens it used to print live
    // here — and so does the sentence that keeps a dollar figure from being
    // read as a bill. `costText` is the one wording, shared with the sheet.
    spark.costUsd != null
      ? costText(spark.costUsd, spark.agentCostUsd ?? null, spark.unpricedTok ?? null)
      : null,
    `this curve tops out at ${fmtTokens(g.top)} and is scaled to this session, not to the others`,
  ].filter(Boolean).join(" · ");
}
