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
  BUDGET_STALE_MS, SESSION_BUDGET_PCT_CAVEAT, fmtCount, fmtUsd, sessionBudgetHoldText, sessionBudgetLabel, sessionBudgetText, sessionBudgetUnknownText, sessionBudgetWindowsOffText, sessionSpend,
  type SessionBudgetInfo, type SessionBudget, type SessionBudgetCal, type SessionBudgetSpark, type SessionBudgetUnit,
} from "@waterplane/shared";
import { runsClaudeTui, type BackendList } from "./backendCaps.ts";

/**
 * The budget field's `windowsOff` sentence for a backend named at LAUNCH time (no session yet):
 * null where a percent is offered as ever (claude's TUI, and a host that never listed backends),
 * else the shared sentence — a percent cap on another backend's session would never hold.
 * Lives here, not in the feature, because the launch ask, the Send sheet and the backlog row
 * all draw the field and may not import a feature.
 */
export function launchWindowsOff(backends: BackendList, backend: string | undefined): string | null {
  if (runsClaudeTui(backends, backend)) return null;
  return sessionBudgetWindowsOffText(backends?.find((b) => b.id === backend)?.label || "this backend");
}

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

/**
 * The units this session's picker offers. `windowsOff`: the session's backend
 * does not spend from claude's 5-hour and weekly windows, so a percent of one
 * could never trip and is not offered (the field says why in a sentence) —
 * except the unit a cap was ALREADY set in, which stays so it is never
 * silently swapped for another.
 */
export function budgetUnitsFor(windowsOff: boolean, keep?: SessionBudgetUnit, spendUnit?: string): typeof BUDGET_UNITS {
  const base = windowsOff ? BUDGET_UNITS.filter((u) => !isPctUnit(u.unit) || u.unit === keep) : BUDGET_UNITS;
  // The backend's own unit: offered where it NAMES one, or where a cap is already set in it
  // (never silently swapped). Without a name the kept cap still shows, under a generic label.
  const label = spendUnit?.trim() || (keep === "native" ? "native unit" : "");
  if (!label) return base;
  return [...base, { unit: "native", label, example: "5 or 0.5", suffix: label, presets: ["1", "5", "20"] }];
}

/** The launch-time twin of `launchWindowsOff`: the unit name a backend states for its own spend, if any. */
export function launchSpendUnit(backends: BackendList, backend: string | undefined): string | undefined {
  return backends?.find((b) => b.id === backend)?.caps?.spendUnit?.trim() || undefined;
}

export const unitInfo = (u: SessionBudgetUnit) => BUDGET_UNITS.find((x) => x.unit === u) ?? BUDGET_UNITS[0];

/** A quick pick as its chip reads: `$2`, `1m`, `10%`. */
export function presetLabel(unit: SessionBudgetUnit, text: string): string {
  return unit === "native" ? text : unit === "usd" ? `$${text}` : isPctUnit(unit) ? `${text}%` : text;
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

/** A native amount as stated, at most one decimal (shared's own rule: nothing was converted). */
const fmtNat = (n: number): string => (Number.isInteger(n) ? fmtCount(n) : String(Math.round(n * 10) / 10));

/** One amount, short — the figure a preview line compares: `$0.48`, `1.2M`, `≈3.1%`. */
function fmtShort(unit: SessionBudgetUnit, n: number, approx: boolean): string {
  if (unit === "native") return fmtNat(n);
  if (unit === "usd") return fmtUsd(n);
  if (unit === "tok") return fmtCount(n);
  return `${approx ? "≈" : ""}${fmtPct(n)}%`;
}

/** One amount with its unit spelled, for a sentence. */
function fmtLong(unit: SessionBudgetUnit, n: number, nativeUnit?: string): string {
  if (unit === "native") return `${fmtNat(n)} ${nativeUnit ?? "of the backend's own unit"}`;
  if (unit === "tok") return `${fmtCount(n)} tokens`;
  if (unit === "usd") return fmtUsd(n);
  return `≈${fmtPct(n)}% of ${unit === "sessionPct" ? "the 5-hour window" : "the week"}`;
}

/** A total and its subagent split, in one unit — never the total alone. */
function withSplit(value: number, agent: number | null, f: (n: number) => string, part: (n: number) => string = f, source = false): string {
  if (agent == null) return `${f(value)} so far — the subagent share is not ${source ? "stated by this session's backend" : "logged for this session"}`;
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
export function budgetSpentLine(unit: SessionBudgetUnit, spark: SessionBudgetSpark | null | undefined, cal: SessionBudgetCal | null | undefined, now: number, nativeUnit?: string): string | null {
  if (spark === undefined) return null;
  // `cal` undefined: the host sends a calibration only with a budget, so before
  // one is set a percent cannot be converted here — say the dollars, not "no reading".
  if (isPctUnit(unit) && cal === undefined && !spark?.source) {
    if (spark && spark.costUsd != null) return `in dollars, ${withSplit(spark.costUsd, spark.agentCostUsd ?? null, fmtUsd)}`;
    return sessionBudgetUnknownText(spark ? "unpriced" : "noSpark");
  }
  const s = sessionSpend(unit, spark, cal, now, nativeUnit);
  // The window is named once, on the total; the two parts are its shares.
  if (s.value != null) return withSplit(s.value, s.agent, (n) => fmtLong(unit, n, nativeUnit), isPctUnit(unit) ? (n) => fmtShort(unit, n, true) : undefined, !!spark?.source);
  const why = sessionBudgetUnknownText(s.why ?? "noSpark", s.why === "stale" && cal ? now - cal.checkedAt : undefined, unit, nativeUnit);
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
export function budgetPreview(cfg: Pick<SessionBudget, "unit" | "max" | "nativeUnit">, spark: SessionBudgetSpark | null | undefined, cal: SessionBudgetCal | null | undefined, now: number): string | null {
  if (!spark) return null;
  const s = sessionSpend(cfg.unit, spark, cal, now, cfg.nativeUnit);
  if (s.value == null) return null;
  const pct = isPctUnit(cfg.unit);
  const head = `${fmtShort(cfg.unit, s.value, pct)} of ${fmtShort(cfg.unit, cfg.max, false)}`;
  if (s.value >= cfg.max) return `${head} — already past it: this session's sends would be held as soon as it is set`;
  const used = (s.value / cfg.max) * 100;
  return `${head} — ${used < 1 ? "under 1" : Math.round(used)}% used`;
}

export type BudgetMode = "soft" | "hard";

/**
 * What happens at the cap, as the field's two rows say it. Soft is today's
 * behaviour and the default; hard is opt-in. Both rows carry their whole
 * meaning, so the choice is read before it is made, not after.
 */
export const BUDGET_MODES: readonly { key: BudgetMode; label: string; note: string }[] = [
  {
    key: "soft",
    label: "soft (default) — hold queued work, never block me",
    note: "At the cap, queued and scheduled sends to this session wait and you are told. What you send yourself still goes, without a question. The switch below decides whether the turn running at that moment gets one Esc; later turns are left to run.",
  },
  {
    key: "hard",
    label: "hard — ask before my sends, stop every other turn",
    note: "At the cap, queued and scheduled sends wait and you are told. Each send you make yourself asks “send anyway?” first, and that one turn then runs. Every turn you did not send yourself — a subagent reporting back, a chained prompt — is stopped with one Esc, turn after turn.",
  },
];

/** The ask a hard budget puts in front of a person's own send, past the cap. */
export function hardSendAsk(spent: string): { title: string; lines: string[]; confirmLabel: string; cancelLabel: string } {
  return {
    title: "Past this session's hard budget",
    lines: [
      `${spent}.`,
      "Send anyway: this message goes and its turn runs to the end. Turns you did not send still get one Esc.",
      "Keep it: the words stay in the box. Tap budget hit on the session to raise or clear the budget.",
    ],
    confirmLabel: "send anyway",
    cancelLabel: "keep it",
  };
}

/** What being over means for a person, said once — soft, the default. A
 *  verdict at hand words its own mode with `sessionBudgetHoldText(cfg)`. */
export const HELD_SENDS = sessionBudgetHoldText({});

/** The state line for a session's budget, from the host's verdict: what it is
 *  doing now, in shared's own sentences. Used by the sheet and the context
 *  panel alike, so the two cannot disagree.
 *
 *  With no budget, the SPARK says which caller this is. Without one (the
 *  budget sheet) the line stands alone and says there is none. With one (the
 *  context sheet's budget card, whose TITLE is "no budget on this session") it
 *  is only what the session has spent — the card printed "no budget on this
 *  session" twice, as its title and as its body — and null where nothing is
 *  known, leaving the card its title and its door. */
export function budgetStateLine(b: SessionBudgetInfo | undefined, now: number): string;
export function budgetStateLine(b: SessionBudgetInfo | undefined, now: number, spark: SessionBudgetSpark | null): string | null;
export function budgetStateLine(b: SessionBudgetInfo | undefined, now: number, spark?: SessionBudgetSpark | null): string | null {
  if (!b) {
    // With the session's spark at hand, say what it has spent — in dollars, or
    // in tokens where no list price covers the model — so "no budget" is never
    // the only fact on a panel whose whole subject is spend.
    if (spark === undefined) return "No budget on this session.";
    const unit = sessionSpend("usd", spark, null, now).value != null ? "usd" : sessionSpend("tok", spark, null, now).value != null ? "tok" : null;
    const line = unit && budgetSpentLine(unit, spark, null, now);
    return line ? `Spent: ${line}.` : null;
  }
  const v = b.verdict;
  if (v.state === "unknown") return sessionBudgetUnknownText(v.why ?? "noSpark", v.why === "stale" && b.cal ? now - b.cal.checkedAt : undefined, v.unit, v.nativeUnit);
  return `${sessionBudgetText(v)}${v.state === "over" ? `. ${sessionBudgetHoldText(b.cfg)}` : "."}`;
}

/** The backlog row's chip: the cap as the person set it. */
export const budgetChipWords = (cfg: SessionBudget): string => `budget ${sessionBudgetLabel(cfg)}`;
