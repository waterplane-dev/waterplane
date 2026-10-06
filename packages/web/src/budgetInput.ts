/**
 * What a person types into a session budget, and the sentences around it —
 * pure, so `budgetInput.test.mjs` runs it under `node --test`.
 *
 * Top-level and not inside `features/sessionBudget/` because three screens that
 * are not that feature draw the field: the Send sheet, the launch ask and the
 * context sheet's panel. A top-level module may not import a feature, so the
 * parse and the field both live here and the feature's sheet imports them.
 *
 * Every figure the verdict prints is `@waterplane/shared`'s (`sessionBudgetText`,
 * `sessionBudgetChip`, `sessionBudgetLabel`, `sessionBudgetUnknownText`) — never
 * re-worded on the phone. What is here is only what the host cannot say: how a
 * typed string becomes a cap, and what the calibration is, as a sentence.
 */
import {
  BUDGET_STALE_MS, SESSION_BUDGET_PCT_CAVEAT, fmtCount, fmtUsd, sessionBudgetLabel, sessionBudgetText, sessionBudgetUnknownText, sessionSpend,
  type SessionBudgetInfo, type SessionBudget, type SessionBudgetCal, type SessionBudgetSpark, type SessionBudgetUnit,
} from "@waterplane/shared";

/**
 * The four units, in the order the picker draws them (dollars first: it is the
 * default and the one a person reasons in). `prefix`/`suffix` sit either side
 * of the number in the field, so the box itself says what "2" means; `presets`
 * are the quick picks under it, typed exactly as a person would type them.
 */
export const BUDGET_UNITS: readonly {
  unit: SessionBudgetUnit; label: string; example: string; prefix?: string; suffix?: string; presets: readonly string[];
}[] = [
  { unit: "usd", label: "dollars", example: "2 or 0.50", prefix: "$", presets: ["1", "2", "5"] },
  { unit: "tok", label: "tokens", example: "500k or 2m", suffix: "tokens", presets: ["250k", "1m", "3m"] },
  { unit: "sessionPct", label: "% of 5h window", example: "2 or 0.5", suffix: "% of 5h", presets: ["5", "10", "25"] },
  { unit: "weeklyPct", label: "% of week", example: "5 or 0.5", suffix: "% of week", presets: ["5", "10", "25"] },
];

export const unitInfo = (u: SessionBudgetUnit) => BUDGET_UNITS.find((x) => x.unit === u) ?? BUDGET_UNITS[0];

/** A quick pick as its chip reads: `$2`, `1m`, `10%`. */
export function presetLabel(unit: SessionBudgetUnit, text: string): string {
  return unit === "usd" ? `$${text}` : isPctUnit(unit) ? `${text}%` : text;
}

export const isPctUnit = (u: SessionBudgetUnit): boolean => u === "sessionPct" || u === "weeklyPct";

export type BudgetParse = { ok: true; max: number } | { ok: false; reason: string };

/**
 * A typed cap → a number, or the SENTENCE that says why not. Never rounds into
 * something the person did not type (`cleanSessionBudget` refuses the same
 * shapes on the host, so this validates for speed, never as the gate). A blank
 * field is "no budget", which the caller reads off `text.trim() === ""` — it is
 * not a parse failure and not a zero.
 */
export function parseBudgetInput(unit: SessionBudgetUnit, text: string): BudgetParse {
  let t = text.trim().toLowerCase().replace(/\s+/g, "");
  if (!t) return { ok: false, reason: "type a number" };
  if (unit === "usd") t = t.replace(/^\$/, "").replace(/\$$/, "");
  if (isPctUnit(unit)) t = t.replace(/%$/, "");
  let mult = 1;
  if (unit === "tok") {
    const m = /^([\d.,_]+)([kmb])$/.exec(t);
    if (m) { t = m[1]; mult = m[2] === "k" ? 1e3 : m[2] === "m" ? 1e6 : 1e9; }
  }
  // `2,50` is two dollars fifty; `2,000` is two thousand. A comma followed by
  // exactly one or two digits at the end is a decimal comma, any other is a
  // thousands separator.
  t = /^\d+,\d{1,2}$/.test(t) ? t.replace(",", ".") : t.replace(/[,_]/g, "");
  if (!/^(\d+\.?\d*|\.\d+)$/.test(t)) return { ok: false, reason: `“${text.trim()}” is not a number${unit === "tok" ? " — try 500k or 2m" : ""}` };
  const max = Number(t) * mult;
  if (!Number.isFinite(max) || !(max > 0)) return { ok: false, reason: "a budget has to be more than zero — clear it to have none" };
  if (isPctUnit(unit) && max > 100) return { ok: false, reason: "a percent of a window cannot be more than 100" };
  return { ok: true, max };
}

/** The field's text for a cap already set, so editing starts from what was typed. */
export function budgetText(cfg: SessionBudget): string {
  if (cfg.unit === "tok") {
    if (cfg.max >= 1e6 && cfg.max % 1e5 === 0) return `${cfg.max / 1e6}m`;
    if (cfg.max >= 1e3 && cfg.max % 100 === 0) return `${cfg.max / 1e3}k`;
  }
  return String(cfg.max);
}

/**
 * The calibration, as the sentence a percent unit needs under its field — the
 * answer to "what is 1% worth here", or why it cannot be said (and that
 * nothing is held meanwhile). Dollars and tokens need no conversion, so they
 * get null. `cal` absent is a real state: the host sent none.
 */
export function calibrationWords(unit: SessionBudgetUnit, cal: SessionBudgetCal | null | undefined, now: number): string | null {
  if (!isPctUnit(unit)) return null;
  if (!cal) return sessionBudgetUnknownText("noReading");
  const age = now - cal.checkedAt;
  if (age > BUDGET_STALE_MS) return sessionBudgetUnknownText("stale", age);
  const per = unit === "sessionPct" ? cal.sessionUsdPerPct : cal.weeklyUsdPerPct;
  if (per == null || !(per > 0)) return sessionBudgetUnknownText("noCalibration");
  const win = unit === "sessionPct" ? "the 5-hour window" : "the week";
  const mins = Math.max(0, Math.round(age / 60_000));
  return `1% of ${win} ≈ ${fmtUsd(per)} of list-price spend, from the usage reading ${mins} min ago (${SESSION_BUDGET_PCT_CAVEAT})`;
}

function fmtPct(n: number): string {
  return n < 10 ? n.toFixed(1).replace(/\.0$/, "") : String(Math.round(n));
}

/** One amount, short — the figure a preview line compares: `$0.48`, `1.2M`, `≈3.1%`. */
function fmtShort(unit: SessionBudgetUnit, n: number, approx: boolean): string {
  if (unit === "usd") return fmtUsd(n);
  if (unit === "tok") return fmtCount(n);
  return `${approx ? "≈" : ""}${fmtPct(n)}%`;
}

/** One amount with its unit spelled, for a sentence. */
function fmtLong(unit: SessionBudgetUnit, n: number): string {
  if (unit === "tok") return `${fmtCount(n)} tokens`;
  if (unit === "usd") return fmtUsd(n);
  return `≈${fmtPct(n)}% of ${unit === "sessionPct" ? "the 5-hour window" : "the week"}`;
}

/** A total and its subagent split, in one unit — never the total alone. */
function withSplit(value: number, agent: number | null, f: (n: number) => string, part: (n: number) => string = f): string {
  if (agent == null) return `${f(value)} so far — the subagent share is not logged for this session`;
  if (!(agent > 0)) return `${f(value)} so far, none of it in subagents`;
  return `${f(value)} so far — ${part(Math.max(0, value - agent))} in this conversation, ${part(agent)} in subagents`;
}

/**
 * What this session has spent, in the unit being picked, with its subagent
 * split — the orientation a cap is typed against. Null with no spark at all
 * (a launch: there is no session yet). An unknown is shared's sentence, and a
 * percent that cannot be converted still prints the DOLLARS it would convert,
 * because "can't tell" alone leaves the person typing blind.
 */
export function budgetSpentLine(unit: SessionBudgetUnit, spark: SessionBudgetSpark | null | undefined, cal: SessionBudgetCal | null | undefined, now: number): string | null {
  if (spark === undefined) return null;
  // `cal` undefined: the host sends a calibration only with a budget, so before
  // one is set a percent cannot be converted here — say the dollars, not "no reading".
  if (isPctUnit(unit) && cal === undefined) {
    if (spark && spark.costUsd != null) return `in dollars, ${withSplit(spark.costUsd, spark.agentCostUsd ?? null, fmtUsd)}`;
    return sessionBudgetUnknownText(spark ? "unpriced" : "noSpark");
  }
  const s = sessionSpend(unit, spark, cal, now);
  // The window is named once, on the total; the two parts are its shares.
  if (s.value != null) return withSplit(s.value, s.agent, (n) => fmtLong(unit, n), isPctUnit(unit) ? (n) => fmtShort(unit, n, true) : undefined);
  const why = sessionBudgetUnknownText(s.why ?? "noSpark", s.why === "stale" && cal ? now - cal.checkedAt : undefined);
  if (isPctUnit(unit) && spark && spark.costUsd != null) {
    return `${why}. In dollars: ${withSplit(spark.costUsd, spark.agentCostUsd ?? null, fmtUsd)}.`;
  }
  return why;
}

/**
 * The typed cap against what is already spent: `$0.48 of $2.00 — 24% used`.
 * Null where the spend is unknown (the spent line already says why) or there
 * is no session. Past the cap it says what setting it would do, at once.
 */
export function budgetPreview(cfg: Pick<SessionBudget, "unit" | "max">, spark: SessionBudgetSpark | null | undefined, cal: SessionBudgetCal | null | undefined, now: number): string | null {
  if (!spark) return null;
  const s = sessionSpend(cfg.unit, spark, cal, now);
  if (s.value == null) return null;
  const pct = isPctUnit(cfg.unit);
  const head = `${fmtShort(cfg.unit, s.value, pct)} of ${fmtShort(cfg.unit, cfg.max, false)}`;
  if (s.value >= cfg.max) return `${head} — already past it: this session's sends would be held as soon as it is set`;
  const used = (s.value / cfg.max) * 100;
  return `${head} — ${used < 1 ? "under 1" : Math.round(used)}% used`;
}

/** What being over means for a person, said once. */
export const HELD_SENDS =
  "Sends to this session are held until you raise or clear the budget — an explicit send, an answer to a question and an upload still go.";

/** The state line for a session's budget, from the host's verdict: what it is
 *  doing now, in shared's own sentences. Used by the sheet and the context
 *  panel alike, so the two cannot disagree. */
export function budgetStateLine(b: SessionBudgetInfo | undefined, now: number, spark?: SessionBudgetSpark | null): string {
  if (!b) {
    // With the session's spark at hand, say what it has spent — in dollars, or
    // in tokens where no list price covers the model — so "no budget" is never
    // the only fact on a panel whose whole subject is spend.
    if (spark === undefined) return "No budget on this session.";
    const unit = sessionSpend("usd", spark, null, now).value != null ? "usd" : sessionSpend("tok", spark, null, now).value != null ? "tok" : null;
    const line = unit && budgetSpentLine(unit, spark, null, now);
    return line ? `No budget on this session. Spent: ${line}.` : "No budget on this session.";
  }
  const v = b.verdict;
  if (v.state === "unknown") return sessionBudgetUnknownText(v.why ?? "noSpark", v.why === "stale" && b.cal ? now - b.cal.checkedAt : undefined);
  return `${sessionBudgetText(v)}${v.state === "over" ? `. ${HELD_SENDS}` : "."}`;
}

/** The backlog row's chip: the cap as the person set it. */
export const budgetChipWords = (cfg: SessionBudget): string => `budget ${sessionBudgetLabel(cfg)}`;
