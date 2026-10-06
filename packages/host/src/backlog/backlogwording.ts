/**
 * Why an item didn't deliver, in the user's terms, and which failures may be
 * retried. Split out of `backlog.ts` (move only).
 */
import type { DeliveryResult } from "../deliver.js";

/**
 * Why an item didn't deliver, in the user's terms. `unsubmitted` is the one that
 * must NOT read like "nothing happened": the text IS in the composer, one Return
 * away from running, so re-firing would type a second copy under the first.
 */
export function deliveryError(delivered: DeliveryResult): string {
  if (delivered === "unconfirmed") {
    return "Instruction sent but not confirmed on screen — a prompt or full-screen view (/cost, /context) may be capturing input. Not retried automatically (that would risk sending it twice). Open the session, check whether it arrived, then re-fire.";
  }
  if (delivered === "unsubmitted") {
    return "Typed into the composer, but every Return was swallowed — the instruction is sitting there unsent. Open the session and press Return. Don't re-fire: that would type a second copy under the first.";
  }
  return "Session never became ready for input. Open the session, clear whatever is blocking it, and re-fire.";
}

/**
 * May a failed delivery be re-attempted from the top?
 *
 * `retry` means *provably nothing was typed* — and that is a claim about the
 * STEP that returned it, never about the item. A chain is one item delivered a
 * turn at a time: if step 2 comes back `retry`, step 1 already ran, and the
 * store's `retry` path puts the row back to `queued` with no `sessionId`, so
 * the next tick opens a SECOND session and types step 1 into it again while the
 * first session is still working on the first copy. "Run it twice" is the one
 * thing the whole intent store is built to prevent, and this is the one line
 * that was quietly promising it.
 *
 * So only a first-step `retry` is retryable. A later step's is a failure with a
 * sentence, and a person re-sends the tail into the session that already has
 * the head — which is the only safe thing anybody, machine or not, can do.
 */
export function retryableStep(delivered: DeliveryResult, step: number): boolean {
  return delivered === "retry" && step === 0;
}

/** …and the sentence that says which turn of the chain stopped, because
 *  "it failed" about a three-turn item is not enough to act on. */
export function chainDeliveryError(delivered: DeliveryResult, step: number, total: number): string {
  const base = deliveryError(delivered);
  if (total < 2 || step === 0) return base;
  return `${base} (This is turn ${step + 1} of ${total}; ${step === 1 ? "turn 1 already ran" : `turns 1–${step} already ran`} in this session, so it is NOT re-run from the top — send the rest by hand.)`;
}
