/**
 * The limit windows' history: segments, burn rate, outlook, ticks, the crosshair pick.
 *
 * Moved out of `statsPlot.ts` unchanged (docs/notes/charts-architecture.md); that file is the
 * facade that re-exports every module in `stats/`.
 */

import { nearestByTime } from "../chartScale.ts";
import type { UsagePoint, UsageSegment } from "@waterplane/shared";
import { DAY_MS, type DayPoint, HOUR_MS } from "./splotDay.ts";

// ── the limit windows' history ────────────────────────────────────────────

// The segment rule — `UsagePoint`, `UsageSegment`, `RESET_EPS_MS`, `sameWindow`,
// `DROP_EPS_PCT`, `usageSegments` — moved to `@waterplane/shared` (`burn.ts`) so the
// host's burn watcher and this chart cut the readings by ONE rule. Re-exported
// here so the facade's surface is unchanged.
export {
  DROP_EPS_PCT, RESET_EPS_MS, sameWindow, usageSegments, type UsagePoint, type UsageSegment,
} from "@waterplane/shared";

/**
 * How fast the window in force is filling, in percent per hour — or null.
 *
 * Null rather than a number whenever the answer would be made up, which is most
 * of the time this is asked: fewer than two readings inside the CURRENT window,
 * less than `minSpanMs` between the first and last of them, or a span in which
 * the figure went down (a window that rolled mid-span, or a screen that
 * corrected itself). A burn rate is the one reading on this screen somebody
 * would plan around, so it degrades to absent exactly like every other
 * heuristic here.
 *
 * Measured inside the current window only — the readings before the last
 * rollover are a different window's fill and averaging across them answers
 * nothing.
 */
export function burnRate(
  segments: UsageSegment[],
  minSpanMs = 20 * 60_000,
): number | null {
  const last = segments[segments.length - 1];
  if (!last || last.pts.length < 2) return null;
  const a = last.pts[0];
  const b = last.pts[last.pts.length - 1];
  const span = b.t - a.t;
  if (span < minSpanMs) return null;
  const delta = b.v - a.v;
  if (delta < 0) return null;
  return (delta / span) * 3_600_000;
}

/**
 * Where this window ENDS UP, at the rate it is filling — or null.
 *
 * The projection somebody plans around, and it has two answers, not one. A
 * window that fills before its reset has a time on it. A window that does not
 * has a LEVEL on it — "on track for 28% by the reset" — and that half used to
 * be silence: `fullAt` returned null whenever the answer landed past the reset,
 * on the argument that saying "full in 117 hours" about a five-hour window
 * would alarm for no reason. True of the DATE, and it left the ordinary case —
 * the one where the honest answer is *this window sees itself out* — with
 * nothing on screen at all, which reads as a projection that could not be made.
 *
 * Same arithmetic for both branches, so neither is more of a guess than the
 * other: `rate` is the measured fill of the CURRENT window and the reset
 * instant came off the same screen as the percentage.
 *
 * Null, as everywhere else here, whenever the answer would be invented: no
 * rate, a rate of zero (nothing is being spent — "never" is not a date), a
 * window already at 100%, or a reset instant that has already passed, in which
 * case the cached percentage describes a window that has ENDED and nothing may
 * be projected from it (the rule `budget.ts` keeps for the same reading).
 */
export type UsageOutlook =
  /** Reaches 100% at `at`, before the window resets. */
  | { kind: "full"; at: number }
  /** Resets first, at about `pctAtReset` percent. */
  | { kind: "lasts"; pctAtReset: number; resetAt: number };

export function usageOutlook(
  pct: number | null,
  rate: number | null,
  resetAt: number | null,
  now: number,
): UsageOutlook | null {
  if (pct == null || rate == null || rate <= 0 || pct >= 100) return null;
  const at = now + ((100 - pct) / rate) * 3_600_000;
  if (resetAt == null) return { kind: "full", at };
  // A reading whose reset is in the past is a reading about a dead window.
  if (resetAt <= now) return null;
  if (at < resetAt) return { kind: "full", at };
  return { kind: "lasts", pctAtReset: pct + rate * ((resetAt - now) / 3_600_000), resetAt };
}

/**
 * Where to put the time labels under a limit window's strip.
 *
 * Instants, not labels: how a time is written is the caller's (and the
 * locale's) business, and the same instant is written two ways on this screen
 * already. Steps come off a ladder of ones a person reads without doing
 * arithmetic — a tick every 37 minutes is a scale nobody can use — and are
 * aligned to LOCAL midnight rather than to the epoch, so "18:00" is a label
 * and not "18:30" in a half-hour timezone.
 *
 * `want` is how many labels the caller has room for, and is a maximum: a
 * strip narrow enough for two gets two, never four overlapping ones.
 */
export function timeTicks(t0: number, t1: number, want = 4): number[] {
  const span = t1 - t0;
  if (!(span > 0) || want < 2) return [];
  const LADDER = [
    5 * 60_000, 15 * 60_000, 30 * 60_000, HOUR_MS, 2 * HOUR_MS, 3 * HOUR_MS,
    6 * HOUR_MS, 12 * HOUR_MS, DAY_MS, 2 * DAY_MS, 7 * DAY_MS,
  ];
  const step = LADDER.find((s) => span / s <= want) ?? LADDER[LADDER.length - 1];
  const origin = new Date(t0);
  origin.setHours(0, 0, 0, 0);
  const out: number[] = [];
  for (let t = origin.getTime(); t <= t1; t += step) if (t >= t0) out.push(t);
  return out;
}

/**
 * The span a limit window's chart covers, as instants.
 *
 * The five-hour chart looks back a day: that is four whole windows of it, and
 * the comparison it answers is between them. The WEEK chart is the week — the
 * window the reset closes, from `reset − 7d` to the reset itself — because a
 * day-wide strip of a seven-day window is a flat line at whatever the week
 * already stood at, which answers nothing about how the week was spent. The
 * part after `now` is room the window still has, drawn empty rather than
 * clipped, so where the line stops says how far through the week you are.
 *
 * With no reset instant (or one already past, which describes a window that
 * has ended) the week falls back to the last seven days ending now, and the
 * caller says so: it is a span, not the window.
 */
export function usageSpan(
  which: "session" | "week",
  reset: number | null,
  now: number,
  dayHours = 24,
): { t0: number; t1: number; isWindow: boolean } {
  if (which === "session") return { t0: now - dayHours * HOUR_MS, t1: now, isWindow: false };
  if (reset != null && reset > now) return { t0: reset - 7 * DAY_MS, t1: reset, isWindow: true };
  return { t0: now - 7 * DAY_MS, t1: now, isWindow: false };
}

/**
 * The reading nearest an instant, across every segment — the crosshair's pick.
 *
 * By TIME and not by pixel, for `nearestDay`'s reason: the answer must not
 * change when the phone rotates. Null only when there is nothing drawn.
 */
export function nearestUsage(segs: UsageSegment[], t: number): UsagePoint | null {
  return nearestByTime(segs.flatMap((s) => s.pts), t, (p) => p.t);
}

/**
 * What the marks in the strip MEAN, named only where they are drawn.
 *
 * The complaint this answers was "I don't know what the gaps mean", and the
 * honest fix is a caption rather than a legend of every mark the component can
 * draw: a sentence about a dashed rule on a chart that has none sends a reader
 * hunting for it. Null when the line is unbroken and there is nothing to
 * explain.
 *
 * `{lead, more}`, the context sheet's split: a BREAK is a stretch nobody read —
 * an absence, said in the open under the chart (`lead`) — while the dashed
 * rule is how a rollover is drawn, method that folds behind a `?` (`more`).
 * Each is null where its mark is not drawn.
 */
export function usageMarksText(segs: UsageSegment[]): { lead: string | null; more: string | null } | null {
  const rolls = segs.filter((s) => s.rolled).length;
  const holes = segs.length - 1 - rolls;
  if (holes <= 0 && rolls <= 0) return null;
  return {
    lead: holes > 0 ? "A break in the line is a stretch nobody took a reading in." : null,
    more: rolls > 0 ? "A dashed rule is where the window rolled over and the count started again." : null,
  };
}

/** Hours as points on the shared time axis — the intraday series. */
export function hourPoints<T extends { hour: string }>(
  rows: T[],
  value: (r: T) => number,
  toMs: (hour: string) => number,
): DayPoint[] {
  return rows.map((r) => ({ t: toMs(r.hour), day: r.hour, v: value(r) }));
}
