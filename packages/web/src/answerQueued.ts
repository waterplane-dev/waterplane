/**
 * What the card says about answers still in the outbox. Pure, so the words are
 * pinned by `answerQueued.test.mjs`.
 *
 * "as soon as the link is back" is only true when the link is DOWN. With the
 * link up an answer in the outbox is on its way (or waiting for the desktop's
 * receipt), and claiming otherwise sends a person hunting for a fault.
 */
export function queuedAnswerNote(queued: readonly { label: string }[], online: boolean): string {
  const state = online ? "sending" : "queued";
  const what = queued.length > 1
    ? `${queued.length} answers ${state} (${queued.map((e) => e.label).join(", ")})`
    : `“${queued[0].label}” ${state}`;
  return online
    ? `${what} — waiting for the desktop to confirm`
    : `${what} — sent, in order, as soon as the link is back`;
}
