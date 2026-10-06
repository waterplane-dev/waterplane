/**
 * The download queue's pure half — no React, no IndexedDB — so `logic.test.mjs`
 * runs it under `node --test`.
 */

/** The fields of a `pull.ts` record the summary reads. */
export interface PullLike {
  state: string;
  received: number;
  evicted?: boolean;
  item: { size?: number };
}

export interface PullSummary {
  /** Transfers not yet done (queued, downloading, paused, failed). */
  active: number;
  /** Finished files still on this phone. */
  onPhone: number;
  /** Something in the queue is failed or paused — a queue at 0% because the
   *  link died says something a percentage alone does not. */
  stuck: boolean;
  /** Bytes, not files: three queued 24 MB APKs are not "33% done" the moment
   *  the first one lands. */
  pct: number;
}

/**
 * The download queue at a glance, for the two always-visible places that carry
 * it: the menu chip and the menu's own entry. Progress is measured in BYTES, not
 * in finished files; a record whose size the host never said counts as what it
 * has received so far.
 */
export function pullSummary(records: readonly PullLike[]): PullSummary {
  const active = records.filter((r) => r.state !== "done");
  const have = active.reduce((n, r) => n + r.received, 0);
  const want = active.reduce((n, r) => n + (r.item.size || r.received), 0);
  return {
    active: active.length,
    onPhone: records.filter((r) => r.state === "done" && !r.evicted).length,
    stuck: active.some((r) => r.state === "failed" || r.state === "paused"),
    pct: want > 0 ? Math.min(100, Math.floor((have / want) * 100)) : 0,
  };
}
