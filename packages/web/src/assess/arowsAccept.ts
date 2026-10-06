/**
 * Part of `assessRows.ts`, the barrel every caller imports — what a tap does or refuses to do: accept blockers, accept words, the position sentence.
 * Pure, and its imports carry `.ts` because `node --test` loads it straight off the source.
 * Map of the slices: docs/notes/assess-architecture.md.
 */
import type { AssessSource, AssessVerdict } from "@waterplane/shared";
import type { AssessDisplayRow } from "./arowsDisplay.ts";

/**
 * Why one tap cannot mean anything, in words.
 *
 * All four are `applyAssessment`'s rules said out loud. They are not
 * defensive checks: each is a case where the app would silently swallow a
 * deliberate approval, which on this screen reads as "I ticked it and nothing
 * happened".
 *
 * **A row whose words are not on this phone comes first**, and it is the case
 * that stayed live longest. Both ends read the same record — the rows are drawn
 * from `run.input.items` and `applyAssessment` looks every id up in the very
 * same array and skips what is not in it — so an id that is missing here is an
 * id the desktop will not touch either. `assessApplySummary` has always counted
 * such a row as untouched; the row nonetheless said *applying still works* and
 * drew a live `retire it` whose tick went nowhere, which is exactly the class of
 * failure this screen was rebuilt to remove. It is also first because `source`
 * on such a row is a FALLBACK and not a fact — `assessGroups` has no item to
 * read it off — so any sentence below it would be about a store nobody
 * established.
 *
 * The pad comes next, and covers every verdict rather than `wanted` alone.
 * `applyProposal` on the host has one branch for a note — `if (d.source ===
 * "note") { notes++; continue; }` — so a note is COUNTED and left exactly where
 * it was, whichever verdict it carries. Offering "retire it" there put a tick
 * on the screen that meant nothing at all and gave no sign of it, which is the
 * single worst thing this file can do: the user's decision, taken and thrown
 * away. The sentence says what the app does not do (edit the pad) and where the
 * one tap that WOULD finish the job lives, because "nothing to apply" on its
 * own reads as a bug.
 */
/**
 * What a row stands in with where its words should be.
 *
 * The id, because on a row this device holds nothing else for it is the only
 * handle a person has — and short, because the sentence that matters (what the
 * absence COSTS) is `ASSESS_MISSING_BLOCKED`'s, drawn under it where the buttons
 * would have been.
 */
export function assessMissingWords(id: string): string {
  return `the words for “${id}” are not on this phone`;
}

/**
 * ...and what that absence costs, which is the whole decision on such a row.
 *
 * It used to read "the desktop still has them, and applying still works". That
 * was a promise about the one case where nothing works: the desktop applies from
 * the same `run.input` this phone drew the row from.
 */
export const ASSESS_MISSING_BLOCKED =
  "this run's own record of what it judged is what both ends apply from, and this id is not in it — so there is nothing here to agree with, and a tick would do nothing";

/**
 * **The one note verdict that now has somewhere to go, said where the tap is.**
 *
 * `still wanted` on a pad note was the refusal that had nothing after it: the
 * run agreed the words were worth doing, and the sheet's answer was "there is
 * nothing to apply here". `cleanAssessment` synthesises an OFFER from the
 * note's own text (`AssessNew.fromNote`), so the sentence's job changed from
 * closing the row to POINTING AT the row that carries it — the tick is a few
 * screens down, on words this module can promise are the note's, and nothing
 * on that card edits the pad either until the desktop has confirmed the row.
 *
 * Still a refusal, and still drawn where a control would have been: accepting
 * HERE does nothing, and a button that did nothing is the bug this whole file
 * is arranged around.
 */
export const ASSESS_NOTE_OFFERED =
  "a pad note the run still wants — it is offered below, in its own words, as a backlog item; the pad itself is never edited by this app";

export function assessAcceptBlocker(verdict: AssessVerdict, source: AssessSource, missing = false): string | null {
  if (missing) return ASSESS_MISSING_BLOCKED;
  if (source === "note") {
    // The `wanted` branch is the only one with a route out of the pad, so it is
    // the only one that says something other than "delete it yourself". Every
    // other verdict on a note is unchanged: the run judged it, the pad keeps it.
    if (verdict === "wanted") return ASSESS_NOTE_OFFERED;
    return "a pad note — this app never edits the pad, so there is nothing to apply here. If you agree it is done, delete it on the pad.";
  }
  if (verdict === "unclear") {
    return "nothing to accept — the run did not decide about this one, so it stays exactly as it is";
  }
  if (verdict === "merged") {
    return "a merge is one decision about all of its items — approve it on the merge itself, below";
  }
  return null;
}

/**
 * **The line under a `wanted` row's verdict, and why it is four sentences and
 * not one literal.**
 *
 * It was `position {rank} in the order`, written inline in `AssessSheet.tsx`,
 * and on a FAILED row it was a promise the apply could not keep: a terminal row
 * is not in the order, so a rank written on it is a place in a queue it is not
 * in. Approving the verdict did nothing observable at all, which on the repo
 * this was found in was every row — 0 queued, 19 failed.
 *
 * So the sentence follows what `applyAssessment` will actually do with the row:
 *
 *  - **ranked and failed** — it rejoins the queue AND takes the place the run
 *    gave it. Both, in one line, because they are one tap.
 *  - **ranked** — the position, as before, unchanged for every row that was
 *    already telling the truth.
 *  - **failed with no rank** — `requeue` does not need one: a row put back with
 *    no position takes its turn where it lies. The old code drew nothing here,
 *    which made the one row whose verdict does the most look like the one that
 *    does the least.
 *  - anything else — `null`, and the row draws nothing.
 *
 * Here rather than in the sheet because it is a claim about what Apply does,
 * and it lives beside the code that says what Apply does.
 */
export function assessRowPosition(r: Pick<AssessDisplayRow, "verdict" | "rank" | "failed">): string | null {
  if (r.verdict !== "wanted") return null;
  if (r.rank != null) return r.failed ? `put back in the queue, position ${r.rank}` : `position ${r.rank} in the order`;
  return r.failed ? "put back in the queue" : null;
}

/**
 * **What ACCEPTING one row actually does**, on the button and on the strip.
 *
 * Asked for, and the question is fair: `accept` on a screen full of work items
 * reads as "accept this task" — i.e. go and build it — which is the one thing
 * this screen never does. What is being accepted is the VERDICT, and each
 * verdict does something different: three of them retire an item (the words are
 * kept, with the reason stamped on the row), one gives it a position, and none
 * of them starts an agent, opens a session or types anything anywhere.
 *
 * `effect` is the strip's line and `title` the button's, worded apart because
 * one is read while scanning and the other while deciding. Both name the EFFECT
 * rather than the verb, which is what was missing.
 *
 * `picked` is the same promise in the TICKED state, and it is deliberately not
 * the label with a tick beside it. A row that reads `retired` is a row somebody
 * scanning the strip believes is already gone — it is not, and cannot be, until
 * `Apply`; so the marked state says `will be retired`, and `pickedTitle` says
 * the mark is a mind that can still be changed.
 *
 * There is no pad-note branch, because there is no pad-note button:
 * `assessAcceptBlocker` refuses every note before a control is drawn, and a
 * second wording of that fact here would be a set of words nothing renders and
 * nobody maintains.
 */
export interface AssessAcceptWords {
  /** The button, once it is clear what the tap does. */
  label: string;
  /** The button's title — what this one tap will do to this one row. */
  title: string;
  /** One line under the strip head: what accepting anything here means. */
  effect: string;
  /** The row once it is ticked. FUTURE tense, always — `Apply` is what acts. */
  picked: string;
  /** The ticked row's title: the mark is not a commitment yet. */
  pickedTitle: string;
}

const RETIRES_TITLE = "retire this item: its words are kept with the reason on the row, and nothing is built";
/** One string for "you can still take this back", on every ticked control. */
export const UNPICK_TITLE = "tap to change your mind";

// `_source` is kept on the signature although nothing reads it: a row call site
// has the store in hand, and the day a second store can be applied to (the pad
// cannot) the words belong here rather than in whichever component noticed
// first. It is OPTIONAL because the other caller is a STRIP, which has no single
// store to name — a lookup there could only ever be the first row's, which is a
// fact about one row presented as a fact about twelve.
// `failed` is the THIRD argument and not a fourth verdict, because it is not a
// verdict: the run said `still wanted` about both of these rows and meant the
// same thing by it. What differs is the row it lands on, and therefore what
// approving it does — a rank for a row that is in the queue, a return to the
// queue for one that is not. On a ROW call it is that row's own state; on a
// STRIP call it is "this strip holds at least one", which is why the `effect`
// below has to cover both kinds of row in one line.
/**
 * **WHERE a row that is put back runs — the one clause, for the four places
 * that make the promise.**
 *
 * This screen said *a session of its own* in four separate strings: the accept
 * verb's title, the strip's bulk lines, the bulk keep's title and the note
 * under Apply. That is only true of a `fresh` row. A backlog row carrying
 * `targetSessionId` runs in THAT conversation — it is the sheet's *In
 * &lt;session&gt;* group — and the promise of a session of its own is one the
 * host was never going to keep for it.
 *
 * `AssessItem` does not carry the target (it carries the words, the state and
 * the failure instant, which is everything a VERDICT is about), so this side
 * cannot say which of the two a given row is. What it can do is stop asserting
 * the wrong one: the sentence names both outcomes and says the row decides,
 * which is exactly what a reader can check against the backlog sheet, where
 * every row's group head already says which it is.
 *
 * One exported clause rather than four edits, for `runAgainRowNote`'s reason:
 * four copies of a claim is four chances for one of them to stop being true,
 * and this one already had been.
 */
export function requeueWhereWords(one: boolean): string {
  return `${one ? "" : "each "}where it was already aimed — a session of its own, or the session it names`;
}

export function assessAcceptWords(verdict: AssessVerdict, _source?: AssessSource, failed = false): AssessAcceptWords {
  if (verdict === "wanted") {
    if (failed) {
      return {
        label: "put it back",
        title: `put this failed item back in the queue at the position the run proposes — it runs again ${requeueWhereWords(true)} when its turn comes, and the failure it had stays on the row`,
        effect: "ticking keeps the item and gives it the position the run proposes; one that failed goes back in the queue and runs again when its turn comes — nothing is started now",
        picked: "will be put back in the queue",
        pickedTitle: UNPICK_TITLE,
      };
    }
    return {
      label: "keep it",
      title: "keep this item and give it the position the run proposes — it does not run it",
      effect: "ticking keeps the item and gives it the position the run proposes — nothing is started",
      picked: "will be kept",
      pickedTitle: UNPICK_TITLE,
    };
  }
  if (verdict === "merged") {
    return {
      label: "accept",
      title: "a merge is approved on the merge card itself",
      effect: "one decision about all of its items — approved on the card",
      // A merged row IS retired when its card is approved, so the marked state
      // says the same thing the card's own button will do to it.
      picked: "will be retired",
      pickedTitle: UNPICK_TITLE,
    };
  }
  if (verdict === "unclear") {
    return {
      label: "accept",
      title: "nothing was decided about this one",
      effect: "nothing was decided here — these rows are yours to read",
      // Unreachable (nothing on this strip can be ticked) and still honest: the
      // one true sentence about an undecided row is that it does not move.
      picked: "stays as it is",
      pickedTitle: UNPICK_TITLE,
    };
  }
  return {
    label: "retire it",
    title: RETIRES_TITLE,
    effect: "ticking a row here marks it to be retired when you Apply — its words are kept, with the reason on the row, and nothing is implemented",
    picked: "will be retired",
    pickedTitle: UNPICK_TITLE,
  };
}
