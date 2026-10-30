/**
 * `useFireFate(ackId)` — what became of a fire this tab queued with
 * `track: true`: `pending` / `acked` (+ the `runId` its receipt named) /
 * `refused` / `dropped` (its row failed or was dismissed: it will never get a
 * receipt). `null` for no fire, or one this tab did not track. READS only —
 * the queue store and the tracked receipts; the queue stays ref-authoritative.
 * The decision itself is `fireFate.ts`'s, node-tested.
 */
import { useStore } from "../../sdk/store.ts";
import { fireAcksStore, fireFateOf, type FireFate } from "./fireFate.ts";
import { outboxStore } from "./store.ts";

export function useFireFate(ackId: string | null): FireFate | null {
  const acks = useStore(fireAcksStore);
  const rows = useStore(outboxStore);
  return fireFateOf(acks, rows, ackId);
}
