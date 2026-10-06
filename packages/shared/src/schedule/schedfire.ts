// Cut from schedule.ts (move only): the next fire instant
// The one door stays `./schedule.js`; this slice imports its siblings directly, never the barrel.

import { ruleRecurs, windowResetAt, type ScheduleRule, type WindowResets } from "./schedrule.js";
import { wallClockToEpoch, zoneDate } from "./schedzone.js";

/**
 * The next instant this rule fires, strictly after `after`. Null when it never
 * will again (a `once` whose time has passed).
 *
 * The weekly search walks CANDIDATE ANCHOR DAYS, not fire days: with a negative
 * offset the fire lands on the previous evening (or the previous day entirely,
 * for a big lead time), so the window starts two days back — otherwise
 * "Monday 01:00 minus 3h" would skip the Sunday-evening fire that is due
 * tonight. Every candidate is resolved through the zone afresh, which is what
 * keeps a DST weekend from moving the sweep an hour.
 */
export function nextFireAt(rule: ScheduleRule, after: number, resets?: WindowResets): number | null {
  const offsetMs = (rule.offsetMin ?? 0) * 60_000;
  if (rule.kind === "window") {
    // The anchor is a fact the host reads off the CLI, not a clock this module
    // can compute. Unknown ⇒ NOT ARMED (`null`), which the tick re-asks on
    // every pass — so a rule stays visibly un-armed until the first usage
    // scrape lands, rather than being placed at a guessed instant that then
    // moves under it.
    const reset = windowResetAt(rule, resets);
    if (reset == null) return null;
    // `after` fires AT the reset; `before` fires `offsetMin` (negative) ahead
    // of it. Both add the offset, which is why one field covers both edges.
    const at = reset + (rule.edge === "after" ? Math.max(0, offsetMs) : offsetMs);
    return at > after ? at : null;
  }
  if (rule.kind === "once") {
    const at = (rule.at ?? 0) + offsetMs;
    return at > after ? at : null;
  }
  const hour = rule.hour ?? 0;
  const minute = rule.minute ?? 0;
  const tz = rule.tz || null;
  const days = rule.days?.length ? rule.days : null;
  const today = zoneDate(tz, after);
  for (let k = -2; k <= 9; k++) {
    // Date.UTC normalises the day roll (month/year ends) for us.
    const dow = new Date(Date.UTC(today.y, today.mo, today.d + k)).getUTCDay();
    if (days && !days.includes(dow)) continue;
    const fire = wallClockToEpoch(today.y, today.mo, today.d + k, hour, minute, tz) + offsetMs;
    if (fire > after) return fire;
  }
  return null;
}

/**
 * A ONE-OFF whose instant is behind us — spent, as opposed to switched off.
 *
 * The two are one field on the wire: `intentToSchedule` derives `enabled` from
 * `nextAt !== null` because an intent has no second flag, so `enabled === false`
 * covers both "somebody disarmed this" and "this was a `once` and its moment has
 * passed". Only the first can be undone, and every screen that offered *switch
 * it on* for the second offered a tap that cannot do anything: re-arming asks
 * `nextFireAt` again, which answers null again, and nothing changes — a button
 * that reports success and moves nothing.
 *
 * The CLOCK decides, not the result: a one-off that never fired (the host was
 * asleep past its grace) is exactly as unre-armable as one that ran.
 *
 * A `weekly`- or `window`-anchored one-shot cannot be asked the same way a
 * `once` is: `nextFireAt` does not know about `oneShot` at all (it is a
 * recurrence question and arming is an anchor question), so it always finds a
 * future weekly slot and a `window` rule is never "past its instant" — there
 * is no clock to be behind. The only honest evidence such a rule is OVER is
 * that it already fired (`lastOccurrence`); short of that it is either armed
 * (`nextAt` set) or waiting to be (a `window` rule with no reading yet), and
 * either way it is not spent.
 */
export function isSpentOnce(
  e: { rule: ScheduleRule; nextAt?: number | null; lastOccurrence?: number; enabled?: boolean },
  now: number,
): boolean {
  if (ruleRecurs(e.rule)) return false;
  if (e.nextAt != null) return false;
  if (e.rule.kind === "once") return nextFireAt(e.rule, now) === null;
  // A one-shot SKIPPED on its condition is kept for the next reset with its
  // next instant not read yet: `nextAt` UNDEFINED on an intent, and on a
  // `ScheduleEntry` (whose wire field collapses that to null) still `enabled`,
  // which the host derives from `nextAt !== null`. Only an explicit null — the
  // host retiring the row — is spent.
  if (e.nextAt === undefined || e.enabled === true) return false;
  return e.lastOccurrence != null;
}

/**
 * **Is this row still a SCHEDULE, or is it history?**
 *
 * A schedule list is a list of things that are going to happen. A one-off whose
 * instant has passed is not one of them and never will be again: it is an
 * account of a prompt that ran (or did not), which is exactly what Activity
 * holds, one row for its whole life. Ten of them sitting in Schedules under a
 * chip reading "10 not armed" said the opposite of what had happened — nothing
 * was waiting to be armed, everything had already been spent — and the only
 * verb the sheet could offer on them was *post it again*.
 *
 * So this is the cut, and it feeds BOTH the launcher's count and the sheet's
 * list, for the reason every other count here does: a number is a promise that
 * a list somewhere holds exactly those rows.
 *
 * A row with no `rule` (the horizon's callers may carry only an instant) is
 * never spent — the absence of a rule is not evidence that it is over.
 */
export function isStandingSchedule(
  e: { rule?: ScheduleRule; nextAt?: number | null; lastOccurrence?: number; enabled?: boolean },
  now: number,
): boolean {
  return !e.rule || !isSpentOnce({ rule: e.rule, nextAt: e.nextAt, lastOccurrence: e.lastOccurrence, enabled: e.enabled }, now);
}

/**
 * What every surface says about a spent one-off, in ONE place.
 *
 * The schedule sheet and Activity each wrote their own, and they disagreed on
 * the one thing that matters: whether *now* still works. It does — the host
 * revives the row in place and fires it (`IntentManager.runNow`), and a
 * schedule missed while the desktop slept is precisely the one you want to fire
 * by hand. Activity refused it with a sentence saying so.
 */
export const SPENT_ONCE_TEXT = "that instant has passed and a one-off cannot be re-armed — run it now, edit it, or post it again";
