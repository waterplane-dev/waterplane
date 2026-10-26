import { useEffect, useState } from "react";
import { getTranscriptAt } from "../../offlineCache";

/**
 * When this phone last saved `sessionId`'s transcript, or null for none.
 *
 * The terminal's offline card reads it: a session this phone never ATTACHED
 * has no PTY tail (`ptyTail.ts` saves only the on-screen session), yet the
 * transcript sweep (`sweepTranscripts`) caches every session's conversation.
 * "Nothing cached" over a session whose transcript IS here sent the person
 * nowhere — the card offers the reader instead. Only asked while `enabled`
 * (offline, empty grid), so the online path pays no IndexedDB read.
 */
export function useCachedTranscriptAt(sessionId: string, enabled: boolean): number | null {
  const [at, setAt] = useState<{ id: string; savedAt: number } | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    getTranscriptAt(sessionId)
      .then((r) => { if (live) setAt(r ? { id: sessionId, savedAt: r.savedAt } : null); })
      .catch(() => { if (live) setAt(null); });
    return () => { live = false; };
  }, [sessionId, enabled]);
  return enabled && at?.id === sessionId ? at.savedAt : null;
}
