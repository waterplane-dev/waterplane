/**
 * The limit windows' history: segments, burn rate, outlook, ticks, the crosshair pick.
 *
 * Moved out of `statsPlot.ts` unchanged (docs/notes/charts-architecture.md); that file is the
 * facade that re-exports every module in `stats/`.
 */

import { nearestByTime } from "../chartScale.ts";
import { DAY_MS, type DayPoint, HOUR_MS } from "./splotDay.ts";

// ── the limit windows' history ────────────────────────────────────────────

export interface UsagePoint {
  t: number;
  v: number;
  /** The reset instant this reading named, so the crosshair can say WHICH
   *  window a past point belongs to rather than only when it was taken. */
  r: number | null;
}
export interface UsageSegment {
  pts: UsagePoint[];
  /** Whether this segment begins a NEW window — i.e. the reading before it
   *  named a different reset instant. The first segment never does. */
  rolled: boolean;
}

/**
 * How far two scraped reset instants may sit apart and still be ONE window.
 *
 * The instant is read off a TUI that prints a wall-clock minute ("resets
 * 10:59"), and the CLI recomputes that minute as the window slides, so the
 * SAME window is scraped as 10:59 and then 11:00 minutes later. Compared for
 * equality, every one of those flips was a rollover: the line was cut and a
 * dashed rule drawn at a window that never ended, which put dozens of breaks
 * into a 24-hour strip and made the marks unreadable — a mark that fires on
 * noise teaches a reader to ignore it.
 *
 * Three minutes is far above the jitter (one minute of rounding, plus the
 * scrape's own age) and far below a real rollover, which moves the instant by
 * five hours or by a week. Comparing at minute granularity would not do: the
 * jitter straddles the boundary it would round to.
 */
export const RESET_EPS_MS = 3 * 60_000;

/** Whether two scraped reset instants describe the same window. Unknown on
 *  either side ⇒ unknown, never "different": a reading whose reset the screen
 *  did not print is not evidence that the window changed. */
export function sameWindow(a: number | null, b: number | null): boolean {
  if (a == null || b == null) return true;
  return Math.abs(a - b) <= RESET_EPS_MS;
}

/**
 * A fall in the figure this big is a NEW window, whatever the reset said.
 *
 * The reset instant alone cannot see every rollover: the reading taken at the
 * moment a window rolls is `0%` with no reset named at all (there is no window
 * in force to name), so the instants either side of it are only ever compared
 * against an unknown — and an unknown must not be read as a change. That left
 * a five-hour window climbing to 7% and returning to 0% drawn as ONE line,
 * which is the cliff this whole file exists to refuse: usage does not come
 * back.
 *
 * So the second signal is the arithmetic one, and it needs no reset at all:
 * inside one window the count only ever goes up. Two points of slack because
 * the figure is an integer percentage off a screen that can correct itself by
 * one — anything past that is a window that ended.
 */
export const DROP_EPS_PCT = 2;

/**
 * The kept readings, cut into polylines that may honestly be drawn as lines.
 *
 * Two cuts, and both of them are the same rule: **only join two readings when
 * something connects them.**
 *
 *  - **A window rollover.** The 5-hour figure climbs and then drops to near
 *    zero when its window rolls. Joined, that draws a cliff which reads as
 *    usage being refunded — a thing that does not happen. The reset instant the
 *    screen named travels with each reading precisely so the drop can be
 *    attributed, so a change in it cuts the line and the chart draws the break —
 *    a change past `RESET_EPS_MS`, never a bare `!==`, because the scraped
 *    minute jitters by one while the window it names stands still.
 *  - **A gap in the observations.** Readings are taken when something asks for
 *    one, not on a feed, so a stretch where nobody looked is ordinary. A line
 *    across it is a claim about hours nobody measured; past `maxGapMs` the
 *    series is cut and the hole is left visible.
 *
 * Readings whose value is null for the window being drawn are DROPPED rather
 * than zeroed — the screen not printing a figure is not the figure being zero.
 * A dropped reading still breaks the line if it leaves too big a hole, which
 * falls out of the gap rule rather than needing one of its own.
 */
export function usageSegments(
  samples: { t: number; s: number | null; w: number | null; sr: number | null; wr: number | null }[],
  which: "session" | "week",
  maxGapMs = 45 * 60_000,
): UsageSegment[] {
  const val = (r: { s: number | null; w: number | null }) => (which === "session" ? r.s : r.w);
  const reset = (r: { sr: number | null; wr: number | null }) => (which === "session" ? r.sr : r.wr);
  const out: UsageSegment[] = [];
  let cur: UsageSegment | null = null;
  let prev: (typeof samples)[number] | null = null;
  let prevV: number | null = null;
  // The reset instant the segment being drawn belongs to — the last one that
  // was actually PRINTED inside it, not the previous reading's, which is null
  // for exactly the reading a rollover happens on.
  let winReset: number | null = null;
  for (const r of samples) {
    const v = val(r);
    if (v == null) continue;
    const res = reset(r);
    const moved = winReset != null && res != null && !sameWindow(winReset, res);
    const fell = prevV != null && v < prevV - DROP_EPS_PCT;
    const rolled = !!prev && (moved || fell);
    const stale = !!prev && r.t - prev.t > maxGapMs;
    if (!cur || rolled || stale) {
      cur = { pts: [], rolled };
      out.push(cur);
      // A new segment forgets the old window's instant rather than carrying it
      // into the comparison for the next reading, which would cut the line a
      // second time at the first reading that finally names the new one.
      winReset = res;
    } else if (winReset == null) {
      winReset = res;
    }
    cur.pts.push({ t: r.t, v, r: res });
    prev = r;
    prevV = v;
  }
  return out;
}

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
 */
export function usageMarksText(segs: UsageSegment[]): string | null {
  const rolls = segs.filter((s) => s.rolled).length;
  const holes = segs.length - 1 - rolls;
  const parts: string[] = [];
  if (holes > 0) {
    parts.push("a break in the line is a stretch nobody took a reading in");
  }
  if (rolls > 0) {
    parts.push("a dashed rule is where the window rolled over and the count started again");
  }
  if (!parts.length) return null;
  const s = parts.join("; ");
  return s.charAt(0).toUpperCase() + s.slice(1) + ".";
}

/** Hours as points on the shared time axis — the intraday series. */
export function hourPoints<T extends { hour: string }>(
  rows: T[],
  value: (r: T) => number,
  toMs: (hour: string) => number,
): DayPoint[] {
  return rows.map((r) => ({ t: toMs(r.hour), day: r.hour, v: value(r) }));
}
