/**
 * *drop the clock* and the chips that sit beside it: the host hold, the budget waiver.
 *
 * Part of `backlogFilter.ts`, the barrel every caller imports. Pure, and its
 * imports carry `.ts` because `node --test` loads it straight off the source.
 */
/**
 * The schedule vocabulary's *wait until it's free*, on a backlog row.
 *
 * The host-wide half (`holdForHost`): nothing else on this desktop may be
 * starting or running. Worth its own chip because it is the one wait a reader
 * cannot infer from the list they are looking at — `serial` ("one at a time in
 * this repo") is on every repo item by construction and is what the list's own
 * order already shows, while this one is about eleven other repos.
 */
export const HOLD_FOR_HOST_TEXT = "holds until the desktop is free";
/**
 * …and the half of it that was only ever in a `title`.
 *
 * **A `title` is invisible on a phone**, which is the only device this app is
 * used from — the rule `Unavailable.tsx` exists to enforce. "Dropping the clock
 * does not drop the hold" is something a person needs before they tap *drop the
 * clock*, and it lived nowhere else, so on the one device that matters it was
 * not said at all. It is a clause on the chip now, drawn only where the
 * question can arise: a row with a clock AND a hold, in a state where the verb
 * is offered.
 */
export function holdChipWords(dropOffered: boolean): string {
  return dropOffered ? `${HOLD_FOR_HOST_TEXT} · survives a dropped clock` : HOLD_FOR_HOST_TEXT;
}
/**
 * **A row a person let past the usage budget** (`BacklogItem.pastBudget`, set
 * by the re-time sheet's *let past the budget*). It lifts the budget and
 * nothing else — the row still waits its turn — so the chip says the waiver,
 * and its tap is the undo: `intent.waive` with `on: false`. `· undo` is TEXT on
 * the chip, drawn only where the tap can reach the desktop; the title repeats
 * it for a pointer, never instead of it.
 */
export const PAST_BUDGET_CHIP = "let past the budget";
export const PAST_BUDGET_TITLE =
  "you let this past the usage budget — it still waits its turn; tap to hold it for the budget again";
export function pastBudgetChipWords(online: boolean): string {
  return online ? `${PAST_BUDGET_CHIP} · undo` : PAST_BUDGET_CHIP;
}
export const PAST_BUDGET_UNDONE_TOAST = "held for the budget again";
export const HOLD_FOR_HOST_TITLE =
  "it waits for nothing else to be starting or running anywhere on this desktop — not just in this repo. "
  + "This is the schedule vocabulary's “wait until free”, and dropping the clock does not drop it";

/**
 * **`drop the clock` — what the verb promises, worded for the state it is in.**
 *
 * The two states are two different offers and must not share a sentence:
 *
 *  - **failed.** The instant went by while the desktop was asleep, and a
 *    one-off cannot be re-armed — so the row is stuck saying it missed
 *    something for ever. Dropping the clock makes it an ordinary queued item,
 *    which is what it always was apart from the instant. This is the tap that
 *    answers "I want to run the seven things that were skipped".
 *  - **queued.** The clock has not passed; the person is choosing to run it in
 *    turn rather than at its time. Nothing is being rescued, so the sentence
 *    must not read like a rescue.
 *
 * Neither wording says the words will run NOW: `auto`, `serial` and the repo's
 * own order decide that, and a promise this button cannot keep is the failure
 * every sentence in this file is written against.
 */
export function dropClockTitle(status: "queued" | "failed"): string {
  return status === "failed"
    ? "its instant has passed — drop the clock and it waits its turn like any other item (auto and the smart pick take it from there)"
    : "run it in turn instead of at its time — the clock goes, the words and their place in the list stay";
}
/**
 * **The same two offers, as TEXT on the row — because that is where a phone can
 * read them.**
 *
 * `dropClockTitle` is a `title`, and a title is invisible on a phone. The
 * clause it carried that a person cannot work out for themselves is what
 * happens AFTER the tap — *auto and the smart pick take it from there* — which
 * is the entire answer to "how do I run the seven that were skipped". Said in a
 * title, on this device, it was not said.
 *
 * One string for both homes: the visible note and the button's `title` read the
 * same sentence, so there is no second copy of the claim to drift.
 */
export function dropClockNote(status: "queued" | "failed"): string {
  return status === "failed"
    ? "its instant has passed and a one-off cannot be re-armed — drop the clock and it waits its turn, where auto and the smart pick take it from there"
    : "drop the clock and it runs in turn instead of at its time — the words and their place in the list stay";
}
/** What the row says back when the desktop takes it. Not "it is running": the
 *  host kicks synchronously and the row may already be `blocked` behind the
 *  ladder by the time this is read, so the honest receipt is about the CLOCK. */
export const DROP_CLOCK_TOAST = "clock dropped — it waits its turn like any other item";
/**
 * …and the same receipt for the BULK tap: **one tap, one receipt.**
 *
 * The bar's button called the per-row handler once per id, so *drop the clocks
 * on these 7* produced seven identical toasts and seven rows in the toast log —
 * a notification feed filled with one decision, and no reading of it that says
 * how many rows were actually touched. The wire is still one `intent.update`
 * per row (there is no batch frame), which is exactly why the RECEIPT has to be
 * the thing that is batched: it is the only place the count survives.
 */
export function dropClocksToast(n: number): string {
  return n === 1
    ? DROP_CLOCK_TOAST
    : `clocks dropped on ${n} — they wait their turn like any other item`;
}

/**
 * …and the same verb over a whole cut, because seven taps is a chore.
 *
 * **A count on a control is a filter**, and this one is the sharpest reading of
 * that rule: the number is the timed rows in the cut ON SCREEN and the tap acts
 * on exactly those, never on the repo's other rows. Where the cut also holds
 * rows with no clock, `dropClocksNote` says so rather than letting "these 5"
 * float over a list of seven.
 */
export function dropClocksLabel(n: number): string {
  return `drop the clocks on ${n === 1 ? "this one" : `these ${n}`}`;
}
export function dropClocksNote(n: number, shown: number): string {
  // "…and the rest have none", never "the rest are already waiting their turn":
  // this bar is drawn over the FAILED cut, where an untimed row is not waiting
  // for anything. Each of the n is identifiable on screen by its own clock
  // chip, which is what lets a reader check the number against the list.
  //
  // With n === shown there is no rest, and a clause about an empty remainder is
  // a sentence describing rows nobody can see — "7 rows of the 7 shown carry a
  // clock — the rest have none" invites a reader to look for a rest there
  // isn't. The count still earns its place: it says the button acts on
  // everything on screen.
  const head = n === shown
    ? `every one of the ${shown} rows here carries a clock`
    : `${n === 1 ? "one row" : `${n} rows`} of the ${shown} shown carr${n === 1 ? "ies" : "y"} a clock — the rest have none and are left alone`;
  // **The two sentences that were only ever in `title` attributes.**
  // A title is invisible on a phone, and these are the two things a person
  // needs before tapping: what becomes of the words (the queue, then auto and
  // the smart pick), and what the tap does NOT take away (the host-wide hold,
  // which is a thing they asked for about these words and not a property of the
  // instant). This is the visible home for both — the bulk path is the
  // documented six-tap journey, and it walked past both of them unsaid.
  return `${head}. Dropping a clock leaves the words where they are: they wait their turn, `
    + "auto and the smart pick take it from there, and any that hold until the desktop is free keep doing so.";
}
