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
 * A backend that keeps no claude log (a plugin: Copilot, Codex, opencode) is
 * judged from its OWN figures instead — `TokenSource.session(s)`, published
 * as `SessionInfo.sourceSpend` and read through `sourceSpendSpark`. Tokens
 * and dollars only where its CLI STATES them (`unstated` otherwise — nothing
 * here prices another backend's tokens), and a percent never: the 5-hour and
 * weekly windows are claude's account, which that session does not spend
 * from (`notClaude`). A unit of its own (Copilot's AI credits) is not a budget
 * unit — it is carried on the wire, never converted, never summed.
 *
 * Pure, and the clock arrives as an argument. Calibration is the host's
 * (`host/src/sessionbudget.ts` feeds window costs in); both ends read the
 * result off `SessionInfo.budget`.
 */
import type { ContextSpark, SessionInfo } from "./wire/session.js";
import type { UsageInfo } from "./wire/telemetry.js";
import type { SourceSessionSpend } from "./backendsources.js";
import { sourceSpendProblems } from "./sourceshape.js";
import { BUDGET_STALE_MS } from "./budget.js";
import { weekUsdPerPct } from "./sessioncost.js";
import { fmtUsd } from "./pricing.js";
import { fmtCount } from "./tokens.js";

/** `native`: the backend's own unit (Copilot's AI credits), named by `SessionBudget.nativeUnit` —
 *  never converted to tokens or dollars, never summed with another unit. */
export type SessionBudgetUnit = "tok" | "usd" | "sessionPct" | "weeklyPct" | "native";

/** The longest native unit label a cap keeps (`BackendInfo.caps.spendUnit`'s own cap). */
export const SESSION_BUDGET_NATIVE_UNIT_MAX = 32;

export interface SessionBudget {
  unit: SessionBudgetUnit;
  /** In `unit`; finite and > 0 (a percent is also <= 100). */
  max: number;
  /** Write Esc once into the running turn when the cap is hit. Absent on the
   *  wire means true — `cleanSessionBudget` always writes it out. */
  interrupt: boolean;
  /** The HARD variant (absent = soft, today's default): while over, a send a
   *  person makes on the phone asks first ("send anyway?"), and EVERY turn
   *  that person did not confirm gets one Esc — not just the crossing's. Implies
   *  `interrupt`. Absent on the wire means soft; `cleanSessionBudget` writes it
   *  only when true. */
  hard?: true;
  /** The native unit's label as the person saw it when typing (`"AI credits"`). Present iff
   *  `unit === "native"`; a reading in any other unit is `unstated`, never compared. */
  nativeUnit?: string;
}

/** Why a verdict cannot say. Present iff `state === "unknown"`. */
export type SessionBudgetUnknown = "noSpark" | "unpriced" | "noReading" | "stale" | "noCalibration" | "notRunning"
  /** A backend's own source did not state the spend in this unit (tokens, dollars). */
  | "unstated"
  /** A percent, on a session whose backend does not spend from claude's windows. */
  | "notClaude";

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
  /** The cap's `nativeUnit`, carried so the sentence and the chip can name it. */
  nativeUnit?: string;
}

export interface SessionBudgetInfo {
  cfg: SessionBudget;
  verdict: SessionBudgetVerdict;
  cal?: SessionBudgetCal;
}

/** Least dollars a window must hold before dollars-per-point is believed. */
export const SESSION_BUDGET_CAL_MIN_USD = 1;

const UNITS: readonly SessionBudgetUnit[] = ["tok", "usd", "sessionPct", "weeklyPct", "native"];
const isPct = (u: SessionBudgetUnit) => u === "sessionPct" || u === "weeklyPct";

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
  let native: { nativeUnit: string } | Record<string, never> = {};
  if (unit === "native") {
    const label = typeof r.nativeUnit === "string" ? r.nativeUnit.trim() : "";
    if (!label || label.length > SESSION_BUDGET_NATIVE_UNIT_MAX) return null;
    native = { nativeUnit: label };
  }
  // Hard always interrupts: "Esc every turn" with interrupting off is no cap.
  if (r.hard === true) return { unit, max, interrupt: true, hard: true, ...native };
  return { unit, max, interrupt: r.interrupt !== false, ...native };
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

/** What `sessionSpend` reads off a `ContextSpark` — or off a backend's own
 *  source (`sourceSpendSpark`), which says so with `source: true`. */
export type SessionBudgetSpark = Pick<ContextSpark, "usageTok" | "agentTok" | "costUsd" | "agentCostUsd"> & {
  /** The figures are the backend's own `tokens.session` reading, not claude's
   *  log: a figure it did not state is `unstated` (never `unpriced` — nothing
   *  prices another backend's tokens), and a percent is `notClaude`. */
  source?: true;
  /** The source's native-unit reading (`SourceSessionSpend.native`), vetted with the rest. */
  native?: { amount: number; unit: string; agentAmount?: number };
};

/**
 * A backend's own reading (`SessionInfo.sourceSpend`) as the spend a budget is
 * judged from. **Claude's `usageTok` HOLDS its agents' share; a source's `tok`
 * does NOT** (`tok` is the session's own turns, `agentTok` its subagents'), so
 * the total is their sum and `agentTok` rides apart as the split — a missing
 * `agentTok` leaves the total a FLOOR, which is what claude's is too. A reading
 * `sourceSpendProblems` refuses is dropped WHOLE: the result is then a spark
 * with no figures, which reads `unstated`. `native` rides as itself — a
 * `native` cap reads it, nothing converts it into tokens or dollars.
 */
export function sourceSpendSpark(r: SourceSessionSpend | null | undefined): SessionBudgetSpark {
  const out: SessionBudgetSpark = { source: true };
  if (!r || sourceSpendProblems(r).length) return out;
  if (r.tok != null) {
    out.usageTok = r.tok + (r.agentTok ?? 0);
    if (r.agentTok != null) out.agentTok = r.agentTok;
  }
  if (r.usd != null) {
    out.costUsd = r.usd + (r.agentUsd ?? 0);
    if (r.agentUsd != null) out.agentCostUsd = r.agentUsd;
  }
  if (r.native) out.native = { amount: r.native.amount, unit: r.native.unit, ...(r.native.agentAmount != null ? { agentAmount: r.native.agentAmount } : {}) };
  return out;
}

/** The spend a session's budget is read from, on either end: the backend's own
 *  source where the host says it judges from one (`sourceSpend` present), else
 *  claude's log (`contextSpark`). One predicate, so the phone's "spent so far"
 *  and the host's verdict cannot read two different numbers. */
export function budgetSparkOf(s: Pick<SessionInfo, "contextSpark" | "sourceSpend">): SessionBudgetSpark | null {
  return s.sourceSpend ? sourceSpendSpark(s.sourceSpend) : s.contextSpark ?? null;
}

/** The session's spend in a budget's unit, with its subagent share. `value`
 *  null means unknown, and `why` says why. */
export function sessionSpend(
  unit: SessionBudgetUnit,
  spark: SessionBudgetSpark | null | undefined,
  cal: SessionBudgetCal | null | undefined,
  now: number,
  nativeUnit?: string,
): { value: number | null; agent: number | null; why?: SessionBudgetUnknown } {
  const unknown = (why: SessionBudgetUnknown) => ({ value: null, agent: null, why });
  if (!spark) return unknown("noSpark");
  if (unit === "native") {
    // The unit must be the one the person capped in, by name — a different unit is not a smaller number.
    const n = spark.native;
    if (!n || !nativeUnit || n.unit.trim() !== nativeUnit) return unknown("unstated");
    return { value: n.amount + (n.agentAmount ?? 0), agent: n.agentAmount ?? null };
  }
  if (spark.source && isPct(unit)) return unknown("notClaude");
  if (unit === "tok") {
    if (spark.usageTok == null) return unknown(spark.source ? "unstated" : "noSpark");
    return { value: spark.usageTok, agent: spark.agentTok ?? null };
  }
  if (spark.costUsd == null) return unknown(spark.source ? "unstated" : "unpriced");
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
  const s = sessionSpend(cfg.unit, spark, cal, now, cfg.nativeUnit);
  const base = { unit: cfg.unit, max: cfg.max, spent: s.value, agentShare: s.agent, ...(cfg.nativeUnit ? { nativeUnit: cfg.nativeUnit } : {}) };
  if (s.value == null) return { ...base, state: "unknown", why: s.why };
  if (!running) return { ...base, state: "unknown", why: "notRunning" };
  return { ...base, state: s.value >= cfg.max ? "over" : "ok" };
}

/** The ONE predicate for "this session's sends are held by its budget" — the
 *  phone's queue and the host's intent facts both ask it. */
export function sessionBudgetHeld(s: Pick<SessionInfo, "budget">): boolean {
  return s.budget?.verdict.state === "over";
}

function fmtPct(n: number): string {
  return n < 10 ? n.toFixed(1).replace(/\.0$/, "") : String(Math.round(n));
}

/** A native amount: as stated, at most one decimal — never a "≈", nothing was converted. */
function fmtNative(n: number): string {
  return Number.isInteger(n) ? fmtCount(n) : String(Math.round(n * 10) / 10);
}

/** One figure in a unit. A percent is a calibrated estimate, so it says "≈". */
function fmtIn(unit: SessionBudgetUnit, n: number, nativeUnit?: string): string {
  switch (unit) {
    case "tok": return `${fmtCount(n)} tokens`;
    case "usd": return fmtUsd(n);
    case "native": return `${fmtNative(n)} ${nativeUnit ?? "of the backend's own unit"}`;
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
    case "native": return `≤ ${fmtIn("native", cfg.max, cfg.nativeUnit)}`;
  }
}

/** Why a verdict cannot say, as a sentence that ends on what it means for the
 *  person: nothing is held. `readingAgeMs` sharpens the stale case, `unit` the
 *  `unstated` one. */
export function sessionBudgetUnknownText(why: SessionBudgetUnknown, readingAgeMs?: number, unit?: SessionBudgetUnit, nativeUnit?: string): string {
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
    case "unstated":
      return `can't tell: this session's backend has not stated what it spent${unit === "tok" ? " in tokens" : unit === "usd" ? " in dollars" : unit === "native" ? ` in ${nativeUnit ?? "its own unit"}` : ""}${tail}`;
    case "notClaude": return `can't tell: ${SESSION_BUDGET_WINDOWS_CLAUDE}, which this session's backend does not spend from${tail}`;
  }
}

/** Why a percent of a window is claude's only — the host's `notClaude` verdict
 *  and the phone's unit picker say it in these words. */
export const SESSION_BUDGET_WINDOWS_CLAUDE = "the 5-hour and weekly windows are claude's account";

/** The unit picker's sentence where it offers no percent: `label` is the
 *  session's backend as the phone names it. */
export function sessionBudgetWindowsOffText(label: string): string {
  return `No ≈% of a window here: ${SESSION_BUDGET_WINDOWS_CLAUDE}, and ${label} does not spend from it.`;
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
  if (v.state === "unknown" || v.spent == null) return sessionBudgetUnknownText(v.why ?? "noSpark", undefined, v.unit, v.nativeUnit);
  const share = v.agentShare != null && v.agentShare > 0 ? `, ${fmtIn(v.unit, v.agentShare, v.nativeUnit)} of it in subagents` : "";
  const cap = isPct(v.unit) ? fmtIn(v.unit, v.max).replace("≈", "") : fmtIn(v.unit, v.max, v.nativeUnit);
  const caveat = isPct(v.unit) ? ` (${SESSION_BUDGET_PCT_CAVEAT})` : "";
  return `${fmtIn(v.unit, v.spent, v.nativeUnit)} so far${share} — ${v.state === "over" ? "over" : "within"} the ${cap} budget${caveat}`;
}

/** What being over DOES, by mode — one sentence for the host's notification
 *  and the phone's sheet and chip, so the two cannot describe the cap apart. */
export function sessionBudgetHoldText(cfg: Pick<SessionBudget, "hard">): string {
  return cfg.hard
    ? "Hard budget: queued and scheduled sends to this session are held, a send you make yourself asks you first, and every turn you did not send yourself is stopped with one Esc — until you raise or clear the budget."
    : "Sends to this session are held until you raise or clear the budget — an explicit send, an answer to a question and an upload still go.";
}

/** `$0.52 / $0.50` — spend over cap, `?` where the spend is unknown. */
export function sessionBudgetChip(v: SessionBudgetVerdict): string {
  const f = (n: number) => {
    switch (v.unit) {
      case "tok": return fmtCount(n);
      case "usd": return fmtUsd(n);
      case "native": return fmtNative(n);
      default: return `${isPct(v.unit) ? "≈" : ""}${fmtPct(n)}%`;
    }
  };
  const tail = v.unit === "native" && v.nativeUnit ? ` ${v.nativeUnit}` : "";
  return `${v.spent == null ? "?" : f(v.spent)} / ${isPct(v.unit) ? f(v.max).replace("≈", "") : f(v.max)}${tail}`;
}
