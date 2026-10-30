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
import type { SessionBudgetCal, TokenWindowsDoc, UsageInfo, UsageWindow } from "@waterplane/shared";
import { sessionBudgetCal, undatedSince, undatedWhy, windowStartHour } from "@waterplane/shared";

export const SESSION_WINDOW_MS = 5 * 3_600_000;
export const WEEK_WINDOW_MS = 7 * 24 * 3_600_000;

type WindowSpec = { id: string; anchor: number; lenMs: number };

/**
 * How long a ROLLING window is, read off its chip unit (`UsageWindow.unit`): `5h`, `1d`, `wk`,
 * `<n>h`/`<n>d`. A calendar unit (`mo`) has no fixed length — its opening is a date, not
 * `resetAt − len` — and an unknown unit is not guessed: both null, so the window gets no grid.
 */
export function windowLenMs(unit: string): number | null {
  if (unit === "wk") return WEEK_WINDOW_MS;
  const m = /^(\d{1,2})([hd])$/.exec(unit);
  if (!m) return null;
  const n = Number(m[1]);
  return n > 0 ? n * (m[2] === "h" ? 3_600_000 : 24 * 3_600_000) : null;
}

/**
 * One grid per window of a reading taken at `checkedAt`: each from its opening up to the reading,
 * under the window's own id. A window with no reset instant, one already past, or no fixed
 * length (`windowLenMs`) has none — absent, never a guessed opening.
 */
export function calSpecsOf(checkedAt: number, windows: readonly Pick<UsageWindow, "id" | "unit" | "resetAt">[]): WindowSpec[] {
  const out: WindowSpec[] = [];
  for (const w of windows) {
    const len = windowLenMs(w.unit);
    if (len == null || w.resetAt == null || !(w.resetAt > checkedAt)) continue;
    const lenMs = checkedAt - (w.resetAt - len);
    if (lenMs > 0 && lenMs <= len) out.push({ id: w.id, anchor: checkedAt, lenMs });
  }
  return out;
}

/** claude's two grids — its `/usage` windows through `calSpecsOf`, under the ids `calCosts`
 *  reads (`session`, `weekly`). Byte-identical to the pre-windows rule (sessionbudget.test.mjs). */
export function calSpecs(u: UsageInfo): WindowSpec[] {
  return calSpecsOf(u.checkedAt, [
    { id: "session", unit: "5h", resetAt: u.sessionResetAt },
    { id: "weekly", unit: "wk", resetAt: u.weeklyResetAt },
  ]);
}

/** The newest cell's priced total per grid, null where there is none. */
export function calCosts(doc: TokenWindowsDoc): { session: number | null; weekly: number | null; sessionUndated?: number; weeklyUndated?: number } {
  const out: { session: number | null; weekly: number | null; sessionUndated?: number; weeklyUndated?: number } = { session: null, weekly: null };
  for (const id of ["session", "weekly"] as const) {
    const s = doc.series.find((x) => x.id === id);
    // Records in no hour that could fall in THIS window (their log written since it opened)
    // fold it short: no figure, never a floor — and the count rides along so the budget's
    // sentence names that cause. Older logs cannot hold one of its records.
    const undated = s ? undatedSince(doc, windowStartHour(s.anchor - s.lenMs)) : undefined;
    if (undatedWhy(undated)) {
      if (typeof undated === "number" && undated > 0) out[id === "session" ? "sessionUndated" : "weeklyUndated"] = undated;
      continue;
    }
    const w = s?.windows.find((c) => c.back === 0);
    out[id] = w ? w.cost.total : null;
  }
  return out;
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
