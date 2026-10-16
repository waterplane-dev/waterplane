// Cut from schedule.ts (move only): describing a rule
// The one door stays `./schedule.js`; this slice imports its siblings directly, never the barrel.

import { DAY_LABELS, anchorPeriodId, anchorWindow, type ScheduleRule } from "./schedrule.js";
import { describeHours } from "./schedzone.js";

/**
 * **The name somebody TYPED, as opposed to a slice of their own prompt.**
 *
 * Nothing on this wire has a field for "is this a name or a derivation". Both
 * ends fill the name slot the same way when no name was given: the host writes
 * `action.text.split("\n")[0].slice(0, 120)` into `title` (`scheduleToIntent`)
 * and back out into `ScheduleEntry.name` (`intentToSchedule`); `Backlog.add()`
 * does the same at 40. So the overwhelming majority of names are a TRUNCATION of
 * the text rendered two lines below them, and rendering both put one string on
 * the card twice — cut once by the slice and again by CSS ellipsis, the header
 * being the less useful of the two truncations. "already fi" over the sentence
 * it was cut out of is not a title.
 *
 * The comparison is symmetric because either side may be the shorter one: the
 * text starts with the name (the ordinary case), or the name starts with the
 * text's own leading slice (a prompt shorter than `sliceLen`, where the slice
 * took the whole first line and a multi-line prompt makes `t` the longer
 * string). A name that survives both is a name.
 *
 * The empty-text guard is not a nicety: a build or a capture has no prose at
 * all, and `n.startsWith("".slice(0, 120))` is vacuously true, so without it
 * every such name would be reported as a truncation of nothing and no row would
 * have a title left.
 *
 * `sliceLen` defaults to the host's 120; the backlog passes its own 40.
 */
export function typedName(name: string | null | undefined, text: string, sliceLen = 120): string | null {
  const n = (name ?? "").trim();
  if (!n) return null;
  const t = (text ?? "").trim();
  if (!t) return n;
  if (t.startsWith(n) || n.startsWith(t.slice(0, sliceLen))) return null;
  return n;
}

/** "2h", "45m", "1h 30m" — a lead/lag time in the smallest honest words. */
export function fmtOffset(min: number): string {
  const abs = Math.abs(min);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  if (h && m) return `${h}h ${m}m`;
  if (h) return `${h}h`;
  return `${m}m`;
}

/** Anchor wall clock as "HH:MM". */
function hhmm(rule: ScheduleRule): string {
  return `${String(rule.hour ?? 0).padStart(2, "0")}:${String(rule.minute ?? 0).padStart(2, "0")}`;
}

/**
 * One line describing WHEN, in the terms the user set it: the anchor, its zone,
 * and the lead time as a separate clause. Deliberately not the resolved fire
 * clock — "16:00" hides the fact that the schedule is tracking an 18:00 reset,
 * which is the thing that has to be edited when the reset moves.
 */
export function describeRule(rule: ScheduleRule): string {
  const off = rule.offsetMin ?? 0;
  const lead = off < 0 ? `, ${fmtOffset(off)} before` : off > 0 ? `, ${fmtOffset(off)} after` : "";
  // The run window is a clause on EVERY kind, because it is a policy over the
  // anchor rather than a part of one — and it goes last, after the anchor and
  // its lead time, so the line still opens with the thing the rule tracks.
  const only = describeHours(rule);
  const hours = only ? `, only ${only}` : "";
  if (rule.kind === "once") {
    const at = rule.at ?? 0;
    const when = new Date(at).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
    return `once · ${when}${lead}${hours}`;
  }
  // "once · " prefixes a one-shot `weekly`/`window` rule too, for the SAME
  // reason it leads the `once`-kind branch above: the schedule sheet's section
  // header is not sticky, so a card scrolled past it must say for itself
  // whether it is standing policy or a thing that happens once.
  const once = rule.oneShot === true ? "once · " : "";
  if (rule.kind === "window") {
    // Named by its ANCHOR, never by a resolved clock — the anchor is the thing
    // that moves and the thing that has to be edited when it does.
    // (wording kept local: `budget.ts`'s `periodWord` would close an import cycle through this slice)
    const pid = anchorPeriodId(rule);
    const w = pid === "weekly" ? "the weekly window" : pid === "session" ? "the session window" : pid === "rolling30d" ? "the rolling 30 days" : `the ${pid} period`;
    // Which meter the condition reads is only worth saying when it is NOT the
    // one the sentence already named: "2h before the session window resets,
    // only if 40% is left" has one window in it and needs no second noun, while
    // "right after the session window resets, only if 30% of the week is left"
    // is two windows in one line and unreadable without it.
    const guard = rule.guardWindow && rule.guardWindow !== anchorWindow(rule) ? rule.guardWindow : undefined;
    const of = guard === "weekly" ? "of the week " : guard === "session" ? "of the session window " : "";
    // An `after` edge carries a condition only when a guard lifted the
    // "nothing to test" rule — `cleanRule` drops the pct otherwise, and this
    // reads the same rule from the other side rather than trusting the field.
    // A one-shot with a condition is kept until a reset meets it, and the
    // sentence says so — "once, only if" would read as a single coin toss.
    const cond = rule.minPctLeft != null && (rule.edge !== "after" || guard)
      ? `, only if ${rule.minPctLeft}% ${of}is left${rule.oneShot === true ? " — else the next reset" : ""}` : "";
    if (rule.edge === "after") {
      return `${once}${off > 0 ? `${fmtOffset(off)} after ${w} resets` : `right after ${w} resets`}${cond}${hours}`;
    }
    return `${once}${off ? fmtOffset(off) : "0m"} before ${w} resets${cond}${hours}`;
  }
  // The KIND, said out loud, for the same reason `once` leads with "once ·":
  // "Thu · 16:00" reads as a date, and the schedule sheet's card is the one
  // place that has to distinguish standing policy from a thing that happens once
  // — its section header is not sticky, so a card scrolled past it had nothing
  // on it saying which kind it was. "every day" already did this; the day-list
  // case did not. Nothing parses this string: it also feeds the host's
  // notifications (`describeSchedule`) and `sendIntent.ts`, both prose.
  // "every" contradicts the "once · " prefix, so a one-shot weekly rule reads
  // "next" instead — same days/time/zone fields, the honest word for them.
  const cadence = rule.oneShot === true ? "next" : "every";
  const days = rule.days?.length ? `${cadence} ${rule.days.map((d) => DAY_LABELS[d] ?? "?").join(" ")}` : `${cadence} day`;
  return `${once}${days} · ${hhmm(rule)}${rule.tz ? ` ${rule.tz}` : ""}${lead}${hours}`;
}
