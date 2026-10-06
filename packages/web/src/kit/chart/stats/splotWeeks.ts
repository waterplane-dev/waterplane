/**
 * Calendar weeks: the week's days, totals, bounds and labels.
 *
 * Moved out of `statsPlot.ts` unchanged (docs/notes/charts-architecture.md); that file is the
 * facade that re-exports every module in `stats/`.
 */

import {
  addCost,
  addTotals,
  dayToMs,
  zeroCost,
  zeroTotals,
  type CostBreakdown,
  type TokenDay,
  type TokenTotals,
} from "@waterplane/shared";
import { DAY_MS } from "./splotDay.ts";

// ── calendar weeks ────────────────────────────────────────────────────────

/**
 * A week is a WINDOW, not a filter, and stepping through weeks is the one
 * navigation this screen was missing.
 *
 * The three range chips ("30 days", "90 days", "all time") all end at today, so
 * every one of them answers "how much lately" and none of them answers "what
 * did last week look like" — a question with an obvious shape (seven columns,
 * Monday to Sunday) that the screen could not draw at all. The rules:
 *
 *  - **Monday-based and LOCAL.** The days were bucketed in the host's local
 *    zone (`TokenDay`) and are read back in the phone's, which is the same
 *    approximation `dayToMs` already makes; a week boundary inherits it rather
 *    than inventing a second one.
 *  - **Every date walk goes through `Date#setDate`, never `+ 7 * DAY_MS`.**
 *    Adding a fixed number of milliseconds across a DST switch lands at 23:00
 *    of the previous day, and a week window that starts an hour before Monday
 *    silently swallows Sunday's last turns into the wrong week.
 *  - **A week view fills its gaps.** Everywhere else in this file a missing day
 *    is drawn as a gap, because a quiet fortnight is the fact being shown; but
 *    inside ONE week the seven columns ARE the axis, and a Wednesday that isn't
 *    there is a day off, which is a reading rather than an absence. So
 *    `weekDays` returns seven entries, zeros included, each saying whether it
 *    was `present` in the scan.
 */

/** Local midnight of the Monday on or before `t`. */
export function weekStart(t: number): number {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.getTime();
}

/** `n` weeks from a week start, forwards or back. DST-safe — see the header. */
export function shiftWeek(start: number, n: number): number {
  const d = new Date(start);
  d.setDate(d.getDate() + 7 * n);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * The ISO-8601 week number and the year that owns it.
 *
 * ISO rather than "the nth Monday": the week containing 1 January belongs to
 * whichever year holds its Thursday, so 2026-12-28 is week 1 of 2027 and
 * labelling it "week 53 of 2026" would put two different weeks under one name.
 */
export function isoWeek(t: number): { year: number; week: number } {
  const thu = thursdayOf(t);
  const year = thu.getFullYear();
  // 4 January is in ISO week 1 by definition, so the distance between the two
  // weeks' THURSDAYS is a whole number of weeks — no rounding of a day offset,
  // which is where the usual one-liner picks up its off-by-one near new year.
  const first = thursdayOf(new Date(year, 0, 4).getTime());
  return { year, week: 1 + Math.round((thu.getTime() - first.getTime()) / (7 * DAY_MS)) };
}

function thursdayOf(t: number): Date {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7));
  d.setHours(0, 0, 0, 0);
  return d;
}

/** `YYYY-MM-DD` in the LOCAL zone — the same key the host bucketed under. */
export function dayKey(t: number): string {
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export interface WeekDay {
  /** `YYYY-MM-DD`, so it keys straight into the scan's own days. */
  day: string;
  /** Local midnight, for the chart's time axis. */
  t: number;
  /** The day's totals, or a zero tally for a day the scan never saw. */
  totals: TokenTotals;
  /** The day's list-price cost, zero for a day the scan never saw. Carried
   *  rather than derived: a cost cannot be recomputed from a day's TOTALS,
   *  because the rate depends on which model ran and a day row has no model. */
  cost: CostBreakdown;
  /** Whether the scan had this day at all — a zero column that was measured
   *  and a zero column that is filled-in padding read identically otherwise. */
  present: boolean;
  /**
   * The day row the scan actually sent, when it sent one.
   *
   * Carried whole for the same reason `totals` is spread rather than listed
   * field by field: the row has grown a per-model split and a count of subagent
   * launches, and a week rebuilt out of `{totals, cost}` loses both — every day
   * of the week view would then stack as "no model ran", which is a different
   * claim from "no work happened" and looks identical.
   */
  src?: TokenDay;
}

/**
 * The seven days of the week starting at `start`, in order, gaps filled.
 *
 * `days` is the scan's ascending day list; only the seven keys are looked at,
 * so this costs one pass and no sort.
 */
export function weekDays(days: TokenDay[], start: number): WeekDay[] {
  const have = new Map(days.map((d) => [d.day, d]));
  const out: WeekDay[] = [];
  for (let i = 0; i < 7; i++) {
    const t = shiftDay(start, i);
    const key = dayKey(t);
    const row = have.get(key);
    out.push({
      day: key,
      t,
      // Spread rather than field-by-field: hand-listing the fields is how this
      // silently dropped `cacheWrite1h` the moment the shape grew, and a lost
      // field here is a week that prices itself at the cheaper cache tier.
      totals: row ? { ...zeroTotals(), ...row } : zeroTotals(),
      cost: row?.cost ?? zeroCost(),
      present: !!row,
      ...(row ? { src: row } : {}),
    });
  }
  return out;
}

function shiftDay(start: number, n: number): number {
  const d = new Date(start);
  d.setDate(d.getDate() + n);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Every day in the week folded into one tally. */
export function weekTotals(week: WeekDay[]): TokenTotals {
  return week.reduce((acc, d) => addTotals(acc, d.totals), zeroTotals());
}

/** The week's list-price cost — summed from the DAYS' own costs, which the
 *  host priced per model. Never re-derived from `weekTotals`. */
export function weekCost(week: WeekDay[]): CostBreakdown {
  return week.reduce((acc, d) => addCost(acc, d.cost), zeroCost());
}

/**
 * Which weeks the stepper may step to.
 *
 * The bound is the DATA, not the calendar: stepping past the first recorded day
 * shows an empty week for ever and reads as a broken screen rather than as the
 * end of the record. The current week is always reachable even when nothing has
 * been recorded in it yet — "nothing yet this week" is an answer.
 */
export function weekBounds(days: TokenDay[], now: number): { first: number; last: number } {
  const thisWeek = weekStart(now);
  if (!days.length) return { first: thisWeek, last: thisWeek };
  const first = weekStart(dayToMs(days[0].day));
  const last = Math.max(thisWeek, weekStart(dayToMs(days[days.length - 1].day)));
  return { first: Math.min(first, last), last };
}

/**
 * What a week is called: the ISO number, then the dates it covers.
 *
 * Both halves, deliberately. "Week 37" alone is unreadable without a calendar
 * on the desk, and "8–14 Sep" alone cannot be said out loud to anyone who
 * thinks in week numbers. The month is printed once when both ends share it.
 */
export function weekLabel(start: number): string {
  const end = shiftDay(start, 6);
  const { week } = isoWeek(start);
  const fmt = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });
  // `formatRange` collapses the shared half itself and in the reader's own
  // order — "Sep 7 – 13" in one locale, "7.–13. Sep." in another. Building the
  // range by hand printed "7 – Sep 13", which is neither. Guarded because it is
  // the one Intl method old WebViews may not carry, and a week with no name is
  // worse than an unabbreviated one.
  const span = typeof fmt.formatRange === "function"
    ? fmt.formatRange(new Date(start), new Date(end))
    : `${fmt.format(new Date(start))} – ${fmt.format(new Date(end))}`;
  const yr = new Date(end).getFullYear() === new Date().getFullYear() ? "" : ` ${new Date(end).getFullYear()}`;
  return `Week ${week} · ${span}${yr}`;
}

/** How this week compares with the one before it, as a signed fraction, or
 *  null when the previous week has nothing to compare against — a percentage
 *  change from zero is not a number, it is a division by zero with a face. */
export function weekDelta(current: number, previous: number): number | null {
  if (previous <= 0) return null;
  return (current - previous) / previous;
}
