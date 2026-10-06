/**
 * The desktop's `/usage` reading — the two rate-limit windows, as the host last
 * scraped them. ONE writer: this feature's `usage.status` handler.
 *
 * Only the reading lives here. The usage BUDGET (`budget.state`) stays in App:
 * its handler flushes the send queue when the gate lifts, and the queue is App's.
 */
import type { UsageInfo } from "@waterplane/shared";
import { createStore, useStore } from "../../sdk";
import { weekCalKey } from "./logic";

export const usage = createStore<UsageInfo | null>(null);

/** The last `/usage` reading, for App's own readers (the launcher chip, the
 *  schedule previews, the send sheet). Null until the host has said. */
export function useUsage(): UsageInfo | null {
  return useStore(usage);
}

/** Dollars per weekly percent, measured off ONE reading (`weekCalKey`).
 *  ONE writer: `actions.ts`'s `calibrateWeek`. */
export const weekRate = createStore<{ key: string; resetAt: number; usdPerPct: number; incl?: string } | null>(null);

/** How far two readings' weekly reset may differ and still be one week: the
 *  CLI prints a wall-clock minute and recomputes it, so it jitters by 60 s
 *  between scrapes; a different week is days away. */
const SAME_WEEK_MS = 3_600_000;

/**
 * `usdPerWeekPct` for the reading on hand, or null — so each turn's cost can
 * also read as a share of the weekly limit. The newest calibration serves
 * every later reading of the SAME week while its own is in flight (one every
 * scrape, so the share does not blink); one from another week is not served.
 */
export function useWeekUsdPerPct(): number | null {
  const u = useStore(usage);
  const r = useStore(weekRate);
  if (!r || !u || weekCalKey(u, Date.now()) == null) return null;
  return Math.abs(r.resetAt - u.weeklyResetAt!) < SAME_WEEK_MS ? r.usdPerPct : null;
}

/** What the served calibration counted beyond this desktop — `incl. $0.84 on pc` — or null.
 *  Served exactly when `useWeekUsdPerPct` serves the rate, so the label never outlives its number. */
export function useWeekIncl(): string | null {
  const u = useStore(usage);
  const r = useStore(weekRate);
  if (!r?.incl || !u || weekCalKey(u, Date.now()) == null) return null;
  return Math.abs(r.resetAt - u.weeklyResetAt!) < SAME_WEEK_MS ? r.incl : null;
}
