// Cut from queue.ts (move only): uploads an entry references, answer placement
// The one door stays `./queue.js`; this slice imports its siblings directly, never the barrel.

import type { SendQueueEntry } from "./queueentry.js";

/**
 * Pull the uploads a message REFERENCES into that message's lane.
 *
 * An image is parked in the queue when it is attached, and the path it will
 * land at goes into the compose box — but the message naming it is queued
 * LATER, from wherever the user happens to send it, and nothing tied the two
 * together except the hope that both were parked under the same lane key. They
 * routinely were not: an attach made with no session open, an attach for the
 * repo (backlog/gallery flows park under the repo dir), or simply switching
 * sessions between attaching and sending, all left the picture in one lane and
 * the prompt in another. Two lanes drain CONCURRENTLY, so the prompt won the
 * race against its own image essentially every time — the agent was pointed at
 * `.claude/inbox/<file>` a second before the bytes were written, and read a
 * file that did not exist. With the link UP, which is what made it look
 * unrelated to the offline queue it came from.
 *
 * So the reference is what decides the lane, not the tap that created the
 * upload: any live upload whose predicted path appears in `text` is moved into
 * `lane`, where the one-in-flight-per-lane rule makes the prompt wait for it.
 * Array order is untouched — an upload parked earlier is already ahead of the
 * message, which is exactly the order needed.
 *
 * ackIds are KEPT (unlike `retargetEntry`): an upload's ackId is the key its
 * bytes are stored under, and the host de-dupes this path on the file itself
 * (`x-dedupe`), not on the ledger — so there is nothing a fresh id would buy
 * and a photo to lose.
 *
 * `failed` entries are deliberately not adopted: a dead upload is never going
 * to arrive, and moving it would park the lane behind a corpse. The caller
 * refuses the send instead (`danglingUploadRefs`).
 */
export function adoptReferencedUploads<T extends SendQueueEntry>(
  entries: readonly T[],
  text: string,
  lane: string,
): T[] {
  return entries.map((e) =>
    e.mode === "upload" && e.status !== "failed" && e.sessionId !== lane &&
    e.upload && text.includes(e.upload.relPath)
      ? { ...e, sessionId: lane }
      : e);
}

/**
 * The inbox paths this message names that are provably never going to exist:
 * an upload sitting in the queue as `failed`.
 *
 * Sending such a message is worse than not sending it — the agent gets a path
 * it cannot read and the phone reports success, so both ends disagree about
 * what happened. The caller keeps the text and says which image has to be
 * re-attached.
 */
export function danglingUploadRefs<T extends SendQueueEntry>(
  entries: readonly T[],
  text: string,
): string[] {
  return entries
    .filter((e) => e.mode === "upload" && e.status === "failed" && e.upload && text.includes(e.upload.relPath))
    .map((e) => e.upload!.relPath);
}

/**
 * Where to insert a newly tapped ANSWER in the flat queue.
 *
 * Not the end of its lane, and not the front of it either.
 *
 * Not the end, because everything queued behind a blocked session is PROSE, and
 * prose typed into a session parked on a dialog goes into the dialog: it
 * neither runs nor answers the question. The answer is what unblocks the
 * session the text is waiting for, so it goes first. That is also the order the
 * user wrote them in — they answered the question they could see, then typed.
 *
 * Not the front, because a checkbox box is answered by several taps in sequence
 * (toggle 1, toggle 2, Submit) which all carry the SAME question fingerprint.
 * Jumping each one to the head would deliver them in reverse and submit the
 * wrong set.
 *
 * So: ahead of the lane's first queued non-answer, behind any answer already
 * waiting. `pending` entries are never overtaken — they may be on a live PTY
 * already. Returns `entries.length` (i.e. append) when the lane holds no queued
 * text, which is the ordinary case.
 */
export function answerInsertAt(entries: readonly SendQueueEntry[], lane: string): number {
  const at = entries.findIndex((e) => e.sessionId === lane && e.status === "queued" && !e.answer);
  return at < 0 ? entries.length : at;
}
