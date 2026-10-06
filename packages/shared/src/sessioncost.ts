/**
 * What one more turn in THIS session costs, against what it would cost in a
 * fresh one.
 *
 * ── The question this answers ───────────────────────────────────────────────
 *
 * Every turn re-sends the whole conversation. So the price of the next turn is
 * not a property of what you are about to ask — it is the size of what is
 * already there. A session at 400k spends 5-6× per turn what the same question
 * would cost in a session opened a minute ago, and nothing on screen ever said
 * so: the context badge says how much window is LEFT, which is a statement
 * about when the CLI will compact, not about what the next turn costs.
 *
 * Measured on this desktop's own logs before any of this was written: 124
 * conversations out of 8,968 in a fortnight grew past 200k of context, and those
 * 124 accounted for 76% of every token spent. The turns at index 80 and beyond
 * were 54% of the total, at an average of 312k carried per turn. The same work
 * split into fresh sessions every ~40 turns simulates at a third of the tokens.
 * The conversations were not doing anything unusual — they were just long.
 *
 * ── Why this is a READOUT and never a gate ──────────────────────────────────
 *
 * A long session is often exactly the right thing: the model knows the file, the
 * failed approach and the three constraints you have not typed twice. That is
 * worth paying for, and only the person in front of it can say whether it is
 * worth paying for THIS turn. So everything here produces sentences and a chip,
 * nothing produces a refusal, and no caller is given a boolean named `blocked`.
 * A reminder that can stop you is not a reminder.
 *
 * ── The one number worth putting on screen ──────────────────────────────────
 *
 * `breakEvenTurns` — how many more turns of new work it takes before a fresh
 * session would have been cheaper. It is derived from the cache multipliers in
 * `pricing.ts` rather than guessed, and it answers the question people actually
 * have ("should I just ask it here?") in the unit they are thinking in.
 *
 * At the measured numbers a single quick question is genuinely cheaper in the
 * session that is already warm, and a ten-turn feature is several times cheaper
 * somewhere new. A rule of thumb that says "always start fresh" would be wrong
 * about the first case, and the whole point of computing this per session is to
 * stop having a rule of thumb.
 */

// The one door. The code lives in `./sessioncost/` (a slice per subject, listed below);
// importers keep saying `./sessioncost.js`. docs/notes/shared-architecture.md.

export {
  MULT_WARM,
  MULT_HEAVY,
  MULT_STEEP,
  MIN_TURNS,
  CACHE_TTL_MS,
  CACHE_COLD_AFTER_MS,
  cacheLikelyCold,
} from "./sessioncost/costtypes.js";
export type {
  SessionCostLevel,
  SessionCostInput,
  SessionCostReading,
} from "./sessioncost/costtypes.js";
export {
  fmtMultiple,
  fmtTok,
  usageText,
  usageChip,
  costChip,
  WEEK_CAL_MIN_PCT,
  weekUsdPerPct,
  weekShareText,
  turnCostParts,
  turnTokensText,
  nextTurnText,
  DOLLARS_WHY_HEAD,
  DOLLARS_WHY,
  COST_WHERE_HEAD,
  COST_WHERE,
  costText,
} from "./sessioncost/costwords.js";
export {
  breakEvenTurns,
  agentAdvice,
  AGENT_LARGE_TOK,
  AGENT_LIVE_MS,
  liveAgentText,
  sessionCost,
  costDoorsText,
  seriesCostFields,
  sessionCostOfSeries,
} from "./sessioncost/costreading.js";
export type {
  CacheAge,
} from "./sessioncost/costreading.js";
export {
  sessionCostOf,
} from "./sessioncost/costofseries.js";
export {
  compactionReading,
  compactionCountText,
  compactionUnmeasuredText,
  compactionRowFacts,
  compactionSavedText,
  compactionPendingText,
  compactionCostText,
  compactionRatioText,
  compactionWindowText,
  compactionMethodText,
  compactionRowLabel,
} from "./sessioncost/costcompact.js";
export type {
  CompactionReading,
  CompactionRow,
} from "./sessioncost/costcompact.js";
export {
  REBUILD_WROTE,
  REBUILD_READ,
  isColdRebuild,
  coldStartText,
  coldStartChip,
} from "./sessioncost/costcold.js";
export type {
  ColdStarts,
} from "./sessioncost/costcold.js";
