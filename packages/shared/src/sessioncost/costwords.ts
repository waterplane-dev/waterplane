// Cut from sessioncost.ts (move only): the sentences and chips
// The one door stays `./sessioncost.js`; this slice imports its siblings directly, never the barrel.

import { fmtUsd, fmtUsdShort } from "../pricing.js";
import type { SessionCostReading } from "./costtypes.js";

/** `n×`, at the precision the number deserves: 2.5 below ten, 12 above it. */
export function fmtMultiple(m: number): string {
  return m >= 10 ? `${Math.round(m)}×` : `${(Math.round(m * 10) / 10).toFixed(1)}×`;
}

/** Tokens, short — `71k`, `1.2M`. Local to this module on purpose: it is used
 *  inside the sentences, and a sentence that reads differently on two screens
 *  because each formatted its own numbers is the bug `tokens.ts` exists over. */
export function fmtTok(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(Math.round(n));
}

/**
 * What a session has used, in one sentence — the ONE wording.
 *
 * Every screen that prints the total says it this way: the row's title, the
 * session header, the context sheet's panel and the toast. It is written "so
 * far" in all of them because the number is a floor (a truncated log, an agent
 * log that has been cleaned up), and the agent share is named only when there
 * IS one — "0 of it in subagents" is a sentence about nothing.
 */
export function usageText(usageTok: number, agentTok: number | null): string {
  const agents = agentTok != null && agentTok > 0
    ? ` — ${fmtTok(agentTok)} of it in subagents`
    : "";
  return `This session has used ${fmtTok(usageTok)} tokens so far${agents}.`;
}

/**
 * The same total as a chip: `1.4M`, or null when nothing measured it.
 *
 * Null rather than `0`, and rather than falling back to the carried volume: a
 * zero beside a running session reads as a measurement that came back empty,
 * and this one is simply absent on a host that does not send it.
 */
export function usageChip(usageTok: number | null | undefined): string | null {
  return usageTok != null && usageTok > 0 ? fmtTok(usageTok) : null;
}

/**
 * What the session WOULD have cost, as a chip: `$4.21`, or null.
 *
 * The money twin of `usageChip`, and for the same reason it is a separate
 * function rather than a `fmtUsdShort` call at each site: this is the one place
 * that decides what "no figure" looks like. Null — never `$0` — when nothing
 * measured it or nothing could be priced, so the caller falls back to the token
 * total rather than printing an amount that reads as "this was free".
 *
 * Why the chip is money at all: two conversations that carried 38M and 18M
 * tokens tell you nothing about which one was expensive, because the answer is
 * the model they ran and how much of the traffic was cache reads at a tenth of
 * the rate. A dollar figure is the same fact with the arithmetic already done.
 */
export function costChip(costUsd: number | null | undefined): string | null {
  return costUsd != null && Number.isFinite(costUsd) && costUsd > 0 ? fmtUsdShort(costUsd) : null;
}

/**
 * Fewest weekly percent a calibration is taken from. `/usage` prints a whole
 * percent, so the reading is ±0.5 of itself: at 5% that is ±10% on every share
 * derived from it, at 1% it is ±50% — a number that wide is a wrong number.
 */
export const WEEK_CAL_MIN_PCT = 5;

/**
 * Dollars of list-price spend per percent of the weekly limit, or null.
 *
 * The account never says what one percent IS, so this measures it: what this
 * desktop's logs priced in the weekly window up to the scrape, divided by the
 * percentage the scrape read. The limit weighs models by price, not by raw
 * tokens (a cache read is a tenth of an input token in both), which is why the
 * calibration is in money. Traffic the logs never saw — claude.ai, another
 * machine — counts against the limit but not in the spend, so a share derived
 * from this errs LOW, and the caller's note says the estimate is this desktop's.
 */
export function weekUsdPerPct(weekCostUsd: number | null | undefined, weeklyPct: number | null | undefined): number | null {
  if (weekCostUsd == null || weeklyPct == null) return null;
  if (!Number.isFinite(weekCostUsd) || !(weekCostUsd > 0)) return null;
  if (!Number.isFinite(weeklyPct) || weeklyPct < WEEK_CAL_MIN_PCT || weeklyPct > 100) return null;
  return weekCostUsd / weeklyPct;
}

/** A dollar figure as a share of the weekly limit — `≈0.4% of week` — or null
 *  without a calibration or a figure. Below a thousandth it says so rather
 *  than printing a zero. */
export function weekShareText(costUsd: number | null | undefined, usdPerPct: number | null | undefined): string | null {
  if (costUsd == null || usdPerPct == null || !(costUsd > 0) || !(usdPerPct > 0)) return null;
  const pct = costUsd / usdPerPct;
  if (!Number.isFinite(pct)) return null;
  if (pct < 0.001) return "<0.001% of week";
  // Significant figures, not decimals: one percent of a week is ~$18 of list
  // price here, so a typical prompt is a few hundredths and a fixed decimal
  // would print the same "<0.1" under every turn. One figure below 1%, two
  // above — the calibration is good to ±10% at its worst, no finer.
  const s = pct < 1 ? String(Number(pct.toPrecision(1))) : pct < 10 ? pct.toFixed(1) : String(Math.round(pct));
  return `≈${s}% of week`;
}

/**
 * The reader's line under one turn: what that prompt cost, what of it its
 * subagents spent, the conversation's running total by then, and the context
 * its last request carried — or null when none was measured.
 *
 * Each part is absent rather than `$0` / `0` (see `TranscriptTurn`), and the
 * money parts end on the counterfactual in words, because a bare dollar figure
 * under every turn reads as a bill.
 *
 * **Subagents are IN the figures when the host placed them** (`agentCostUsd`,
 * `cumAgentCostUsd`) and the turn's figure then never stands without its split
 * (`agents`: how much of it they spent). An agent can still be running when
 * this is drawn — its call returned at once — so the figure then says "so far"
 * and how many are still at it. Where the host could not place them (an older
 * host, an unreadable agent directory, an agent it could not attribute) the
 * figure is the conversation's own and the note SAYS subagents are not in it:
 * `agents` (how many the turn started, by any evidence the caller has) and
 * `agentsSoFar` (one was started at or before this turn) are that evidence.
 *
 * `usdPerWeekPct` (`weekUsdPerPct`) adds each money figure's share of the
 * weekly limit beside it, and the note says where that share comes from.
 */
export function turnCostParts(t: {
  costUsd?: number; cumCostUsd?: number; ctxTok?: number; agents?: number;
  agentsSoFar?: boolean;
  agentCostUsd?: number; cumAgentCostUsd?: number; agentsRunning?: number; agentUnpricedTok?: number;
  usdPerWeekPct?: number | null;
  /** What that calibration counted beyond this desktop (`peerWeekSpend`'s `incl. $0.84 on pc`). */
  weekIncl?: string | null;
}): { turn: string | null; agents: string | null; total: string | null; ctx: string | null; note: string | null } | null {
  const ok = (n: number | undefined): n is number => n != null && Number.isFinite(n) && n > 0;
  const running = ok(t.agentsRunning) ? t.agentsRunning : 0;
  const agentUsd = ok(t.agentCostUsd) ? t.agentCostUsd : 0;
  const week = (usd: number) => {
    const w = weekShareText(usd, t.usdPerWeekPct);
    return w ? ` (${w})` : "";
  };
  const turn = ok(t.costUsd)
    ? `${fmtUsd(t.costUsd + agentUsd)} this prompt${running ? " so far" : ""}${week(t.costUsd + agentUsd)}`
    : null;
  const runningText = running ? `${running} subagent${running === 1 ? "" : "s"} still running` : null;
  const agents = turn && agentUsd
    ? `${fmtUsd(agentUsd)} of it in subagents${runningText ? ` · ${runningText}` : ""}`
    : runningText;
  const agentsInTotal = t.cumAgentCostUsd != null && Number.isFinite(t.cumAgentCostUsd);
  const totalUsd = ok(t.cumCostUsd) ? t.cumCostUsd + (agentsInTotal ? t.cumAgentCostUsd! : 0) : 0;
  const total = totalUsd > 0
    ? `${fmtUsd(totalUsd)} session so far${week(totalUsd)}`
    : null;
  const ctx = ok(t.ctxTok) ? `${fmtTok(t.ctxTok)} context` : null;
  if (!turn && !total && !ctx && !agents) return null;
  // What a figure on screen leaves out. The turn's: it started agents and none
  // of their spend (or running state) reached it. The total's: an agent before
  // now, and the host published no agent running total beside it.
  const turnMissing = !!t.agents && turn != null && !agentUsd && !running;
  const totalMissing = !!t.agentsSoFar && total != null && !agentsInTotal;
  const unpriced = ok(t.agentUnpricedTok)
    ? `, ${fmtTok(t.agentUnpricedTok)} subagent tokens have no published rate`
    : "";
  // A calibration that also counted jobs sent to a peer desktop on the same account says so.
  const incl = typeof t.weekIncl === "string" && t.weekIncl.trim() ? ` (${t.weekIncl.trim()})` : "";
  const weekNote = (turn || total) && weekShareText(1, t.usdPerWeekPct)
    ? `; % of week estimated from this desktop's spend${incl} against the weekly limit reading`
    : "";
  const note = turn || total
    ? `API list price${turnMissing || totalMissing ? ", subagents not included" : ""}${unpriced}${weekNote}`
    : null;
  return { turn, agents, total, ctx, note };
}

/**
 * A turn's own tokens, total FIRST and its split beside it — the ONE wording
 * for the reader's turn foot (`TranscriptTurn.tokens`): `52k tokens — 1.2k in ·
 * 830 out · 46k cache read · 3.2k cache write`. A total is never printed
 * without its split, because nearly all of it is usually a cache read at a
 * tenth of the input rate and "52k" alone overstates what was typed by orders
 * of magnitude.
 *
 * A kind that is zero is left out (a measured zero is not news on a phone
 * line); null when the field is absent or every kind is zero — never "0 tokens".
 */
export function turnTokensText(t: { input: number; output: number; cacheRead: number; cacheWrite: number } | null | undefined): string | null {
  if (!t) return null;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
  const parts: [number, string][] = [
    [n(t.input), "in"], [n(t.output), "out"], [n(t.cacheRead), "cache read"], [n(t.cacheWrite), "cache write"],
  ];
  const total = parts.reduce((s, [v]) => s + v, 0);
  if (!(total > 0)) return null;
  const split = parts.filter(([v]) => v > 0).map(([v, w]) => `${fmtTok(v)} ${w}`).join(" · ");
  return `${fmtTok(total)} tokens — ${split}`;
}

/**
 * What the NEXT prompt here costs against a fresh session — one line under the
 * newest finished turn, from the same reading the header chip and the context
 * sheet use (`sessionCostOf`), so the three cannot disagree.
 *
 * Tokens and the multiple, never a dollar figure: the next turn's price needs
 * the model's rate AND whether the cache is still warm, and a figure built on a
 * guess at either would be a plausible wrong number. With no first reading
 * (a log the host tail-read) the comparison is ABSENT and the line says only
 * what the next prompt re-reads.
 */
export function nextTurnText(r: SessionCostReading | null | undefined): string | null {
  if (!r || !(r.tok > 0)) return null;
  const head = `Next prompt re-reads ${fmtTok(r.tok)} of context`;
  if (r.multiple == null || r.baseTok == null) return `${head}.`;
  if (r.multiple < 1.15) return `${head} — about what a fresh session here starts with (${fmtTok(r.baseTok)}).`;
  return `${head} — ${fmtMultiple(r.multiple)} what a fresh session here starts with (${fmtTok(r.baseTok)}).`;
}

/**
 * Why a dollar figure is on screen at all for someone on a flat-fee plan —
 * the ONE wording, shown wherever a list-price figure can be tapped or
 * expanded (the per-prompt card, the context & cost sheet, token statistics).
 *
 * `costText` says what the number is NOT (a bill). This says what it IS for:
 * a plan's session and weekly limits do not count every token the same, and
 * the kinds differ by up to 100× in price on one model (Opus 5.5: a cache read
 * $0.20/MTok, an output token $20/MTok). A token total adds those up as if
 * equal, so it says almost nothing about how much of a limit a turn used; the
 * API list price weighs each kind by its own rate, which makes it the one
 * number that can be compared across turns, sessions and models.
 */
export const DOLLARS_WHY_HEAD = "Why dollars on a subscription?";
export const DOLLARS_WHY =
  "Your plan's session and weekly limits don't count every token the same: on one model a cache read " +
  "costs a hundredth of an output token. Adding tokens up treats them as equal, so the total says little " +
  "about how much of your limit a prompt used. Pricing each kind at Anthropic's API list price weighs it " +
  "by its own rate — the one number you can compare across prompts, sessions and models. It is not a bill.";

/** Where the per-prompt cost card is drawn, and why the two views differ — said
 *  under the same "?" as `DOLLARS_WHY`, in both views, so the difference is
 *  explained wherever the card is. */
export const COST_WHERE_HEAD = "Why only the last prompt in the CLI view?";
export const COST_WHERE =
  "The reader folds this card under every prompt — tap a line to open it, and scroll up for older ones. " +
  "The CLI view has no scroll-back of its own to hang a card on, so it keeps only the last prompt's, " +
  "pinned under the terminal at a fixed height: opening or updating it never resizes the screen, which " +
  "would make the CLI redraw. Same figures, same card; the newest one remembers open or folded in both.";

/**
 * What a session has cost, in one sentence — the ONE wording, and the framing
 * is not optional.
 *
 * A dollar figure with nothing around it is read as a bill. This one is a
 * COUNTERFACTUAL: what the same traffic would have cost billed through the API
 * at list prices, while the CLI this app drives is usually running on a
 * subscription, which is a flat fee no matter how many tokens go through it.
 * `pricing.ts` states the whole argument; this is the sentence it produces.
 *
 * "so far" for the same reason `usageText` says it — every input is a floor —
 * and the subagent clause only where there is one. Unpriced tokens are named
 * rather than quietly charged at zero, because a model missing from the rate
 * table is the one way this figure goes silently low.
 */
export function costText(
  costUsd: number,
  agentCostUsd: number | null,
  unpricedTok?: number | null,
): string {
  const agents = agentCostUsd != null && agentCostUsd > 0
    ? ` — ${fmtUsd(agentCostUsd)} of it in subagents`
    : "";
  const missing = unpricedTok != null && unpricedTok > 0
    ? ` ${fmtTok(unpricedTok)} tokens ran on a model with no published rate and are not in it.`
    : "";
  return `At list prices that is ${fmtUsd(costUsd)} so far${agents} — an estimate of what the API would have charged, not what a subscription costs.${missing}`;
}
