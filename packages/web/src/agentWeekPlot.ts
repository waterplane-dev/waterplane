/**
 * The agent readings' weekly bars, as geometry (`AgentWeekBars.tsx` paints it).
 *
 * One column per week the host answered, oldest first, so every chart in the
 * region shares the same x and a tap on any of them picks the same week. A bar
 * is a STACK of non-negative parts in palette order, bottom first, accumulated
 * in value space; its top edge is the week's total. The y axis is zero-based
 * (these are magnitudes) and its top is `yScale`'s last tick, printed.
 *
 * A week whose reading was not taken is `null` and draws NO bar — the painter
 * marks the slot as an outline, never a zero-height bar: "nobody measured this"
 * and "it was zero" must not look alike.
 */
import { yScale } from "./kit/chart/chartScale.ts";

export interface WeekCol { x: number; w: number; cx: number; parts: { y: number; h: number; slot: number }[] | null; total: number | null }

export interface WeekBarsGeom { cols: WeekCol[]; top: number; ticks: number[]; base: number }

/**
 * `values[i]` is week i's parts (each ≥ 0) or null. `plotW`/`plotH` the inner
 * box; `left`/`top` its offset in the svg.
 */
export function weekBars(values: readonly (readonly number[] | null)[], plotW: number, plotH: number, left: number, topPad: number, want = 3): WeekBarsGeom {
  const totals = values.map((v) => (v ? v.reduce((a, b) => a + Math.max(0, b), 0) : null));
  const peak = Math.max(0, ...totals.map((t) => t ?? 0));
  // Ratios (compactions per session) are not counts: yScale floors its step
  // at 1, so a small peak is scaled up and back down.
  const k = peak > 0 && peak < 5 ? 100 : 1;
  const sc = yScale(peak * k, want);
  const top = sc.top / k, ticks = sc.ticks.map((t) => t / k);
  const n = Math.max(1, values.length);
  const slotW = plotW / n;
  const w = Math.max(2, Math.min(28, slotW * 0.62));
  const base = topPad + plotH;
  const cols = values.map((v, i) => {
    const cx = left + slotW * (i + 0.5);
    if (!v) return { x: cx - w / 2, w, cx, parts: null, total: null };
    let acc = 0;
    const parts = v.map((p, slot) => {
      const a = Math.max(0, p);
      const y0 = base - (acc / top) * plotH;
      acc += a;
      const y1 = base - (acc / top) * plotH;
      return { y: y1, h: y0 - y1, slot };
    }).filter((p) => p.h > 0);
    return { x: cx - w / 2, w, cx, parts, total: totals[i] ?? null };
  });
  return { cols, top, ticks, base };
}

/** Which column an x pixel falls in (clamped), so the whole slot is the tap target, not the thin bar. */
export function colAt(x: number, left: number, plotW: number, n: number): number {
  if (n <= 0) return -1;
  return Math.max(0, Math.min(n - 1, Math.floor(((x - left) / plotW) * n)));
}

/** The x labels: first, last and the picked week, never two overlapping (min `gap` px apart). */
export function labelCols(n: number, picked: number, cx: (i: number) => number, gap: number): number[] {
  const want = [...new Set([0, n - 1, picked].filter((i) => i >= 0 && i < n))].sort((a, b) => a - b);
  const out: number[] = [];
  // The picked one wins a collision: it is the one the readout names.
  for (const i of [picked, ...want.filter((i) => i !== picked)]) {
    if (i < 0 || i >= n) continue;
    if (out.every((j) => Math.abs(cx(i) - cx(j)) >= gap)) out.push(i);
  }
  return out.sort((a, b) => a - b);
}
