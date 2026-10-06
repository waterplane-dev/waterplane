// Cut from queue.ts (move only): lane order and retargeting
// The one door stays `./queue.js`; this slice imports its siblings directly, never the barrel.

import type { SendStatus, SendMode, SendQueueEntry } from "./queueentry.js";

/** Queue positions of one lane, in send order — what the manage-queue UI shows. */
export function laneEntries<T extends SendQueueEntry>(entries: readonly T[], sessionId: string): T[] {
  return entries.filter((e) => e.sessionId === sessionId);
}

/**
 * Move an entry one slot earlier/later WITHIN ITS OWN LANE, keeping the flat
 * array consistent: the two entries swap positions outright, so a reorder can
 * never reshuffle an unrelated session's queue.
 */
/** The extra fields a retarget rewrites; the client's entry carries more still. */
export interface RetargetableEntry extends SendQueueEntry {
  text?: string;
  /** backlog mode only. */
  label?: string;
  fire?: boolean;
  autoFire?: boolean;
  targetSessionId?: string;
  armed?: boolean;
  offline?: boolean;
}

/** Can this entry be pointed at a different session? Only one that is still
 *  purely local: a `pending` one may already be on a live PTY, and an `op`
 *  carries its own subject (a fan-out's repo list, a build's id) — "send it
 *  somewhere else" is meaningless for it. */
export function canRetarget(e: { status: SendStatus; mode?: SendMode; answer?: unknown }): boolean {
  // `upload` is as un-retargetable as an op: it names a repo inbox, and the
  // queued prompt that references the path it will land at is a different entry.
  // An ANSWER is the strongest case of all: its payload is a keystroke that
  // means something only in one specific question box, in one specific session
  // (it carries that box's fingerprint, and the host refuses it anywhere else).
  // Pointing it at another session could only ever produce a stray digit.
  return e.status === "queued" && e.mode !== "op" && e.mode !== "upload" && !e.answer;
}

/**
 * Point one queued entry at a different session/repo — the fix for "I typed
 * this while offline and by the time the link was back, the session it was for
 * had moved on (or died)".
 *
 * Everything it touches is there for a reason:
 *   • the lane key (`sessionId`) and `cwd` are the retarget itself;
 *   • `mode` may flip: sending text to a live session (`input`) and parking it
 *     as a repo work item (`backlog`) are the same words with a different
 *     destination, so the backlog-only fields are filled in / dropped to match;
 *   • `attempts` resets — the failures were against the OLD target and must not
 *     count against the new one — and `firstTryAt` goes with it, being the
 *     old ackId's first send (`firstSentAt` on the wire);
 *   • the ackId is MINTED FRESH (passed in, since this module is DOM-free and
 *     has no randomness of its own). The old id may already hold a verdict in
 *     the host's ledger for the old target — reusing it would have the host
 *     re-ack that stale outcome and never deliver anywhere.
 *
 * `ts` is deliberately NOT reset: it says when these words were written, and
 * re-aiming them does not make them newer. `armed`/`offline` carry over — the
 * user's intent to send it, and where it came from, are unchanged.
 *
 * A refused entry (see `canRetarget`) is left exactly as it was; every other
 * lane comes back untouched.
 */
export function retargetEntry<T extends RetargetableEntry>(
  entries: readonly T[],
  ackId: string,
  to: { sessionId: string; cwd: string; ackId: string; mode?: "input" | "backlog"; targetSessionId?: string },
): T[] {
  return entries.map((e) => {
    if (e.ackId !== ackId || !canRetarget(e)) return e;
    const mode: SendMode = to.mode ?? (e.mode === "backlog" ? "backlog" : "input");
    const next: T = { ...e, ackId: to.ackId, sessionId: to.sessionId, cwd: to.cwd, mode, attempts: 0 };
    // `firstTryAt` belongs to the OLD ackId: it is what the wire's
    // `firstSentAt` is read from (`sendstamp.ts`), and a fresh id carrying an
    // old first-send would be refused as a pre-loss re-send by a desktop that
    // lost its ledger. The new id gets its own on its first attempt — and the
    // give-up floor restarts with `attempts`, which is the same argument.
    delete next.firstTryAt;
    if (mode === "backlog") {
      next.label = (e.text ?? "").slice(0, 40);
      // A target inherited from the old lane would send the item straight back
      // where it came from; only an explicitly named one survives.
      if (to.targetSessionId) next.targetSessionId = to.targetSessionId;
      else delete next.targetSessionId;
    } else {
      delete next.label;
      delete next.fire;
      delete next.autoFire;
      delete next.targetSessionId;
    }
    return next;
  });
}

export function moveInLane<T extends SendQueueEntry>(entries: readonly T[], ackId: string, dir: -1 | 1): T[] {
  const idx = entries.findIndex((e) => e.ackId === ackId);
  if (idx < 0) return entries.slice();
  const me = entries[idx];
  let other = -1;
  for (let i = idx + dir; i >= 0 && i < entries.length; i += dir) {
    if (entries[i].sessionId === me.sessionId) { other = i; break; }
  }
  if (other < 0) return entries.slice();
  const out = entries.slice();
  out[idx] = out[other];
  out[other] = me;
  return out;
}
