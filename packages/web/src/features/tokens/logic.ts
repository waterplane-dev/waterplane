/**
 * The pure half of the week-share calibration (`actions.ts`'s `calibrateWeek`).
 */
import { WEEK_CAL_MIN_PCT, type UsageInfo } from "@waterplane/shared";

export const WEEK_MS = 7 * 86_400_000;
const HOUR_MS = 3_600_000;

/**
 * The identity of a `/usage` reading a week share can be calibrated off, or
 * null: no weekly figure, one too small to divide by (`WEEK_CAL_MIN_PCT`), a
 * window that has rolled (the figure describes a week that is over), or a week
 * under an hour old. A new scrape is a new key and nothing else is.
 */
export function weekCalKey(u: UsageInfo | null, now: number): string | null {
  if (!u || u.weeklyPct == null || u.weeklyResetAt == null) return null;
  if (u.weeklyPct < WEEK_CAL_MIN_PCT) return null;
  if (u.weeklyResetAt <= now) return null;
  if (u.checkedAt - (u.weeklyResetAt - WEEK_MS) < HOUR_MS) return null;
  return `${u.weeklyResetAt}:${u.checkedAt}:${u.weeklyPct}`;
}
