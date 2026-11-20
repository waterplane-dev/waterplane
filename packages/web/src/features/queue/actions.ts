/**
 * The queue sheet's writers. It owns no store: the send queue is the core's
 * (`core/queue`, ref-authoritative), and every verb here is one of its verbs.
 */
import { core } from "../../sdk";
import type { OutboxEntry } from "../../outbox";
import { isRelayedLive, isRelayedStuck, relayedRefusal, removeRelayedStuck } from "../../relayedRow";
import { askConfirm } from "../../Confirm";
import { entryProse } from "../../activityRows";
import { serialToast } from "./logic";

/** The sheet's one global switch: serialize new queued opens, or not. */
export function toggleSerialAll(): void {
  const c = core();
  const next = !c.queue.serial.on;
  c.queue.serial.set(next);
  c.say.toast(serialToast(next));
}

/** Release everything queued. */
export function sendAll(): void {
  const c = core();
  const n = c.queue.flush(true);
  c.say.toast(n ? "sending…" : c.queue.idleReason("nothing left to send"));
}

/** Rewrite a row in the Send sheet — a create's prose is its prompt, a
 *  fan-out's its text (`entryProse`, one rule for "what did the person write"). */
export function resend(e: OutboxEntry): void {
  const c = core();
  // A row the background link already wrote must not get a fresh ackId: the desktop may run both.
  if (isRelayedLive(e)) { c.say.toast(relayedRefusal("rewritten", e)); return; }
  c.nav.openSend({
    prompts: [entryProse(e)],
    target: c.send.targetFor(e.sessionId, e.cwd),
    cwdHint: e.cwd, repoId: c.queue.repoIdOf(e), ackId: e.ackId, repair: true,
    origin: e.status === "failed" ? "This one never went" : "Queued, not sent yet",
    openAfter: true,
  });
}

/** The trash on a queue row. A stuck relayed row (failed, no host word it never ran) gets no receipt,
 *  so its trash is the way out — asked, removed locally, worded as a removal, never a discard; every
 *  other row is the queue's own `removeQueued`. */
export function removeRow(e: OutboxEntry | undefined, ackId: string): boolean {
  const c = core();
  if (e && isRelayedStuck(e)) {
    void removeRelayedStuck(e, { ask: askConfirm, remove: (a) => c.queue.verbs.removeQueued(a, { mayHaveRun: true }), toast: c.say.toast });
    return false;
  }
  return c.queue.verbs.removeQueued(ackId);
}
