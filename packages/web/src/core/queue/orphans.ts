/**
 * Orphaned queue rows, as a PURE reconcile run on every queue write (and on mount).
 *
 * A row chained behind a `session.create` (`pendingCreate`) waits for that create to name its
 * session. When the create is no longer anywhere — evicted by the cap, dropped, or never
 * materialised — nothing will ever bind the row and it holds its lane for ever. It becomes
 * `failed` with its text intact (never deleted: it can be re-aimed or restored by hand).
 *
 * "The create is somewhere" means: a create op still in the queue (failed ones included — their
 * own failure path fails the chain with a reason), OR its ack is in `pendingIds` (a launch the
 * desktop is holding for files: the create was acked and retired, the chain waits for
 * `launch.opened`). A row whose lane is already a live session was bound; it is not an orphan.
 *
 * Keyed by the create's ackId when the row names one — the lane is per repo and may hold ANOTHER
 * create, which is not the one this row was written for and must not adopt it.
 */
import type { OutboxEntry } from "../../outbox";

export const ORPHAN_REASON = "the session it was queued for is gone";

const isCreate = (e: OutboxEntry): boolean => e.mode === "op" && e.op?.t === "session.create";

export function reconcileOrphans(
  entries: readonly OutboxEntry[],
  liveSessions: ReadonlySet<string>,
  pendingIds: ReadonlySet<string>,
  now: number = Date.now(),
): { keep: OutboxEntry[]; orphaned: OutboxEntry[] } {
  const creates = entries.filter(isCreate);
  const createLanes = new Set(creates.map((e) => e.sessionId));
  const createAcks = new Set(creates.map((e) => e.ackId));
  const isOrphan = (e: OutboxEntry): boolean => {
    if (!e.pendingCreate) return false;
    // Already failed elsewhere (failPendingCreates keeps pendingCreate): its own reason stands; never fail or count it twice.
    if (e.status === "failed") return false;
    if (liveSessions.has(e.sessionId)) return false;
    if (e.createAck) return !createAcks.has(e.createAck) && !pendingIds.has(e.createAck);
    return !createLanes.has(e.sessionId);
  };
  const orphaned: OutboxEntry[] = [];
  const keep = entries.map((e) => {
    if (!isOrphan(e)) return e;
    const failed: OutboxEntry = { ...e, pendingCreate: undefined, status: "failed", reason: ORPHAN_REASON, failedAt: now };
    orphaned.push(failed);
    return failed;
  });
  return { keep: orphaned.length ? keep : (entries as OutboxEntry[]), orphaned };
}
