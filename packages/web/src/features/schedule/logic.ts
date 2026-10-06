/**
 * The schedule feature's pure half: what the send queue says about schedules
 * this phone wrote and the host has not taken yet, and the one sentence the
 * spent-one-offs foot hands Activity. Pinned by `logic.test.mjs`. The delete
 * receipt is `clockCuts.ts`'s `scheduleRemovedToast`, shared with Activity.
 */
import type { ClientMessage } from "@waterplane/shared";
import type { PendingClock } from "../../clockCuts";
import type { OutboxEntry } from "../../outbox";

/**
 * Schedules written on this device that the host has not taken yet.
 *
 * An op entry carries the exact frame it will send, entry and all, so this is
 * a read of the queue rather than a second store to keep in step: a row is
 * here for exactly as long as the send is, and disappears when the ack lands
 * and the host's own `schedule.list` carries it instead.
 */
export function pendingSchedulesOf(outbox: readonly OutboxEntry[]): PendingClock[] {
  return outbox
    .filter((e) => e.mode === "op" && e.op?.t === "schedule.save")
    .map((e) => ({
      entry: (e.op as Extract<ClientMessage, { t: "schedule.save" }>).entry,
      // Carried, not inferred: a save that has given up looked exactly like
      // one still on its way, so the row that will never arm was the one
      // drawing the "queued" chip.
      failed: e.status === "failed",
    }));
}

/** The Activity cut the spent-one-offs foot opens: those ids, named. */
export function spentLabel(n: number): string {
  return `the ${n} one-off${n === 1 ? " that has" : "s that have"} been and gone`;
}

