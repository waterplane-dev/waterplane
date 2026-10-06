/** A slice of assess.ts — moved whole from assess.ts, see docs/notes/shared-architecture.md. */
import type { ItemCategory } from "../naming.js";
import { type AssessVerdict } from "./sassvocab.js";
import { type AssessDowngrade, type AssessProposal, type AssessRow } from "./sassio.js";

// ── The sentences ────────────────────────────────────────────────────────────

/**
 * The ONE place a verdict becomes a word.
 *
 * `clihealth.ts`'s rule: the phone's row and the host's stored reason must not
 * word one fact two ways, or "already done" and "done" become two categories in
 * a list a person is scanning for the one row they disagree with.
 */
export function assessVerdictLabel(v: AssessVerdict): string {
  switch (v) {
    case "done": return "already done";
    case "obsolete": return "no longer applies";
    case "superseded": return "covered by another item";
    case "merged": return "merged with others";
    case "wanted": return "still wanted";
    case "unclear": return "could not tell";
  }
}

/** Why the pure layer overrode the CLI, in words. */
export function downgradeText(d: AssessDowngrade): string {
  switch (d) {
    case "no-evidence": return "left undecided: nothing was cited to back that up";
    case "unknown-verdict": return "left undecided: the verdict was not one this app knows";
    case "duplicate": return "left undecided: it was given more than one verdict";
    case "unmentioned": return "left undecided: the assessment did not mention it";
    case "supersede-unknown": return "left undecided: it points at an item that was not in the list";
    case "supersede-self": return "left undecided: it points at itself";
    case "supersede-cycle": return "left undecided: the chain of items it points at comes back round";
    case "merge-conflict": return "left undecided: more than one outcome claimed it";
    case "merge-dropped": return "left undecided: the merge it was part of did not stand";
    case "merge-unknown": return "left undecided: it names a merge that does not exist";
  }
}

/** The finished sentence for one row — verdict, why, and what backs it. A UI
 *  renders it as is and must not re-weave it. */
export function assessRowSentence(row: AssessRow): string {
  const tail = row.evidence ? ` — ${row.evidence}` : "";
  if (row.downgraded) return `${downgradeText(row.downgraded)}${tail}`;
  if (row.verdict === "superseded" && row.supersededBy) {
    return `${assessVerdictLabel("superseded")} (${row.supersededBy})${tail}`;
  }
  return `${assessVerdictLabel(row.verdict)}${tail}`;
}

/**
 * The reason a dismissed row carries, forever, where the row is rendered.
 *
 * `intoId` is the intent id the merge was posted as, which the pure layer
 * cannot know — the host calls this a second time once it does, rather than
 * assembling its own sentence, so the merged row and the sheet say the same
 * thing.
 */
export function assessDismissReason(v: AssessVerdict, evidence: string, intoId?: string): string {
  const tail = evidence ? ` — ${evidence}` : "";
  if (v === "merged") return `merged into ${intoId ? intoId : "one new item"}${tail}`;
  return `${assessVerdictLabel(v)}${tail}`;
}

/** How many rows each verdict claimed — what a header says before anybody
 *  scrolls. */
export function assessCounts(p: AssessProposal): Record<AssessVerdict, number> {
  const out = { done: 0, obsolete: 0, superseded: 0, merged: 0, wanted: 0, unclear: 0 };
  for (const r of p.rows) out[r.verdict]++;
  return out;
}

/**
 * **How many things this run has something to CALL** — the number the naming
 * question is asked about.
 *
 * One per row, group or new item carrying a title or a kind, counted once
 * whichever of the two it has: the question is "should these names be written",
 * and a row with both is still one row a person is deciding about. Merges and
 * new items are in the count for the same reason they are in the sheet — they
 * are rows this apply will create, and a person reading "titles 14 items" must
 * not find 16.
 */
export function assessNameCount(p: AssessProposal): number {
  const has = (x: { headline?: string; category?: ItemCategory }): boolean => !!x.headline || !!x.category;
  return p.rows.filter(has).length + p.merges.filter(has).length + p.news.filter(has).length;
}

// ── Applying ─────────────────────────────────────────────────────────────────

/**
 * What the user approved. Absent means absent: nothing here applies itself, so
 * an empty set of choices decides nothing at all.
 */
export interface AssessChoices {
  /** Row ids whose verdict was accepted. */
  rows?: readonly string[];
  /** Merge group ids approved — one decision about all N members. */
  merges?: readonly string[];
  /** Indices into `proposal.news`. */
  news?: readonly number[];
  /**
   * **Does the order you just approved stay put, or may the smart pick re-sort
   * it?** Asked at apply time, because only the person applying knows.
   *
   * An assessment ranks the wanted set, and applying writes that rank as each
   * row's `order`. The smart pick then re-sorts the repo's waiting items before
   * each one fires — and it leaves alone exactly the rows marked as placed by a
   * person. An applied rank was not marked, so until this field existed a
   * ranking somebody had read sixty-two verdicts to approve was re-decided by a
   * cheap toolless pass that had seen only the item text.
   *
   * Neither answer is right in general, which is why it is a question rather
   * than a default: a ranking you worked through row by row is usually the more
   * considered of the two, but a repo where the smart pick is doing the
   * day-to-day grooming wants its ordering to keep breathing.
   *
   * Absent is false — the behaviour every apply had before the question
   * existed, so an older client applying a proposal changes nothing.
   */
  pinRanks?: boolean;
  /**
   * **Do the run's titles go on the rows, or stay on this sheet?** Asked at
   * apply time for `pinRanks`' reason: only the person applying knows whether
   * they want a machine's words at the top of their own list.
   *
   * Neither answer is obviously right. A titled backlog is scannable in a way a
   * wall of first lines is not; a title a model wrote is also the one string on
   * the row that nobody checked, sitting where a reader looks first. What is
   * never in question is the typed half — a `label` a person wrote is never
   * replaced by this, whatever the answer.
   *
   * Absent is false — the behaviour every apply had before the question
   * existed, so an older client applying a proposal changes nothing.
   */
  writeNames?: boolean;
}

/**
 * **The question the apply asks about the order it is about to write**, and the
 * two answers, worded so neither reads as the safe one.
 *
 * Here rather than in the sheet because the host says the same thing back on
 * the row (`applyProposal`'s `handOrdered`) and a second wording of one fact is
 * how two screens come to disagree about what was decided.
 *
 * `pinLabel` deliberately does not say "keep" alone: what is kept is the ORDER,
 * and the thing it is kept from is the smart pick, which the person may not
 * have in mind while reading sixty-two verdicts.
 */
export function assessPinQuestion(n: number): string {
  return `This applies an order to ${n === 1 ? "1 item" : `${n} items`}. Should it stay as you approved it?`;
}
export const ASSESS_PIN_KEEP = "keep this order";
export const ASSESS_PIN_FREE = "the smart pick may re-sort it";
/**
 * …and what each answer means, since the consequence is not on either label.
 *
 * The smart pick is only mentioned as a thing that *may* re-sort: it runs
 * before each item fires and only in repos where it is switched on, so a
 * sentence promising it *will* would be wrong in most repos, and one that never
 * named it would leave "why did my order move" unanswerable.
 */
export function assessPinNote(pinned: boolean): string {
  return pinned
    ? "Marked as placed by you, the way a drag is — the smart pick sorts around these and never moves them."
    : "Left free: the smart pick may re-order these before an item fires, the same as any row you have not placed yourself.";
}

/**
 * **The question the apply asks about the titles it is about to write**, and
 * the two answers — `assessPinQuestion`'s shape, for the same reason it has
 * that shape: the sheet and the host must not word one decision two ways.
 *
 * It names both halves of what a name is, because the row shows both and a
 * question that said only "titles" would be asking about half of what the tap
 * does.
 */
export function assessNameQuestion(n: number): string {
  return `This run wrote a title or a kind for ${n === 1 ? "1 item" : `${n} items`}. Should they go on the rows?`;
}
export const ASSESS_NAME_WRITE = "write them";
export const ASSESS_NAME_SKIP = "leave the rows as they are";
/**
 * …and what each answer means.
 *
 * The write side says the protection out loud because it is the only thing
 * standing between a naming run and words somebody typed, and a person deciding
 * this has no other place to learn it. It also says the names are EDITABLE,
 * since the honest reason to say yes is that a wrong title costs one tap.
 *
 * The skip side does not say "nothing happens": the suggestions are still on
 * the sheet, and a person who wanted them somewhere else needs to know they did
 * not evaporate.
 */
export function assessNameNote(write: boolean): string {
  return write
    ? "Written as the run's — a title or kind you typed yourself is never replaced, and you can edit or clear any of them on the row."
    : "Nothing is titled. The suggestions stay on this sheet only.";
}