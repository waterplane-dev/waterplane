/**
 * Scheduled prompts: "run this sweep at a wall-clock time, once or every week".
 *
 * The motivating case is not a cron job for its own sake — it is the weekly
 * usage window. Quota that is left over when the week rolls over is quota that
 * is simply gone, so the useful instruction is "two hours BEFORE the reset, fan
 * a security review out across every repo". That shape needs three things a
 * plain timestamp doesn't have:
 *
 *  - a NAMED ZONE. The reset the user anchors on is a wall clock ("Thursday
 *    18:00 German time"), and the daemon may well run under a different TZ (a
 *    launchd service inherits whatever the login session had). Storing an epoch
 *    computed once on the phone would drift by an hour at every DST change; the
 *    zone is stored and the epoch RECOMPUTED per occurrence.
 *  - an explicit OFFSET. "Thu 18:00 minus 2h" and "Thu 16:00" fire at the same
 *    instant, but they do not mean the same thing: the anchor is the fact the
 *    user knows (when the window rolls), the lead time is the policy. Keeping
 *    them apart means a shifted reset is a one-field edit, and the row can say
 *    what it is actually tracking.
 *  - a GRACE. The host is a desktop that sleeps. A fire time that passed while
 *    the machine was shut is normally still worth running (the point was to burn
 *    the week's remainder, and an hour late still burns it) — but not days late.
 *
 * The host does NOT try to discover the reset instant on its own. It cannot:
 * the weekly limit banner prints a bare time with no date (see host/limit.ts),
 * which is exactly why `SessionLimit.resetAt` is nulled for weekly blocks. A
 * guessed anchor that is a day out would fire the sweep into the wrong week, so
 * the anchor is the user's to state.
 *
 * This module is pure and node-runnable (like queue.ts) so the host, the web
 * client and the e2e script all compute the same next-fire instant.
 */

// The one door. The code lives in `./schedule/` (a slice per subject, listed below);
// importers keep saying `./schedule.js`. docs/notes/shared-architecture.md.

export {
  DEFAULT_GRACE_MIN,
  DAY_LABELS,
  ruleAnchor,
  ruleRecurs,
  composeRule,
  windowResetAt,
  windowPct,
  windowCondition,
} from "./schedule/schedrule.js";
export type {
  ScheduleRule,
  RuleAnchor,
  WindowResets,
} from "./schedule/schedrule.js";
export {
  INTENT_MAX_STEPS,
} from "./schedule/schedaction.js";
export type {
  ScheduleAction,
  ScheduleResult,
  ScheduleEntry,
} from "./schedule/schedaction.js";
export {
  zoneOffsetMs,
  wallClockToEpoch,
  inHours,
  hoursOpenFrom,
  describeHours,
  hoursZone,
} from "./schedule/schedzone.js";
export {
  nextFireAt,
  isSpentOnce,
  isStandingSchedule,
  SPENT_ONCE_TEXT,
} from "./schedule/schedfire.js";
export {
  typedName,
  fmtOffset,
  describeRule,
} from "./schedule/schedtext.js";
export {
  cleanRule,
  cleanAction,
} from "./schedule/schedclean.js";
export {
  HORIZON_LABEL,
  horizonBucket,
  scheduleHorizon,
  horizonLead,
  horizonWords,
} from "./schedule/schedhorizon.js";
export type {
  ScheduleHorizon,
  HorizonBucket,
} from "./schedule/schedhorizon.js";
export {
  fmtWhen,
  inWords,
  afterWords,
  whenWords,
} from "./schedule/schedwhen.js";
export type {
  WhenShape,
} from "./schedule/schedwhen.js";
