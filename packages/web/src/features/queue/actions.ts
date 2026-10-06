/**
 * The queue sheet's writers. It owns no store: the send queue is the core's
 * (`core/queue`, ref-authoritative), and every verb here is one of its verbs.
 */
import { core } from "../../sdk";
import type { OutboxEntry } from "../../outbox";
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
  c.nav.openSend({
    prompts: [entryProse(e)],
    target: c.send.targetFor(e.sessionId, e.cwd),
    cwdHint: e.cwd, repoId: c.queue.repoIdOf(e), ackId: e.ackId, repair: true,
    origin: e.status === "failed" ? "This one never went" : "Queued, not sent yet",
    openAfter: true,
  });
}
