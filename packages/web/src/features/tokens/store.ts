/**
 * The desktop's `/usage` reading — the two rate-limit windows, as the host last
 * scraped them. ONE writer: this feature's `usage.status` handler.
 *
 * Only the reading lives here. The usage BUDGET (`budget.state`) stays in App:
 * its handler flushes the send queue when the gate lifts, and the queue is App's.
 */
import type { BillingStatus, UsageInfo, UsageReading, UsageSourceId } from "@waterplane/shared";
import { core, createStore, useCore, useStore } from "../../sdk";
import { usageFace, weekCalKey, type UsageFace } from "./logic";

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

/** Which billing profile the desktop reports (`billing.status`); null until it does. ONE writer: that handler. */
export const billing = createStore<BillingStatus | null>(null);

/**
 * One reading per usage SOURCE that has something to say (claude, copilot, a
 * plugin's own) — `usage.status`'s `readings`, or claude's derived from `usage`
 * when the host is older. ONE writer: this feature's `usage.status` handler
 * (cleared by `welcome`). `usage` above stays the claude scrape the decisions read.
 */
export const readings = createStore<UsageReading[]>([]);

export const useUsageReadings = (): UsageReading[] => useStore(readings);

/**
 * Which source the token statistics should open on — set by a tap on a chip
 * segment, read and cleared by the token-stats sheet. Null = no filter: the
 * sheet opens as it always has. Writers: `openTokensOn` and `clearTokensOn`.
 */
export const tokensOpenOn = createStore<UsageSourceId | null>(null);

export const useTokensOpenOn = (): UsageSourceId | null => useStore(tokensOpenOn);

/** Snapshot reads for `core().world` (App re-renders with every `usage.status`, so a getter there is fresh). */
export const readingsNow = (): UsageReading[] => readings.get();
export const tokensOpenOnNow = (): UsageSourceId | null => tokensOpenOn.get();

/** A tap on a usage segment: remember the source (null = nothing to filter), then open the screen. */
export function openTokensOn(source: UsageSourceId | null): void {
  tokensOpenOn.set(source);
  core().nav.open("tokens");
}

/** The sheet's `all` button, and its close. */
export const clearTokensOn = (): void => tokensOpenOn.set(null);

export const useBilling =(): BillingStatus | null => useStore(billing);

/** What the launcher and session chips draw (`usageFace`): the budget and its periods are the queue's, read through the core. */
export function useUsageFace(): UsageFace {
  const status = useStore(billing);
  const budget = useCore().world.budget;
  return usageFace(status, budget, Date.now());
}
