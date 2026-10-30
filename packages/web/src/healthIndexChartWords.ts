/**
 * The Score card's own short words (`HealthIndexChart.tsx`): the hero's
 * one-line cap, the bars' two-swatch legend, the fold's summary and the
 * first-scored-week absence. Pure (`healthIndexChartWords.test.mjs`, which
 * holds them to the index's verdict-word ban). The longer sentences stay in
 * `healthIndexWords.ts` / `healthSpendWords.ts`.
 */
import { HEALTH_ENTRY_LABEL, HEALTH_SCORE_CAP_GAP, wordOf, type HealthEntry } from "@waterplane/shared";

/** Beside the hero number. */
export const OUT_OF_100 = "out of 100";

/** The fold under the Score card holding every method sentence. */
export const HOW_SCORED_SUMMARY = "how this is scored";

/** The bars' two swatches. */
export const BAR_UP_WORDS = "pushed the score up";
export const BAR_DOWN_WORDS = "pulled it down";

/**
 * The cap as ONE line beside the hero: `held down by file length, at 16 of 100`.
 * Null when the score is not capped (the same test as shared `healthCapWords`,
 * whose full sentence moves into the fold).
 */
export function heldDownWords(s: { value: number; mean: number; cappedBy: HealthEntry | null }): string | null {
  if (!s.cappedBy || !(s.value < s.mean)) return null;
  const worst = Math.round(s.value - HEALTH_SCORE_CAP_GAP);
  return `held down by ${wordOf(HEALTH_ENTRY_LABEL, s.cappedBy, "an entry this app version cannot name")}, at ${worst} of 100`;
}

/** A week with scores and no moves because it is the first one — an absence, so it stays open. */
export const FIRST_SCORED_WEEK_WORDS = "This is the first scored week; moves start the week after.";

/** A carried week has scores and no moves either; `carried` is `carriedWords(...)`. */
export function carriedNoMovesWords(carried: string): string {
  return `${carried.replace(/^./, (c) => c.toUpperCase())}; there are no moves to show.`;
}

/** The commit readout's spend clause: the ledger is per week, so it says so. */
export function commitSpendClause(spendWords: string, hasValue: boolean): string {
  return hasValue ? `${spendWords} that week` : spendWords;
}

/** In the fold, after the spend method: what the step line is in commits mode. */
export function spendStepNote(stepWords: string): string {
  return `In commits mode the dotted line is ${stepWords}.`;
}

/** Commits mode: points where a definition changed are not joined to the one before. Null for none. */
export function commitGapWords(count: number): string | null {
  if (!(count > 0)) return null;
  return count === 1
    ? "One commit is not joined to the one before: the engine's or this repo's definition changed there."
    : `${count} commits are not joined to the one before: the engine's or this repo's definition changed at each.`;
}

/** The commit readout's note on such a point. */
export const COMMIT_GAP_NOTE = "not compared with the commit before: a definition changed here";

/** The chart's accessible name, per x mode. */
export function scoreChartAria(mode: "weeks" | "commits", n: number, lo: number, hi: number): string {
  return `Health score over ${n} ${mode === "commits" ? (n === 1 ? "commit" : "commits") : (n === 1 ? "week" : "weeks")}, from ${Math.round(lo)} to ${Math.round(hi)}, on a 0 to 100 axis`;
}
