/**
 * Whose title is on a row, and *name these N*.
 *
 * Part of `backlogFilter.ts`, the barrel every caller imports. Pure, and its
 * imports carry `.ts` because `node --test` loads it straight off the source.
 */
import type { BacklogItem, NameAuthor } from "@waterplane/shared";
import { itemHeadline } from "@waterplane/shared";

/**
 * ── Whose title is on this row ───────────────────────────────────────────────
 *
 * **A title is the one string here a MACHINE wrote over words a person wrote**,
 * and the author is the whole of what makes that acceptable: a name that cannot
 * say who wrote it cannot say whether it may be replaced. `naming.ts` keeps the
 * pair together on the wire; this is the pair said out loud on the row.
 *
 * As VISIBLE TEXT, never only a `title` — `Unavailable.tsx`'s rule, and this is
 * exactly the case it exists for: on the one device this app is used from, "a
 * model wrote the line you are reading" said in a tooltip is not said at all.
 *
 * `hand` is the person's own, and it is here for completeness rather than for
 * the row: a typed name needs no attribution, because the person reading it is
 * the person who typed it. It is worded anyway so that a surface that DOES want
 * to say it has one wording to say it in.
 */
export const HEADLINE_BY_WORDS: Record<NameAuthor, string> = {
  hand: "you typed this title",
  assess: "titled by the assessment",
  name: "titled by the naming pass",
};

/**
 * **What saving the title field does that no later pass can undo** — the edit
 * form's hint, under the one input on this sheet that a machine also writes to.
 *
 * Here and not inline in `Backlog.tsx` for this file's usual reason, with one
 * specific to it: this sentence is a PROMISE about the host's `hand` stamp
 * (`naming.ts`), and a promise nothing pins is a promise that goes stale the
 * first time the stamp's rule is edited. Every other sentence on this sheet is
 * already here; these two were the exception, and the exception was the pair
 * making the strongest claim.
 *
 * Two wordings for two states, never one sentence with a tense that covers
 * both: on a row already stamped `hand` the protection is a FACT and saying
 * *saving makes it yours* would offer a person something they already have; on
 * a suggestion it is a CONSEQUENCE, and it is the half of the save that matters
 * — the title is no longer in reach of an assessment or a naming pass.
 *
 * **Both halves say the way back**, because that is what makes the consequence
 * a cheap one: emptying the field clears the title AND its author, which is
 * "nobody has said" rather than "a person said nothing", so a later pass may
 * name the row again.
 */
export function headlineEditHint(headlineBy?: NameAuthor): string {
  return headlineBy === "hand"
    ? "this title is yours — the assessment and the naming pass will not change it."
      + " Clear the field to let them suggest one again."
    : "saving makes it yours — the assessment and the naming pass will not change it again."
      + " Clear the field to let them suggest one again.";
}

/**
 * ── `name these N` — the bulk verb that asks for titles ──────────────────────
 *
 * A hand-written backlog row has no title and no kind, and **nothing derives
 * one for it**, because nothing in this app applies itself. Fifty-two rows of
 * first-lines-of-prose is the list this whole file was written against, and the
 * two questions a reader could not answer by looking — how old, and where are
 * the failures — have a third beside them now: what KIND of thing is each of
 * these.
 *
 * This is the tap that asks. It is `assessScopeLabel`'s shape and follows
 * `assessScopeLabel`'s rule — **a count on a control is a filter**, so the
 * number is the nameable rows in the cut ON SCREEN and the pass is asked about
 * exactly those.
 *
 * It is deliberately NOT a `ConfirmButton`. Naming destroys nothing: it writes
 * a title where there was none, never over one somebody typed, and any of them
 * is one tap to edit or clear on the row. A confirm on a harmless button is
 * what teaches people to tap through the ones that matter — `assessRows.ts`
 * says the same thing about its own bulk buttons.
 */
export function nameLabel(n: number): string {
  return `name ${n === 1 ? "this one" : `these ${n}`}`;
}
/**
 * Which rows a naming pass has anything to do — `assessableInCut`'s shape, and
 * the same reason for having it: the number on the button must be the number
 * the pass will touch, or the bar is describing a different list than the tap.
 *
 * Three conditions, and the third is the one worth stating. A row is nameable
 * when it is still MISSING a field a machine may write: no title at all
 * (`itemHeadline` is the ONE display rule, so a label somebody typed counts as
 * a title and a truncation of the row's own prose does not), or no kind. A row
 * that has both is left alone — re-titling it would be the pass overwriting its
 * own earlier answer, and re-titling a typed one is the thing the author stamp
 * exists to forbid.
 *
 * `queued`/`failed` and not archived, for `assessableInCut`'s reason: those are
 * the rows the list is actually about. A finished row is a record, and paying a
 * model to title the record of something that is over is money for nothing.
 */
export function nameableInCut(
  items: readonly Pick<BacklogItem, "id" | "text" | "label" | "status" | "archived" | "headline" | "category">[],
): string[] {
  return items
    .filter((it) => !it.archived && (it.status === "queued" || it.status === "failed")
      && (itemHeadline(it) === null || !it.category))
    .map((it) => it.id);
}
/**
 * What the tap leaves alone, and what it costs.
 *
 * `dropClocksNote`'s rule decides the shape — **never describe a remainder that
 * is not there** — and its reason: a clause about rows nobody can see invites a
 * reader to go looking for them.
 */
export function nameNote(n: number, shown: number): string {
  const head = n === shown
    ? `all ${shown} rows here need a title or a kind`
    : `${n} of the ${shown} shown need a title or a kind — the rest have both, or are running, finished or set aside`;
  // One clause, not three. Everything this leaves alone is identifiable on
  // screen by its own chip, which is what lets a reader check the number
  // against the list rather than take the sentence's word for it.
  // The protection, said where the tap is: it is the only thing standing
  // between a naming run and words somebody typed, and a person deciding this
  // has nowhere else to learn it.
  //
  // **Short on purpose.** This bar is drawn over every backlog, so its words are
  // chrome above the list on the one screen whose whole job is the list — the
  // long form measured 213 px of a 850 px phone. One clause per fact, and the
  // rest of the promise lives on the row it is about (`HEADLINE_BY_WORDS`, the
  // edit form's hint), where a person is deciding about one title rather than
  // about a number.
  return `${head}. Nothing you typed is replaced.`;
}
/**
 * …and what it SPENDS, because this is one of the app's automatic-looking
 * buttons and the person tapping it is the person paying for it.
 *
 * It says what the pass READS as well as what it runs on: a naming pass sees
 * the items' own words and nothing else — no repo, no git, no tools — which is
 * both why it is cheap and why it cannot be wrong about anything but a title.
 */
export const NAME_COST_NOTE =
  "one short toolless call on the cheap model — reads the items' own words and nothing else";
/**
 * Why the verb is ABSENT rather than dimmed while a pass is going.
 *
 * `Unavailable.tsx`'s rule. A second pass over the same repo would be the same
 * money for the same answer, and the rows it is working on are already saying
 * so themselves — this is the sentence that replaces the button, never a
 * greyed-out copy of it with the reason in a `title`.
 */
export const NAME_RUNNING_NOTE = "a naming pass is already running for this repo";
/**
 * What the row says back. **One tap, one receipt** — `dropClocksToast`'s rule:
 * the wire sends one `backlog.name`, and the SENTENCE is where the count lives.
 *
 * It takes the BUTTON's own label rather than a count, so the receipt says the
 * verb that was tapped and there is no second spelling of the number to drift
 * (`dropClocksToast` is the same trick one verb along). And it promises the
 * queue, never the result: the pass is a call the desktop has yet to make, so
 * "titled" would be a claim about something that has not happened.
 */
export function namingToast(sentence: string): string {
  return `asked the desktop to ${sentence} — the titles land on the rows as the pass answers, `
    + "and anything you typed yourself is left alone";
}
