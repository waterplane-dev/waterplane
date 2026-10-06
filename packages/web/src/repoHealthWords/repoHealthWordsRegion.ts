// A slice of the repo-health words (../repoHealthWords.ts is the facade; docs/notes/webclient-architecture.md).
import { nf } from "./repoHealthWordsFmt.ts";
import { seriesValueWords } from "./repoHealthWordsRank.ts";

/** The dumbbell's caption. Two numbers per area, and the gap between them is
 *  the subject. */
export function areaSpreadWords(): string {
  return (
    "Per area, on the latest reading: what a change there usually carries (CLAUDE.md, every " +
    "description, the router and the sub-skills that commit's own files claim) and what it carries " +
    "with every one of that area's bodies loaded. Re-partitioning moves the near end and cannot move " +
    "the far one; deleting prose moves both."
  );
}

/**
 * One area's row, in words, for the readout beside its bar.
 *
 * The area's OWN `reason` wins over the sentence this would guess. Two ways
 * to have no `expected` printed as one: an area nobody has committed to (one
 * commit fixes it) and an area whose router names no source group, where no
 * commit can EVER be attributed. The metric knows which; this knows nulls.
 */
export function areaRowWords(a: {
  expected?: number | null;
  ceiling?: number | null;
  p90?: number | null;
  commits?: number | null;
  subs?: number | null;
  reason?: string;
}): string {
  const parts: string[] = [];
  if (a.expected != null) parts.push(`usually ${seriesValueWords(a.expected)} chars`);
  else if (a.reason) parts.push(a.reason);
  else parts.push("no commit has touched this area yet, so there is no usual load");
  if (a.ceiling != null) parts.push(`up to ${seriesValueWords(a.ceiling)}`);
  if (a.p90 != null) parts.push(`p90 ${seriesValueWords(a.p90)}`);
  if (a.commits != null) parts.push(`over ${nf(a.commits)} commit${a.commits === 1 ? "" : "s"}`);
  if (a.subs === 0) parts.push("no sub-skills, so the two ends are one number");
  else if (a.subs != null) parts.push(`${nf(a.subs)} sub-skill${a.subs === 1 ? "" : "s"}`);
  return parts.join(" · ");
}

/**
 * What this region deliberately does NOT draw, and why.
 *
 * Said once, at the foot, because an absence a reader cannot see is an absence
 * they will assume was an oversight — and the two reasons are different.
 * Tripwires are events, not series: a file crossing a line happens on one day
 * and has no trailing shape. The path lists (co-change, duplicate pairs,
 * untested modules, dead exports, re-touch offenders) are names, and their top
 * three already ride in the sentence under the reading they belong to. The two
 * remaining rates have no rank from the tool, and a curve under them would
 * invite the reader to supply one.
 */
/**
 * What the numbers table is, and why it runs the way the charts do.
 *
 * `tail` is how many readings it shows, `total` how many exist — a table that
 * says "the last 14" without saying "of 157" is a table a reader cannot tell
 * is a window.
 */
export function readingsTableWords(tail: number, total: number): string {
  // DAY-ROWS, not "readings": a day whose p95 went unread still has a row here
  // and prints an em-dash in that column, while the percentile above counts
  // only the days that read something. One word for two counts on one screen
  // is how a reader concludes the table and the tile disagree.
  return (
    `The last ${nf(tail)} day-rows of ${nf(total)}, oldest first — the same direction the charts run, so a ` +
    `row and a column of pixels above it are the same day. Every figure here is drawn somewhere above; ` +
    `this is the copy that can be read without touching anything, and the only one that shows two days at once.`
  );
}

export function notPlottedWords(): string {
  return (
    "Not on these charts: the tripwires, which are events on one day rather than a series; the path " +
    "lists, whose first three ride in the sentence under the reading they belong to and the rest in " +
    "the narrative below; and the duplicate-block and co-change rates, which the tool reads without a " +
    "rank — a curve under them would invite a reading nothing measured."
  );
}

/**
 * A mixed series is still DRAWN, and the chart says so.
 *
 * The refusal band above already argues the case and quotes the remedy. What
 * this adds is why the charts underneath it are still painted: refusing to
 * draw would remove the only view of the problem, which is the one thing a
 * person on a phone can act on. The rows on disk are what is plotted, and the
 * caption names how many definitions are mixed into them.
 */
export function mixedPlotWords(versions: readonly { version: string; rows: number }[] | null | undefined): string | null {
  const list = versions ?? [];
  if (list.length < 2) return null;
  return (
    `These charts plot the rows as they are on disk, under ${list.length} definitions of the same ` +
    "metric. Nothing here re-cuts or re-reads them: refusing to draw would remove the only view of " +
    "the problem the band above describes."
  );
}

/**
 * The verb on a series row. It opens a prompt; it changes nothing.
 *
 * It names the QUESTION, not the recipient. "ask the agent about this" said
 * who would be asked and nothing about what — and the prompt behind it opened
 * with *explain what is behind this reading*, so what arrived was an
 * explanation of the measurement. A control says what it does, and what this
 * one does is ask whether the thing the reading is OF is serving the repo.
 *
 * Constrained by the verdict-word ban this file is under (the test's list
 * includes this constant), which is why it is not "ask if this should change":
 * `should` is a verdict word on a screen that has no side to be on. The
 * question a prompt may ask and the words a screen may print are different
 * rules, and this string is subject to the screen's.
 */
export const SERIES_ASK_LABEL = "ask if this is serving the repo";

/**
 * The verb under the whole set, which asks a question no row can.
 *
 * A row's prompt carries one reading and nothing else, deliberately: it is
 * that number against its own past. The question a reader actually arrives
 * with is usually the CROSS one — the p95 flat while the re-touch rate falls,
 * duplication absent on a tree whose file count doubled — and it cannot be
 * assembled from ten separate prompts, because no one of them knows the other
 * nine exist. So the set gets a verb of its own, carrying every reading, the
 * absences with their reasons, and which engine read the tree.
 *
 * It refers BACK to the row's verb rather than restating the question. Two
 * labels each phrasing the question their own way is two questions, drifting
 * apart at the next edit, and the reader has no way to tell which one they are
 * about to ask.
 */
export const SERIES_ASK_ALL_LABEL = "ask this of all of them";

/** Under the series rows, once: what that verb is and is not. The setup half
 *  of this sheet patches; this half does not, and the difference is the whole
 *  reason the two regions are separate. */
export function seriesAskNoteWords(): string {
  return (
    "A reading is not a finding: there is no line here to be on the wrong side of, so nothing on " +
    "these charts is counted into the badge and nothing offers a fix. The verb on a row opens a " +
    "prompt about the thing the reading is OF — the skills, the files, the tests — asking whether " +
    "it suits the work in this repo and what you would change, with the tool's own sentence quoted " +
    "as the thing that prompted the question. Leaving it alone is one of the answers. The verb " +
    "under all of them carries every reading at once, the absences and their reasons included, and " +
    "asks which of them move for the same reason. Nothing is sent by the tap."
  );
}

/** The two regions, named by their COMPARATOR — which is the only thing that
 *  separates them, and the thing a reader has to have to read either. */
export function regionWords(region: "setup" | "series"): string {
  return region === "setup"
    ? "Against the conventions: each row compares a fact about this repo to a line somebody chose, so it can be on the wrong side of it. That is what a finding is, and what the badge counts."
    : "Against its own past: each reading compares a fact about this repo to the same fact on earlier commits. There is no side to be on, so nothing here has a status, a colour or a place in the badge.";
}
