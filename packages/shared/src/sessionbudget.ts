/**
 * A budget for ONE session — what it may spend, subagents included, before the
 * host holds its sends and (optionally) interrupts the running turn.
 *
 * Not `budget.ts`, which is the ACCOUNT's ceiling and is untouched: that one
 * pauses automatic work everywhere when a window is nearly spent, this one is a
 * cap a person put on one conversation. They share the stale-reading rule
 * (`BUDGET_STALE_MS`) and the dollars-per-percent calibration
 * (`weekUsdPerPct`) and nothing else.
 *
 * Spend is the session's OWN total — `ContextSpark.usageTok`/`costUsd`, the
 * numbers the reply footer already prints, subagents inside them — compared as
 * a total, never a delta. A percent unit is those dollars converted at the
 * window's measured dollars-per-point, so it is an estimate and is worded "≈".
 *
 * **Unknown never trips.** A stale or missing reading, a window too young to
 * calibrate, an unpriced model: every one is a verdict of `unknown` with the
 * reason, and `sessionBudgetHeld` is false for it. A wrong "over" stops work a
 * person asked for; a missing one costs only the cap not yet biting.
 *
 * Pure, and the clock arrives as an argument. Calibration is the host's
 * (`host/src/sessionbudget.ts` feeds window costs in); both ends read the
 * result off `SessionInfo.budget`.
 */
import type { ContextSpark, SessionInfo } from "./wire/session.js";
import type { UsageInfo } from "./wire/telemetry.js";
import { BUDGET_STALE_MS } from "./budget.js";
import { weekUsdPerPct } from "./sessioncost.js";
import { fmtUsd } from "./pricing.js";
import { fmtCount } from "./tokens.js";

export type SessionBudgetUnit = "tok" | "usd" | "sessionPct" | "weeklyPct";

export interface SessionBudget {
  unit: SessionBudgetUnit;
  /** In `unit`; finite and > 0 (a percent is also <= 100). */
  max: number;
  /** Write Esc once into the running turn when the cap is hit. Absent on the
   *  wire means true — `cleanSessionBudget` always writes it out. */
  interrupt: boolean;
}

/** Why a verdict cannot say. Present iff `state === "unknown"`. */
export type SessionBudgetUnknown = "noSpark" | "unpriced" | "noReading" | "stale" | "noCalibration" | "notRunning";

/** Host-computed dollars per window point, riding `SessionInfo.budget`. */
export interface SessionBudgetCal {
  /** The `/usage` reading it was taken from. */
  checkedAt: number;
  sessionUsdPerPct: number | null;
  weeklyUsdPerPct: number | null;
}

export interface SessionBudgetVerdict {
  state: "ok" | "over" | "unknown";
  unit: SessionBudgetUnit;
  max: number;
  /** In the budget's unit; null when unknown. */
  spent: number | null;
  /** The subagent share of `spent`, same unit — no total prints without its split. */
  agentShare?: number | null;
  why?: SessionBudgetUnknown;
}

export interface SessionBudgetInfo {
  cfg: SessionBudget;
  verdict: SessionBudgetVerdict;
  cal?: SessionBudgetCal;
}

/** Least dollars a window must hold before dollars-per-point is believed. */
export const SESSION_BUDGET_CAL_MIN_USD = 1;

const UNITS: readonly SessionBudgetUnit[] = ["tok", "usd", "sessionPct", "weeklyPct"];

/** A budget off the wire or out of a file, or null. Garbage is refused whole —
 *  a cap that was rounded into something the person never typed is worse than
 *  none, because it would hold their work for a number they did not choose. */
export function cleanSessionBudget(raw: unknown): SessionBudget | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.unit !== "string" || !UNITS.includes(r.unit as SessionBudgetUnit)) return null;
  const unit = r.unit as SessionBudgetUnit;
  const max = r.max;
  if (typeof max !== "number" || !Number.isFinite(max) || !(max > 0)) return null;
  if ((unit === "sessionPct" || unit === "weeklyPct") && max > 100) return null;
  return { unit, max, interrupt: r.interrupt !== false };
}

/** Dollars per window point: `weekUsdPerPct`'s rule for either window, with a
 *  floor on the money so a window that has barely run calibrates nothing. */
export function windowUsdPerPct(windowCostUsd: number | null | undefined, pct: number | null | undefined): number | null {
  if (windowCostUsd == null || !(windowCostUsd >= SESSION_BUDGET_CAL_MIN_USD)) return null;
  return weekUsdPerPct(windowCostUsd, pct);
}

/**
 * The calibration off one `/usage` reading and what the logs priced in each
 * window up to it. Null when the reading is unusable (not ok, no stamp, older
 * than `BUDGET_STALE_MS`) or both resets are known and passed; otherwise a
 * window that cannot be calibrated is null on its own.
 */
export function sessionBudgetCal(
  u: UsageInfo | null | undefined,
  costs: { session: number | null | undefined; weekly: number | null | undefined },
  now: number,
): SessionBudgetCal | null {
  if (!u || !u.ok || !u.checkedAt || now - u.checkedAt > BUDGET_STALE_MS) return null;
  const gone = (at: number | null) => at != null && at <= now;
  if (gone(u.sessionResetAt) && gone(u.weeklyResetAt)) return null;
  return {
    checkedAt: u.checkedAt,
    sessionUsdPerPct: gone(u.sessionResetAt) ? null : windowUsdPerPct(costs.session, u.sessionPct),
    weeklyUsdPerPct: gone(u.weeklyResetAt) ? null : windowUsdPerPct(costs.weekly, u.weeklyPct),
  };
}

/** What `sessionSpend` reads off a `ContextSpark`. */
export type SessionBudgetSpark = Pick<ContextSpark, "usageTok" | "agentTok" | "costUsd" | "agentCostUsd">;

/** The session's spend in a budget's unit, with its subagent share. `value`
 *  null means unknown, and `why` says why. */
export function sessionSpend(
  unit: SessionBudgetUnit,
  spark: SessionBudgetSpark | null | undefined,
  cal: SessionBudgetCal | null | undefined,
  now: number,
): { value: number | null; agent: number | null; why?: SessionBudgetUnknown } {
  const unknown = (why: SessionBudgetUnknown) => ({ value: null, agent: null, why });
  if (!spark) return unknown("noSpark");
  if (unit === "tok") {
    if (spark.usageTok == null) return unknown("noSpark");
    return { value: spark.usageTok, agent: spark.agentTok ?? null };
  }
  if (spark.costUsd == null) return unknown("unpriced");
  if (unit === "usd") return { value: spark.costUsd, agent: spark.agentCostUsd ?? null };
  if (!cal) return unknown("noReading");
  if (now - cal.checkedAt > BUDGET_STALE_MS) return unknown("stale");
  const per = unit === "sessionPct" ? cal.sessionUsdPerPct : cal.weeklyUsdPerPct;
  if (per == null || !(per > 0)) return unknown("noCalibration");
  return { value: spark.costUsd / per, agent: spark.agentCostUsd != null ? spark.agentCostUsd / per : null };
}

/** The verdict. `over` iff the spend is KNOWN and at or past the cap; a session
 *  that is not running is unknown (`notRunning`) whatever it spent. */
export function sessionBudgetVerdict(
  cfg: SessionBudget,
  spark: SessionBudgetSpark | null | undefined,
  cal: SessionBudgetCal | null | undefined,
  now: number,
  running = true,
): SessionBudgetVerdict {
  const s = sessionSpend(cfg.unit, spark, cal, now);
  const base = { unit: cfg.unit, max: cfg.max, spent: s.value, agentShare: s.agent };
  if (s.value == null) return { ...base, state: "unknown", why: s.why };
  if (!running) return { ...base, state: "unknown", why: "notRunning" };
  return { ...base, state: s.value >= cfg.max ? "over" : "ok" };
}

/** The ONE predicate for "this session's sends are held by its budget" — the
 *  phone's queue and the host's intent facts both ask it. */
export function sessionBudgetHeld(s: Pick<SessionInfo, "budget">): boolean {
  return s.budget?.verdict.state === "over";
}

const isPct = (u: SessionBudgetUnit) => u === "sessionPct" || u === "weeklyPct";

function fmtPct(n: number): string {
  return n < 10 ? n.toFixed(1).replace(/\.0$/, "") : String(Math.round(n));
}

/** One figure in a unit. A percent is a calibrated estimate, so it says "≈". */
function fmtIn(unit: SessionBudgetUnit, n: number): string {
  switch (unit) {
    case "tok": return `${fmtCount(n)} tokens`;
    case "usd": return fmtUsd(n);
    default: return `≈${fmtPct(n)}% of ${unit === "sessionPct" ? "the 5-hour window" : "the week"}`;
  }
}

/** The cap as the person typed it, short: `≤ $2.00`, `≤ 2% of this 5-hour window`. */
export function sessionBudgetLabel(cfg: SessionBudget): string {
  switch (cfg.unit) {
    case "tok": return `≤ ${fmtCount(cfg.max)} tokens`;
    case "usd": return `≤ ${fmtUsd(cfg.max)}`;
    case "sessionPct": return `≤ ${fmtPct(cfg.max)}% of this 5-hour window`;
    case "weeklyPct": return `≤ ${fmtPct(cfg.max)}% of this week`;
  }
}

/** Why a verdict cannot say, as a sentence that ends on what it means for the
 *  person: nothing is held. `readingAgeMs` sharpens the stale case. */
export function sessionBudgetUnknownText(why: SessionBudgetUnknown, readingAgeMs?: number): string {
  const tail = " — nothing is held";
  switch (why) {
    case "noSpark": return `can't tell: this session has not logged a turn yet${tail}`;
    case "unpriced": return `can't tell: no list price covers this session's model${tail}`;
    case "noReading": return `can't tell: there is no usage reading to convert dollars into window percent${tail}`;
    case "stale":
      return readingAgeMs != null && readingAgeMs > 0
        ? `can't tell: the usage reading is ${Math.round(readingAgeMs / 60_000)} min old${tail}`
        : `can't tell: the usage reading is too old${tail}`;
    case "noCalibration": return `can't tell: this window has not run enough here to say what one percent costs${tail}`;
    case "notRunning": return `can't tell: the session is not running${tail}`;
  }
}

/**
 * What a percent figure is made of, said wherever one is printed: the dollars
 * per point are THIS desktop's spend over the ACCOUNT's percent, so anything
 * else spending from the account (another machine, claude.ai) inflates the
 * percent and lowers the dollars per point — a session's percent reads HIGH,
 * and a percent budget trips early. Direction stated, never a correction.
 */
export const SESSION_BUDGET_PCT_CAVEAT = "≈, from this desktop's spend — other use of the account makes it read high";

/** The verdict in a sentence: spend, its subagent share, and where it stands. */
export function sessionBudgetText(v: SessionBudgetVerdict): string {
  if (v.state === "unknown" || v.spent == null) return sessionBudgetUnknownText(v.why ?? "noSpark");
  const share = v.agentShare != null && v.agentShare > 0 ? `, ${fmtIn(v.unit, v.agentShare)} of it in subagents` : "";
  const cap = isPct(v.unit) ? fmtIn(v.unit, v.max).replace("≈", "") : fmtIn(v.unit, v.max);
  const caveat = isPct(v.unit) ? ` (${SESSION_BUDGET_PCT_CAVEAT})` : "";
  return `${fmtIn(v.unit, v.spent)} so far${share} — ${v.state === "over" ? "over" : "within"} the ${cap} budget${caveat}`;
}

/** `$0.52 / $0.50` — spend over cap, `?` where the spend is unknown. */
export function sessionBudgetChip(v: SessionBudgetVerdict): string {
  const f = (n: number) => {
    switch (v.unit) {
      case "tok": return fmtCount(n);
      case "usd": return fmtUsd(n);
      default: return `${isPct(v.unit) ? "≈" : ""}${fmtPct(n)}%`;
    }
  };
  return `${v.spent == null ? "?" : f(v.spent)} / ${isPct(v.unit) ? f(v.max).replace("≈", "") : f(v.max)}`;
}
