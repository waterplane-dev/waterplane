/**
 * The per-session budget's CALIBRATOR: what one point of each rate-limit window
 * costs in dollars, so a budget set in window percent can be judged against
 * the session's own dollars (`shared/sessionbudget.ts`, `sessions/budgetwatch.ts`).
 *
 * Off each `/usage` reading (main.ts's usage callback, beside
 * `publishBudget()`), ONE `windowSeries` over the token ledger with two grids:
 * each window from its opening (`resetAt − 5 h | 7 d`) up to the reading's own
 * `checkedAt`. Its cost, divided by the percentage the screen showed at that
 * instant, is the figure — the same rule as the phone's weekly calibration
 * (`weekUsdPerPct`, R-usage-018), for both windows. The ledger buckets by HOUR,
 * so the 5-hour figure is up to an hour wide; the phone words it "≈".
 *
 * **Never spawns a scrape.** It reads whatever reading arrived; keeping a
 * reading arriving while a percent budget exists is `syncUsagePolling`'s job.
 * Cached on `checkedAt`: a reading already calibrated is not folded twice, and
 * a failure keeps the previous figure (it goes stale on its own, and stale is
 * `unknown`, which never trips).
 */
import type { SessionBudgetCal, TokenWindowsDoc, UsageInfo } from "@waterplane/shared";
import { sessionBudgetCal } from "@waterplane/shared";

export const SESSION_WINDOW_MS = 5 * 3_600_000;
export const WEEK_WINDOW_MS = 7 * 24 * 3_600_000;

type WindowSpec = { id: string; anchor: number; lenMs: number };

/** The two grids for one reading: each window from its opening up to the
 *  reading. A window with no reset instant, or one already past, has none. */
export function calSpecs(u: UsageInfo): WindowSpec[] {
  const out: WindowSpec[] = [];
  const add = (id: string, resetAt: number | null, len: number) => {
    if (resetAt == null || !(resetAt > u.checkedAt)) return;
    const lenMs = u.checkedAt - (resetAt - len);
    if (lenMs > 0 && lenMs <= len) out.push({ id, anchor: u.checkedAt, lenMs });
  };
  add("session", u.sessionResetAt, SESSION_WINDOW_MS);
  add("weekly", u.weeklyResetAt, WEEK_WINDOW_MS);
  return out;
}

/** The newest cell's priced total per grid, null where there is none. */
export function calCosts(doc: TokenWindowsDoc): { session: number | null; weekly: number | null } {
  const of = (id: string) => {
    const w = doc.series.find((s) => s.id === id)?.windows.find((c) => c.back === 0);
    return w ? w.cost.total : null;
  };
  return { session: of("session"), weekly: of("weekly") };
}

export interface CalibratorDeps {
  windowSeries(specs: WindowSpec[], maxAgeMs?: number): Promise<TokenWindowsDoc>;
  /** Where a NEW figure goes — `sessions.setBudgetCal`. */
  apply(cal: SessionBudgetCal | null): void;
  now?: () => number;
}

/**
 * `calibrate(u)`: fold the ledger for one reading and hand the result on, once
 * per `checkedAt`. Resolves with whether a new figure was applied.
 */
export function createBudgetCalibrator(deps: CalibratorDeps): (u: UsageInfo | null | undefined) => Promise<boolean> {
  let lastKey = 0;
  let last: SessionBudgetCal | null = null;
  return async (u) => {
    if (!u?.ok || !u.checkedAt || u.checkedAt === lastKey) return false;
    const specs = calSpecs(u);
    let costs: { session: number | null; weekly: number | null } = { session: null, weekly: null };
    if (specs.length) {
      try { costs = calCosts(await deps.windowSeries(specs, 60_000)); } catch { return false; }
    }
    lastKey = u.checkedAt;
    const cal = sessionBudgetCal(u, costs, (deps.now ?? Date.now)());
    if (JSON.stringify(cal) === JSON.stringify(last)) return false;
    last = cal;
    applied = cal;
    deps.apply(cal);
    return true;
  };
}

let applied: SessionBudgetCal | null = null;
/** The calibration last handed on (null = none yet) — a peer job's `weekPct` is priced off it (`peers/serve.ts`). */
export function lastBudgetCal(): SessionBudgetCal | null { return applied; }
