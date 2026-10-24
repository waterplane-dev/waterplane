/**
 * The schedule sheet's WEEK BAR, as geometry — pure, so `node --test` runs it.
 *
 * "Schedule against your weekly window" is a claim nobody can check from a list
 * of rules: "3h before the weekly window resets" is a sentence about an instant
 * the reader cannot see. This draws the next seven days with the two usage
 * windows on them — how much of each is used, and where each resets — and a
 * pin wherever a rule on the sheet fires next.
 *
 * **It computes no edge of its own.** Every fire instant is the HOST's
 * `ScheduleEntry.nextAt` (the same `nextFireAt` the tick arms with), and every
 * reset is the one usage reading, read through `windowResetAt` — the function
 * `nextFireAt` itself anchors on. A window that has not been read is ABSENT
 * (null), never placed at a guess, and a later session window is never
 * extrapolated: it opens whenever the next prompt is sent, which no clock knows.
 */
import { ruleAnchor, windowResetAt, type ScheduleEntry, type ScheduleRule, type WindowResets } from "@waterplane/shared";

export const WEEK_MS = 7 * 24 * 3600e3;
export const SESSION_MS = 5 * 3600e3;

export interface BarWindow {
  which: "session" | "weekly";
  /** 0..100 used, or null when the reading carried no percentage. */
  pct: number | null;
  resetAt: number;
  /** Where the reset lands on the bar, 0..1. Always on the bar: both resets
   *  are inside the next seven days by construction (a week is the longest). */
  x: number;
}

export interface BarFire {
  id: string;
  at: number;
  x: number;
  /** 1-based, soonest first — the pin's label, matched in the list under it. */
  n: number;
  /** Which reset this fire is anchored to; null for a wall-clock rule. */
  anchor: "session" | "weekly" | null;
  /** 0-based row the pin is drawn on, so two close pins do not cover each other. */
  lane: number;
}

export interface WeekBar {
  from: number;
  to: number;
  /** Local midnights inside the span, with their x. */
  days: { t: number; x: number }[];
  session: BarWindow | null;
  weekly: BarWindow | null;
  fires: BarFire[];
  /** Armed rules whose next fire is past the seven days — named, not drawn. */
  later: { id: string; at: number }[];
  /** Window-anchored rules with no next fire because the window was never read. */
  unread: string[];
  lanes: number;
}

/** The window a `window` rule tracks (`undefined` is the session one, as in shared). */
export function anchorOf(rule: ScheduleRule): "session" | "weekly" | null {
  return ruleAnchor(rule) === "window" ? (rule.window === "weekly" ? "weekly" : "session") : null;
}

function windowOf(which: "session" | "weekly", u: WindowResets | null | undefined, now: number, from: number, span: number): BarWindow | null {
  const resetAt = windowResetAt({ kind: "window", window: which }, u ?? undefined);
  // A reset already behind us is a reading of the PREVIOUS window — the
  // usage-cut refusal's case. Absent, not drawn at the left edge.
  if (resetAt == null || resetAt <= now || resetAt > from + span) return null;
  const raw = which === "weekly" ? u?.weeklyPct : u?.sessionPct;
  return { which, pct: typeof raw === "number" && Number.isFinite(raw) ? raw : null, resetAt, x: (resetAt - from) / span };
}

/**
 * @param entries the rules the sheet shows (its cut, so the bar is a picture
 *   of the cards under it, filter and all)
 * @param minGap the smallest x distance two pins on one lane may have, as a
 *   fraction of the bar — the caller's fact, since it depends on the width
 */
export function weekBar(entries: readonly ScheduleEntry[], usage: WindowResets | null | undefined, now: number, minGap = 0.07): WeekBar {
  const from = Math.floor(now / 60_000) * 60_000; // positions on a minute grid: a week bar cannot draw a minute, and the render gate needs them fixed
  const to = from + WEEK_MS;
  const span = to - from;
  const days: { t: number; x: number }[] = [];
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  for (d.setDate(d.getDate() + 1); d.getTime() < to; d.setDate(d.getDate() + 1)) days.push({ t: d.getTime(), x: (d.getTime() - from) / span });

  const armed = entries
    .filter((e) => e.enabled !== false && typeof e.nextAt === "number" && e.nextAt > now)
    .sort((a, b) => (a.nextAt as number) - (b.nextAt as number));
  const fires: BarFire[] = [];
  const later: { id: string; at: number }[] = [];
  const laneEnd: number[] = [];
  for (const e of armed) {
    const at = e.nextAt as number;
    if (at > to) { later.push({ id: e.id, at }); continue; }
    const x = (at - from) / span;
    let lane = laneEnd.findIndex((end) => x - end >= minGap);
    if (lane < 0) { lane = laneEnd.length; laneEnd.push(x); } else laneEnd[lane] = x;
    fires.push({ id: e.id, at, x, n: fires.length + 1, anchor: anchorOf(e.rule), lane });
  }
  const unread = entries
    .filter((e) => e.enabled !== false && e.rule.kind === "window" && e.nextAt == null
      && windowResetAt(e.rule, usage ?? undefined) == null)
    .map((e) => e.id);
  return {
    from, to, days,
    session: windowOf("session", usage, now, from, span),
    weekly: windowOf("weekly", usage, now, from, span),
    fires, later, unread, lanes: Math.max(1, laneEnd.length),
  };
}

/** How a fire relates to its anchor, in words — e.g. "3h before the weekly reset". */
export function anchorWords(f: BarFire, bar: WeekBar): string {
  if (!f.anchor) return "on the clock";
  const w = f.anchor === "weekly" ? bar.weekly : bar.session;
  const name = f.anchor === "weekly" ? "the weekly reset" : "the session reset";
  if (!w) return `anchored to ${name}`;
  const d = f.at - w.resetAt;
  if (Math.abs(d) < 60e3) return `at ${name}`;
  const mins = Math.round(Math.abs(d) / 60e3);
  const span = mins >= 60 ? `${Math.floor(mins / 60)}h${mins % 60 ? ` ${mins % 60}m` : ""}` : `${mins}m`;
  return `${span} ${d < 0 ? "before" : "after"} ${name}`;
}
