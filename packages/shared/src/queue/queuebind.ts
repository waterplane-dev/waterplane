// Cut from queue.ts (move only): pending-session binding and release
// The one door stays `./queue.js`; this slice imports its siblings directly, never the barrel.

import type { SendQueueEntry } from "./queueentry.js";

/**
 * Bind the prompts queued behind a `session.create` to the session it produced.
 *
 * Called when `op.ack` names the new session id: every `pendingCreate` entry in
 * that lane swaps its placeholder lane key (`create:<cwd>`) for the real
 * session id and drops the flag. `ts` is restamped so the queue sheet sorts and
 * ages the row from the moment it became a real send.
 *
 * The ackIds are KEPT. These entries are provably un-sent (the lane rule holds
 * everything behind the create, and a `pendingCreate` entry is never picked at
 * all), so no host ledger can hold a verdict for them — unlike `retargetEntry`,
 * which must mint fresh ids precisely because its entries may have been out
 * once already.
 *
 * Array order is untouched, so the prompts stay in the order they were written.
 */
export function bindPendingSession<T extends SendQueueEntry>(
  entries: readonly T[],
  lane: string,
  sessionId: string,
  now: number,
  createAck?: string,
): T[] {
  return entries.map((e) =>
    e.pendingCreate && e.sessionId === lane && ownedByCreate(e, createAck)
      ? { ...e, sessionId, pendingCreate: undefined, createAck: undefined, ts: now }
      : e);
}

/**
 * Does this parked prompt belong to THIS create?
 *
 * The lane is `create:<cwd>`, i.e. per REPO — so two "open a session and run
 * these" written for the same repo (the thing the Start sheet is built to let
 * you do offline, one after another) share it. Matching on the lane alone bound
 * the second one's chain to the FIRST session, ran it there, and left the
 * second session with only the prompt that rode inside its own op.
 *
 * `createAck` is the create op's ackId, stamped on every prompt queued behind
 * it. An entry that predates this field (persisted by an older build) carries
 * none and still binds on the lane — there is exactly one create in flight per
 * lane, so the old behaviour is the right fallback for it.
 */
function ownedByCreate(e: SendQueueEntry, createAck?: string): boolean {
  return !createAck || !e.createAck || e.createAck === createAck;
}

/**
 * The parked prompts one create owns — what App fails alongside a create that
 * could not be delivered.
 *
 * Same ownership rule as `bindPendingSession`, in one place: "which of this
 * repo's queued prompts hang off this create" is a question three call sites
 * ask, and answering it differently in any of them is how a second create's
 * chain gets failed by the first one's bad news.
 */
export function ownedPendingCreates<T extends SendQueueEntry>(
  entries: readonly T[],
  lane: string,
  createAck?: string,
): T[] {
  return entries.filter((e) =>
    e.pendingCreate && e.sessionId === lane && e.status === "queued" && ownedByCreate(e, createAck));
}

/**
 * Drop the park flag on the entries `selectSendable` just released: the turn
 * they were waiting for has ended, so they are ordinary queued messages now.
 *
 * Clearing the flag is the whole job. It used to also restamp `ts`, because
 * that clock decided when the entry was shredded as "queued too long" and an
 * entry parked against a 35-minute turn was already past it the moment it
 * became sendable. There is no such clock any more, so there is nothing to
 * reset — what remains is stopping the next pass from reporting the same
 * release for ever.
 */
export function applyRelease<T extends SendQueueEntry>(entries: readonly T[], released: readonly T[]): T[] {
  if (!released.length) return entries.slice();
  const ids = new Set(released.map((e) => e.ackId));
  return entries.map((e) => (ids.has(e.ackId) ? { ...e, holdUntilIdle: undefined } : e));
}
