/**
 * The terminal feed's pure half: what a `pty` frame does to the per-session
 * buffers, what a cold-start seed puts back, and which order the offline sweep
 * visits sessions in. Lifted out of `App.tsx` unchanged — the reasoning is the
 * original's, kept beside the lines it explains.
 *
 * Plain maps in, mutations out, no React and no IndexedDB, so
 * `tail.test.mjs` can pin it under `node --test`. `useTermFeed` holds the maps
 * (refs — the bytes are NEVER state; every frame bumps `writeSeq` instead).
 */

/** One restored record, as `loadPtyTails()` hands it back (`ptyTail.ts`'s `PtyTail`). */
export interface TailRecord { sessionId: string; tail: string; seq: number; savedAt: number; boot?: string }

/** The per-session maps the feed keeps. All refs' `.current` in the hook. */
export interface FeedMaps {
  buffers: Map<string, string[]>;
  lastSeqById: Map<string, number>;
  restore: Map<string, number>;
  resumeBoot: Map<string, string>;
}

/**
 * Apply one `pty` frame's bytes to the buffers. Returns true when the frame was
 * a FULL replay (the caller remounts the xterm if it is the on-screen session).
 *
 * Full scrollback replay → replace the buffer wholesale. A reconnect whose
 * resume point was evicted, or a fresh attach, both land here. This is also
 * where a RESTORED tail dies, and it must: a full replay already contains
 * everything the restore held, so appending it would print the same screen
 * twice. `set` (not push) is what guarantees it.
 *
 * Otherwise live output OR a reconnect delta: append. No remount → the delta
 * stitches straight onto what the terminal already shows (invisible).
 */
export function applyPtyBytes(buffers: Map<string, string[]>, id: string, data: string, full: boolean | undefined): boolean {
  if (full) {
    buffers.set(id, data ? [data] : []);
    return true;
  }
  const arr = buffers.get(id) ?? [];
  arr.push(data);
  buffers.set(id, arr);
  return false;
}

/** The reader's liveness tail: the last `cap` characters of output. */
export function appendTail(prev: string | undefined, data: string, cap: number): string {
  return ((prev ?? "") + data).slice(-cap);
}

/**
 * Seed the maps from the stored tails at mount. Returns the stale map
 * (session → savedAt) — the sessions now showing RESTORED bytes.
 *
 * A session that already has live bytes in this tab is never overwritten — the
 * restore is strictly a cold-start fallback. The BYTES are always worth
 * painting (dimmed); the resume POINT is only usable if the host is still the
 * boot that issued it — see the PtyTail doc block. A record from an older build
 * has no boot id and is therefore never trusted as a resume point.
 */
export function seedFromTails(entries: readonly TailRecord[], m: FeedMaps): Map<string, number> {
  const stale = new Map<string, number>();
  for (const e of entries) {
    if ((m.buffers.get(e.sessionId)?.length ?? 0) > 0) continue;
    m.buffers.set(e.sessionId, [e.tail]);
    stale.set(e.sessionId, e.savedAt);
    if (!e.boot) continue;
    m.lastSeqById.set(e.sessionId, e.seq);
    m.restore.set(e.sessionId, e.seq);
    m.resumeBoot.set(e.sessionId, e.boot);
  }
  return stale;
}

/**
 * The offline transcript sweep's order: attached first (most likely to be
 * read), then newest — the same order the cache's own eviction keeps, so the
 * sweep never fights the prune.
 */
export function sweepOrder(sessions: readonly { id: string; createdAt: number }[], attachedId: string | null): string[] {
  return [...sessions]
    .sort((a, b) => (b.id === attachedId ? 1 : 0) - (a.id === attachedId ? 1 : 0)
      || b.createdAt - a.createdAt)
    .map((x) => x.id);
}
