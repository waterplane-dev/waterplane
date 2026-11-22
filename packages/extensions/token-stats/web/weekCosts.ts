/**
 * "Cost per limit week": every weekly window the hour record covers, as list-price dollars.
 *
 * The heat boxes shade the same figures but print none of them (a box's `title` is
 * invisible on a phone), so "what did each week come to" had no answer short of
 * tapping every box. Pure and node-tested; `WeekCosts.tsx` only paints.
 *
 * Reads the SAME cells the weekly grid draws (`heatGrid`), so a figure here and a
 * box there can never disagree. A cell the record does not reach (`totals: null`)
 * is left out, never drawn as $0 — the grid's outlined box says that absence.
 */
import { fmtUsd } from "@waterplane/shared";
import type { WindowCell } from "./usageCut.ts";

export type WeekCostRow = {
  back: number;
  openedAt: number;
  resetAt: number;
  usd: number;
  /** 0..1 of the dearest row's bar. */
  frac: number;
  /** The window running now: its figure is so far, not a week's. */
  running: boolean;
};

/** Newest first: the question is "how did this week and the last few go". */
export function weekCostRows(cells: WindowCell[]): WeekCostRow[] {
  const counted = cells.filter((c) => c.totals != null && c.cost != null);
  const max = counted.reduce((m, c) => Math.max(m, c.cost!.total), 0);
  return counted
    .map((c) => ({
      back: c.back,
      openedAt: c.openedAt,
      resetAt: c.resetAt,
      usd: c.cost!.total,
      frac: max > 0 ? c.cost!.total / max : 0,
      running: c.back === 0,
    }))
    .sort((a, b) => a.back - b.back);
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * The one computed sentence the chart rule asks for — a figure NO row prints, so
 * it never repeats the bars: the median finished week, and how far the running
 * week is into it. Only FINISHED weeks that ran something enter the median (an
 * idle week would drag it to nothing; the running week is a part-week). Null
 * when no finished week ran.
 */
export function weekCostTakeaway(rows: WeekCostRow[]): string | null {
  const done = rows.filter((r) => !r.running && r.usd > 0);
  if (!done.length) return null;
  const mid = median(done.map((r) => r.usd));
  const now = rows.find((r) => r.running);
  const head = done.length === 1
    ? "Only one finished week ran anything"
    : `Median of ${done.length} finished weeks: ${fmtUsd(mid)}`;
  if (!now) return `${head}.`;
  const pct = Math.round((now.usd / mid) * 100);
  return `${head}; this week so far is ${pct}% of ${done.length === 1 ? "it" : "that"}.`;
}
