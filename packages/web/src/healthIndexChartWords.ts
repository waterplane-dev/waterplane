/**
 * The Score card's own short words (`HealthIndexChart.tsx`): the hero's
 * one-line cap, the bars' two-swatch legend, the fold's summary and the
 * first-scored-week absence. Pure (`healthIndexChartWords.test.mjs`, which
 * holds them to the index's verdict-word ban). The longer sentences stay in
 * `healthIndexWords.ts` / `healthSpendWords.ts`.
 */
import { HEALTH_ALERT_WARN, HEALTH_ENTRY_LABEL, HEALTH_SCORE_CAP_GAP, wordOf, type HealthCapKind, type HealthEntry } from "@waterplane/shared";

/** Beside the hero number. */
export const OUT_OF_100 = "out of 100";

/** The fold under the Score card holding every method sentence. */
export const HOW_SCORED_SUMMARY = "how this is scored";

/** The bars' two swatches. */
export const BAR_UP_WORDS = "pushed the score up";
export const BAR_DOWN_WORDS = "pulled it down";

/**
 * The cap as ONE line beside the hero: `held down by file length, at 16 of 100`,
 * `held at 60 by what could not be measured`, `held under 50 by a failing gate`.
 * Null when no cap set the number. The full sentence is shared
 * `healthHeadlineWords().cap`, in the open under the hero.
 */
export function heldDownWords(s: {
  value: number; mean: number; cappedBy: HealthEntry | null;
  capKind?: HealthCapKind | null; coverage?: { measured: number; applicable: number } | null;
}): string | null {
  if (s.capKind === "gate") return `held under ${HEALTH_ALERT_WARN} by a failing gate`;
  // The ratio and the unknown dimensions are the coverage line's, right below: not said twice.
  if (s.capKind === "coverage" && s.coverage) return `held at ${Math.round(s.value)} by what could not be measured`;
  if (!s.cappedBy || !(s.value < s.mean)) return null;
  const worst = Math.round(s.value - HEALTH_SCORE_CAP_GAP);
  return `held down by ${wordOf(HEALTH_ENTRY_LABEL, s.cappedBy, "an entry this app version cannot name")}, at ${worst} of 100`;
}

/** In the fold: how coverage and gates bound the score (shared `healthindex/coverage.ts` argues the rule). */
export const COVERAGE_METHOD_WORDS =
  `A dimension counts as measured only when the readers for this repo's languages cover at least four fifths of its source files; ` +
  `an unmeasured one counts for nothing, never for 100, so the score is at most 100 × measured ÷ applicable, and an unmeasured entry is left out of the average. ` +
  `A reading the repo marks as a gate in its health.json holds the score under ${HEALTH_ALERT_WARN} while it fails; a gate with no reading counts as unmeasured.`;

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
