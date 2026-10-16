/**
 * Spend warnings: the orange and red marks a session wears once what it has
 * spent passes a threshold the person chose — as a share of the weekly limit
 * on a subscription, in dollars where nothing calibrates a week.
 *
 * A READOUT, like `sessionCostPill`: it disables nothing, holds nothing and
 * refuses nothing (the per-session budget, `sessionbudget.ts`, is the thing
 * that can hold a queue). It exists because a session gets expensive one
 * ordinary turn at a time and the chip beside it is only read by somebody who
 * already suspects it.
 *
 * Which scale applies is decided per reading, never stored: a weekly
 * calibration (`weekUsdPerPct`) on hand ⇒ percent of week, otherwise dollars.
 * An API key has no weekly limit, and a subscription whose week has not been
 * calibrated yet is in the same position — both get the dollar pair, and the
 * sentence says which one tripped.
 *
 * The dollar defaults are DERIVED from the percent ones on a Max plan: one
 * reading on this desktop put $205 of list price at ≈14% of a week, ≈$15 a
 * point, so 2% ≈ $30 and 5% ≈ $75. A different plan moves that rate; the
 * percent pair is the one that follows it.
 */
import { fmtUsd, fmtUsdShort } from "./pricing.js";

export interface SpendWarnCfg {
  /** Draw the marks at all. */
  on: boolean;
  /** Orange at this share of the weekly limit (percent points). */
  warnPct: number;
  /** Red at this share. */
  highPct: number;
  /** Orange at this many dollars of list price, where no week is calibrated. */
  warnUsd: number;
  /** Red at this many dollars. */
  highUsd: number;
}

export const SPEND_WARN_DEFAULT: SpendWarnCfg = { on: true, warnPct: 2, highPct: 5, warnUsd: 30, highUsd: 75 };

const pos = (v: unknown, cap: number): number | null =>
  typeof v === "number" && Number.isFinite(v) && v > 0 && v <= cap ? v : null;

/**
 * A stored or synced value → a config. A field that is missing or out of range
 * falls back to its DEFAULT (never to zero, which would light every session);
 * a red threshold at or under the orange one is dropped to the default pair,
 * since "red before orange" is a typo, not a setting.
 */
export function cleanSpendWarn(raw: unknown): SpendWarnCfg {
  const o = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const d = SPEND_WARN_DEFAULT;
  let warnPct = pos(o.warnPct, 100) ?? d.warnPct;
  let highPct = pos(o.highPct, 100) ?? d.highPct;
  if (!(highPct > warnPct)) { warnPct = d.warnPct; highPct = d.highPct; }
  let warnUsd = pos(o.warnUsd, 1e6) ?? d.warnUsd;
  let highUsd = pos(o.highUsd, 1e6) ?? d.highUsd;
  if (!(highUsd > warnUsd)) { warnUsd = d.warnUsd; highUsd = d.highUsd; }
  return { on: o.on === false ? false : true, warnPct, highPct, warnUsd, highUsd };
}

export type SpendWarnLevel = "warn" | "high";

export interface SpendWarn {
  level: SpendWarnLevel;
  /** Which scale tripped: the weekly share, or dollars (no calibration). */
  by: "week" | "usd";
  /** The threshold it passed, in that scale's unit. */
  at: number;
  /** One sentence, for a title, the toast and the sheet. */
  text: string;
}

const pctWord = (p: number) => `${Number(p.toPrecision(2))}%`;

/**
 * The mark for a session that has spent `costUsd` (list price, subagents
 * included — `ContextSpark.costUsd`), or null. Unknown never trips: no figure,
 * an unpriced session, or the marks switched off are all null — absent, not a
 * green "fine".
 */
export function spendWarnOf(costUsd: number | null | undefined, usdPerPct: number | null | undefined, cfg: SpendWarnCfg): SpendWarn | null {
  if (!cfg.on || costUsd == null || !Number.isFinite(costUsd) || !(costUsd > 0)) return null;
  if (usdPerPct != null && Number.isFinite(usdPerPct) && usdPerPct > 0) {
    const pct = costUsd / usdPerPct;
    const level: SpendWarnLevel | null = pct >= cfg.highPct ? "high" : pct >= cfg.warnPct ? "warn" : null;
    if (!level) return null;
    const at = level === "high" ? cfg.highPct : cfg.warnPct;
    return {
      level, by: "week", at,
      text: `This session has spent ≈${pctWord(pct)} of the week (${fmtUsd(costUsd)} at list prices) — past your ${level === "high" ? "red" : "orange"} mark at ${pctWord(at)}.`,
    };
  }
  const level: SpendWarnLevel | null = costUsd >= cfg.highUsd ? "high" : costUsd >= cfg.warnUsd ? "warn" : null;
  if (!level) return null;
  const at = level === "high" ? cfg.highUsd : cfg.warnUsd;
  return {
    level, by: "usd", at,
    text: `This session has spent ${fmtUsd(costUsd)} at list prices — past your ${level === "high" ? "red" : "orange"} mark at ${fmtUsdShort(at)} (no weekly limit reading to measure it against).`,
  };
}
