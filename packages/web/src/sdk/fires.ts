/**
 * What became of a tracked op or backlog item (`queue.queueOp`/`queueBacklog` with `track: true`), for
 * a feature whose own store follows it with no sheet mounted. Reads only: the queue stays its own writer.
 */
import { fireAcksStore, fireFateOf, type FireFate } from "../core/queue/fireFate.ts";
import { outboxStore } from "../core/queue/store.ts";

/** The fate right now; `null` for an id this tab does not track. */
export function fireFateNow(ackId: string): FireFate | null {
  return fireFateOf(fireAcksStore.get(), outboxStore.get(), ackId);
}

/** Called on every receipt and every queue change; returns the unsubscribe. */
export function watchFires(fn: () => void): () => void {
  const a = fireAcksStore.subscribe(fn);
  const b = outboxStore.subscribe(fn);
  return () => { a(); b(); };
}
