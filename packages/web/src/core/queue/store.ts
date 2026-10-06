/**
 * The send queue as a store, so a component far from App can read it
 * (`useQueueEntries()` in the SDK) without App re-plumbing the list.
 *
 * **Ref-authoritative, still.** `useQueue`'s `outboxRef` is the queue's truth
 * and `writeOutbox` is the ONE writer of this store — `saveOutbox → outboxRef
 * → outboxStore.set → reportShellQueueDepth`, in that order. Nothing else calls
 * `outboxStore.set`, and nothing ever sets it through an updater function: the
 * flusher runs synchronously right after a send is queued and must see the new
 * row at once, which is the reason the queue is a ref in the first place.
 *
 * Seeded by the hook on its first render rather than at import, because
 * `outbox.ts` reads `localStorage` and the SDK's hooks (which import this) are
 * also imported by node tests that have none.
 */
import { createStore } from "../../sdk/store.ts";
import type { SendBlockReason } from "@waterplane/shared";
import type { OutboxEntry } from "../../outbox";

export const outboxStore = createStore<OutboxEntry[]>([]);

/**
 * Which rung of the ladder refused each queued entry, by ackId — the flusher's
 * own verdict, written by `flushOutbox` and nowhere else.
 */
export const blockedStore = createStore<ReadonlyMap<string, SendBlockReason>>(new Map());

let seeded = false;
/** Load the persisted queue into the store, once per page. */
export function seedOutbox(load: () => OutboxEntry[]): void {
  if (seeded) return;
  seeded = true;
  outboxStore.set(load());
}
