/**
 * What a row the smart pick merged says about itself, and which verb (`undo` / `put them
 * back`) it offers.
 *
 * Part of `backlogFilter.ts`, the barrel every caller imports. Pure, and its
 * imports carry `.ts` because `node --test` loads it straight off the source.
 */
import type { BacklogStatus } from "@waterplane/shared";

/**
 * What a merged row says about itself, and it is a DIFFERENT promise on each
 * side of having run.
 *
 * Before it runs, `undo` is an undo: the row goes, the originals come back
 * exactly where they were, nothing happened. After it runs, nothing can be
 * undone — the machine's words HAVE been typed into a session — so the same
 * button must not wear the same word. What it does then is queue the originals
 * again, and the sentence says that.
 *
 * This is the case the feature exists for. A person asleep meets the merged row
 * AFTER it has fired: the pass picks and applies in the same breath and the
 * merged row is routinely the pick, so the pre-run undo window on the row the
 * notification names is about one tick. The old wording sent that person to
 * "bring one back by hand" — show archived, find each, unarchive N — with the
 * machine text still unreversed.
 *
 * `offer` is `null` offline, where no mutation is drawn at all and the sheet's
 * one offline line already says so: a sentence promising a button that is not
 * on screen is worse than no sentence.
 *
 * **A `running` row draws `undoWhileRunningWords` instead of this, never both.**
 * The button is the same `again` button, but "it has already run" is not true
 * yet and the thing worth saying is that the tap does not stop the run.
 */
export type UndoOffer = "undo" | "again" | null;

/**
 * **What "as they were" leaves out when an original carried a CLOCK.**
 *
 * `undo` restores each original with the `nextAt` it had. For an untimed row
 * that is the whole truth — it goes back in the queue and runs in turn. For a
 * timed one it is not: merged twins on *tonight 21:00*, undone tomorrow, come
 * back to a tick whose ladder answers *"that instant has passed and this was a
 * one-off — post it again"* and fails each of them. So the receipt promised a
 * run that cannot happen, under a button whose whole case is that it is safe to
 * let the pass apply itself.
 *
 * The clause is conditional and NOT a count: which of them will fail depends on
 * a tick, a grace and — for a `window` rule — a usage reading the phone has not
 * got. A heuristic here degrades to a true sentence about all of them, never to
 * a number about some of them. And the row it names is not lost: a failed timed
 * row wears *drop the clock*, which is the verb that puts it back in the queue.
 */
export const RESTORED_CLOCK_NOTE =
  "their clocks come back with them, so any whose instant has gone by land as failed rows wearing “drop the clock”";

export function smartWroteWords(n: number, offer: UndoOffer, timedOriginals = false): string {
  const head = `written by the smart pick, from your ${n}`;
  const clock = timedOriginals ? ` — ${RESTORED_CLOCK_NOTE}` : "";
  if (offer === "undo") return `${head} — undo puts them back${clock}`;
  if (offer === "again") return `${head} — it has already run; put them back queues your ${n === 1 ? "original" : `${n} originals`} as they were${clock}`;
  return head;
}

/**
 * …and while it is RUNNING, which is the state the sleeper wakes into.
 *
 * This used to be a REFUSAL — *"can be put back once it has finished"* — drawn
 * instead of the button. It was wrong twice over. The host accepts
 * `backlog.unmerge` on a `running` row: it archives the row without stopping
 * it, restores the members, and answers *"the merged item is still running and
 * has not been stopped — your N originals are back in the list and will run as
 * they were"*. So the sentence promised a refusal the host would never make,
 * and it withheld a capability in exactly the one state the whole safety case
 * is about.
 *
 * The objection behind it was real and is answered here rather than by the
 * button's absence: neither *undo* nor a plain *put them back* is the whole
 * truth while a session is typing those words, so the row SAYS what the tap
 * will and will not do — the originals come back, the run does not stop. Which
 * is the host's own wording, one beat before the host says it.
 */
export function undoWhileRunningWords(n: number, timedOriginals = false): string {
  return `it is running now and will not be stopped — put them back queues your ${n === 1 ? "original" : `${n} originals`} again, as they were`
    + (timedOriginals ? ` — ${RESTORED_CLOCK_NOTE}` : "");
}

/**
 * Which verb a merged row offers, from its own state. Pure, because the whole
 * complaint was that the sheet drew the honest verb in one state out of four.
 *
 * `running` answers `again` like every other post-start state: the words have
 * been typed (some of them, anyway) and cannot be untyped, so it is not an
 * undo — and the row's own note, `undoWhileRunningWords`, is what says the run
 * carries on. The only `null` left is offline, where no mutation is drawn at
 * all.
 */
export function undoOfferFor(o: { mergedFrom: number; status: BacklogStatus; online: boolean }): UndoOffer {
  if (!o.mergedFrom || !o.online) return null;
  if (o.status === "queued") return "undo";
  return "again";
}
