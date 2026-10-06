/**
 * Part of `assessRows.ts`, the barrel every caller imports — the row a person reads: its type, the retiring verdicts and the sample size.
 * Pure, and its imports carry `.ts` because `node --test` loads it straight off the source.
 * Map of the slices: docs/notes/assess-architecture.md.
 */
import type { AssessDowngrade, AssessRow, AssessSource, AssessVerdict, ItemCategory } from "@waterplane/shared";

/** How many of the real prompts a confirmation shows. `activityRows.ts`'s
 *  number, for its reason: three is enough to recognise the set, and few enough
 *  to read on a phone above the button. */
export const ASSESS_SAMPLE = 3;


/**
 * The verdicts that TAKE something away.
 *
 * They open expanded, and their bulk button is confirmed. The other two change
 * nothing a person would want back — `wanted` moves a sort position and
 * `unclear` is the verdict that means no decision was reached — so they start
 * collapsed and are never behind a destructive dialog. A confirm on a harmless
 * button is what teaches people to tap through the ones that matter.
 */
const RETIRING: readonly AssessVerdict[] = ["done", "obsolete", "superseded", "merged"];

export function assessRetires(v: AssessVerdict): boolean {
  return RETIRING.includes(v);
}

// ── One row ─────────────────────────────────────────────────────────────────

/** One assessed item, with everything the sheet needs to draw it and nothing
 *  it would have to re-derive. */
export interface AssessDisplayRow {
  id: string;
  verdict: AssessVerdict;
  /** Which store the words live in. Decides what applying can even mean. */
  source: AssessSource;
  /** The user's own words, in FULL. Empty only when `missing`. */
  text: string;
  /**
   * This device could not find the item the verdict is about.
   *
   * Never a reason to hide the row — a verdict on words we cannot show is
   * exactly the thing a person needs told — and always a reason to refuse the
   * tap (`assessAcceptBlocker`): the row and the host read ONE record, so an id
   * this list has no words for is an id `applyAssessment` skips.
   */
  missing: boolean;
  /**
   * **The item this verdict is about had FAILED**, read off `AssessItem.state`.
   *
   * It is not decoration and it is not a status chip: it is what tells a row
   * that can be RANKED from a row that has to be PUT BACK. A `still wanted`
   * verdict on a `queued` row is a position in an order the row is already in;
   * the same verdict on a `failed` row is about a row the ladder never looks at
   * again, where a position alone changes nothing anybody could observe — and
   * this sheet meanwhile promised "position 1 in the order". Measured on the
   * desktop this was written on: 0 queued, 19 failed, so that promise was the
   * only one the screen could make and it was empty.
   *
   * `applyAssessment` reads the very same field to decide between `rank` and
   * `requeue`, which is why this is read off the ITEM and never inferred here:
   * the phone must not word a fact differently from the host.
   *
   * False for a pad note (a note carries no lifecycle), false for a row whose
   * words this device does not hold, and false on every host that predates the
   * field — which is the behaviour every apply had before a failed row could be
   * put back at all.
   */
  failed: boolean;
  label?: string;
  /**
   * **What the RUN says this row should be called** — its title and its kind,
   * straight off `AssessRow` and never merged with what is already on the item.
   *
   * They are a proposal like every other number on this screen: the row draws
   * them so a person can see what would be written, and the one switch at the
   * end of the scroll decides whether any of it is (the footer's Apply label
   * restates the answer). Either half may be absent, and absent
   * means the run said nothing — never a default kind, for `naming.ts`'s
   * reason.
   */
  headline?: string;
  category?: ItemCategory;
  /** `assessVerdictLabel(verdict)` — the pill. */
  verdictLabel: string;
  /** `assessRowSentence(row)` — the finished sentence, rendered verbatim. */
  sentence: string;
  /** Set when the pure layer overrode the CLI. The sentence already SAYS so;
   *  this is what lets the row be marked as well as worded. */
  downgraded?: AssessDowngrade;
  rank?: number;
  supersededBy?: string;
  /** The words of the item said to cover this one, so the claim can be checked
   *  without leaving the sheet. */
  supersededByText?: string;
  gid?: string;
  /**
   * Why accepting this row would do nothing — `null` when it would do
   * something.
   *
   * A string rather than a boolean, `ActivitySheet`'s rule: a control cannot be
   * greyed out without saying why, and all four cases here are surprising
   * enough to need the sentence (the words are not on this phone and neither end
   * would apply them; a merge is one decision about all N; `unclear` decided
   * nothing; a pad note has no place in an order).
   */
  acceptBlocked: string | null;
  /** The proposal's own row, untouched, for anything that needs the raw fields. */
  row: AssessRow;
}
