/**
 * Part of `assessRows.ts`, the barrel every caller imports — the unclear tally and the words a bulk confirmation puts in front of the tap.
 * Pure, and its imports carry `.ts` because `node --test` loads it straight off the source.
 * Map of the slices: docs/notes/assess-architecture.md.
 */
import { assessVerdictLabel, downgradeText, type AssessDowngrade, type AssessVerdict } from "@waterplane/shared";
import { ASSESS_SAMPLE, assessRetires, type AssessDisplayRow } from "./arowsDisplay.ts";
import { requeueWhereWords } from "./arowsAccept.ts";
import type { AssessMergeCard, AssessGroup } from "./arowsGroups.ts";

/** Sample rows are LABELS on a dialog, so they are the one place a clip is
 *  allowed. The row itself, two taps away, still holds the whole thing. */
const SAMPLE_CHARS = 90;

/**
 * The `unclear` strip, summarised by WHY.
 *
 * Twenty rows all reading "could not tell" is a wall; the same twenty split
 * into "six lost a claim for want of a citation" and "fourteen were never
 * mentioned" is a judgement about the run. The sentences are `downgradeText`'s,
 * because the host says it that way too.
 */
export function assessDowngradeTally(rows: readonly AssessDisplayRow[]): { down: AssessDowngrade; text: string; n: number }[] {
  const n = new Map<AssessDowngrade, number>();
  for (const r of rows) if (r.downgraded) n.set(r.downgraded, (n.get(r.downgraded) ?? 0) + 1);
  return [...n.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([down, count]) => ({ down, text: downgradeText(down), n: count }));
}

// ── The confirmations ───────────────────────────────────────────────────────

const sample = (s: string): string => {
  const one = (s || "").replace(/\s+/g, " ").trim();
  if (!one) return "“” (the words for this one are not on this phone)";
  return `“${one.length > SAMPLE_CHARS ? `${one.slice(0, SAMPLE_CHARS)}…` : one}”`;
};

/**
 * What a bulk accept puts in front of the user before it fires.
 *
 * The 84-row triage's rule, and the same danger: one tap over rows somebody
 * spent real work on. So it NAMES THE REPO and shows THREE REAL PROMPTS — a
 * person can check three sentences they recognise, and cannot check "31 rows" —
 * plus the sentence that makes the button allowed to exist at all, which is
 * that nothing is deleted.
 *
 * Composed here rather than in the sheet so it can be pinned: the words in
 * front of a destructive button are part of the safety, not decoration on it.
 */
export function assessBulkLines(
  rows: readonly AssessDisplayRow[],
  opts: { repoName: string; verdict: AssessVerdict },
): string[] {
  const n = rows.length;
  /** Counted off the rows the tap covers, never passed in: the dialog and the
   *  button are two readings of one set, and a second count is how they drift. */
  const k = rows.filter((r) => r.failed).length;
  const lines = [
    `${n} ${n === 1 ? "item" : "items"} in ${opts.repoName} — ${assessVerdictLabel(opts.verdict)}.`,
  ];
  lines.push(assessRetires(opts.verdict)
    ? "Nothing is deleted: each row keeps its words and the evidence it was retired on, dimmed rather than hidden, and one tap brings it back."
    // **The line that stopped being true when a bulk keep could revive rows.**
    // "This only sets the order they run in" is the whole promise a person is
    // checking, and over a strip of failed rows it is wrong in the direction
    // that matters: work starts again. So the count is named, what happens to
    // those k is said in the order it happens (back in the queue, one at a
    // time in this repo, and WHERE each one lands), and the two things that do
    // NOT happen — the failure is not wiped, nothing is retired — are said too,
    // because those are what a person is afraid of when a button revives
    // nineteen dead rows.
    : k
      ? `${k} of them failed: ${k === 1 ? "it goes" : "they go"} back in the queue and run${k === 1 ? "s" : ""} again when ${k === 1 ? "its turn comes" : "their turn comes"}, one at a time in this repo, ${requeueWhereWords(k === 1)}. The failure ${k === 1 ? "it" : "they"} had stays on the row. Nothing is retired and nothing is started now.`
      : "This only sets the order they run in. Nothing is sent and nothing is retired.");
  for (const r of rows.slice(0, ASSESS_SAMPLE)) lines.push(sample(r.text));
  if (n > ASSESS_SAMPLE) lines.push(`…and ${n - ASSESS_SAMPLE} more`);
  return lines;
}

/**
 * **The bulk button on a strip: what it says, and whether it exists at all.**
 *
 * `accept all` was the tap that produced the sentence this whole change comes
 * from — "just clicking accept for all I did see as I was not shown to really
 * understand". So the label names the verdict's own effect (`retire all 7` /
 * `keep all 3`), never the neutral word that covers both, and the title carries
 * the two facts a person needs BEFORE the tap rather than in the dialog after
 * it: the words survive, and a confirmation showing the repo and three real
 * prompts comes first (`assessBulkLines`).
 *
 * `null` where there is no such button, which is three cases and not one:
 * `merged` is approved card by card, `unclear` decided nothing, and a strip
 * whose rows are all blocked has nothing a bulk tap could cover. In every one
 * of them the strip's own text says why — a bulk control that refuses is a
 * greyed button by another name.
 *
 * With everything already ticked the same button un-ticks: it is the only place
 * a person who has changed their mind about a whole strip can say so in one
 * tap, and taking a mark OFF needs no confirmation because nothing is at stake
 * in it — `Apply` has still not run.
 *
 * **The dialog is worded HERE, off the same verb as the button.** It said
 * `Accept 7 “done” in myapp?` under a button reading `retire all 7`, which is
 * this whole change undone at the last screen before the tap: "accept" is the
 * word a person could not interpret, and meeting it again in the confirmation —
 * the one place the app is supposed to be most precise — teaches that the button
 * and the dialog are about two different things. One verb, one source: `VERB`
 * below builds the button's label and the dialog's title and primary, so they
 * cannot come apart.
 */
export interface AssessBulkWords {
  label: string;
  title: string;
  /** Whether the tap goes through `assessBulkLines` and a confirmation first. */
  confirm: boolean;
  /**
   * The confirmation's own title and primary — present exactly when `confirm`
   * is, and absent otherwise.
   *
   * A `wanted` strip with no failed rows still does not confirm: a confirm on a
   * harmless button is what teaches people to tap through the ones that matter,
   * and re-sorting a queue is harmless. A `wanted` strip that HOLDS failed rows
   * is not harmless — the tap puts work back on a desktop, which is the one
   * thing on this screen that starts anything — so it confirms, and the `Keep N`
   * words this comment used to say would never exist arrived with the flip,
   * exactly as it said they would.
   */
  ask?: { title: string; confirmLabel: string };
}

/** The verb a strip's bulk tap performs, said once. The button wears it in
 *  running prose and the dialog's two controls in leading caps; both start
 *  here, so "retire all 7" can never be confirmed with "Accept 7". */
const VERB = (g: AssessGroup): string => (g.retires ? "retire" : "keep");
const Cap = (s: string): string => s.slice(0, 1).toUpperCase() + s.slice(1);

export function assessBulkWords(g: AssessGroup, pickedInStrip: number, opts: { repoName: string }): AssessBulkWords | null {
  if (g.verdict === "merged" || g.verdict === "unclear") return null;
  if (!g.acceptable) return null;
  if (pickedInStrip >= g.acceptable) {
    return {
      label: `un-tick ${pickedInStrip}`,
      title: "take the marks off this strip — nothing has been applied yet, so nothing is undone",
      confirm: false,
    };
  }
  const verb = VERB(g);
  const n = g.acceptable;
  if (g.retires) {
    return {
      label: `${verb} all ${n}`,
      title: `mark all ${n} to be retired when you Apply — their words are kept with the reason on each row, and nothing is implemented. You are shown the repo and ${ASSESS_SAMPLE} of the items first.`,
      confirm: true,
      ask: {
        title: `${Cap(verb)} ${n} “${g.label}” in ${opts.repoName}?`,
        confirmLabel: `${Cap(verb)} ${n}`,
      },
    };
  }
  // **A keep that REVIVES is not a keep that re-sorts.** With failed rows on the
  // strip this one tap puts `k` pieces of work back on a desktop, so it earns
  // the confirmation the plain re-sort deliberately does not get — and the
  // dialog names both numbers, because "Keep 19" over a repo whose nineteen rows
  // are all dead is the reading that hides the whole effect.
  const k = g.failed;
  if (k) {
    return {
      label: `${verb} all ${n}`,
      title: `keep all ${n} and give them the order the run proposes — ${k} of them failed and ${k === 1 ? "is" : "are"} put back in the queue to run again when ${k === 1 ? "its turn comes" : "their turn comes"}, one at a time in this repo, ${requeueWhereWords(k === 1)}; nothing is started now and nothing is retired`,
      confirm: true,
      ask: {
        title: `${Cap(verb)} ${n} in ${opts.repoName} — put ${k} back in the queue?`,
        confirmLabel: `${Cap(verb)} ${n}`,
      },
    };
  }
  return {
    label: `${verb} all ${n}`,
    title: `keep all ${n} and give them the order the run proposes — nothing is started and nothing is retired`,
    confirm: false,
  };
}

/**
 * What approving one merge puts in front of the user.
 *
 * The card above the button already shows the new prompt and all N originals in
 * full; this is the last sentence before the tap, so it says the one thing the
 * card cannot say by existing — that this replaces words a person wrote with
 * words they did not.
 */
export function assessMergeLines(card: AssessMergeCard, opts: { repoName: string }): string[] {
  const n = card.originals.length || card.ids.length;
  const lines = [
    `One new prompt replaces ${n} ${n === 1 ? "item" : "items"} in ${opts.repoName}.`,
    "The prompt below was written by the assessment, not by you. The items it replaces are retired with a reason and keep their words.",
    sample(card.prompt),
  ];
  for (const r of card.originals.slice(0, ASSESS_SAMPLE)) lines.push(`replaces ${sample(r.text)}`);
  if (card.originals.length > ASSESS_SAMPLE) lines.push(`…and ${card.originals.length - ASSESS_SAMPLE} more`);
  if (card.missingIds.length) {
    lines.push(`${card.missingIds.length} of the items it names ${card.missingIds.length === 1 ? "is" : "are"} not on this phone, so ${card.missingIds.length === 1 ? "its words are" : "their words are"} not shown above.`);
  }
  return lines;
}

// ── What this screen IS ─────────────────────────────────────────────────────
