/**
 * A latest-request token. `begin()` before an await, `current(token)` after it: the result is applied
 * only when nothing newer began and the owner was not left (`invalidate()`) in between.
 */
export function latest(): { begin(): number; current(token: number): boolean; invalidate(): void } {
  let n = 0;
  return { begin: () => ++n, current: (t) => t === n, invalidate: () => { n++; } };
}

/**
 * What leaving the sheet does, by the route's reason (`onLeave(reason)`): every leave makes a pending
 * remedy reply stale (nothing may navigate from a sheet nobody is looking at); only a CLOSE resets it
 * — a covered sheet keeps its repo, its cut and a read error for the Back that returns to it. No
 * reason (an older core) is treated as a cover: keeping is the safe half.
 */
export function leaveResets(reason: "close" | "cover" | undefined): boolean {
  return reason === "close";
}

export type RemedyReply = { ok: true; text: string } | { ok: false; error: string };
export interface RemedyOutcome { navigate: boolean; toast: string | null; sheetErr: string | null }

/**
 * What a remedy reply does, decided once. A CURRENT reply navigates (success) or lands its error on the
 * sheet; a STALE one never navigates, but its outcome is still said — in a toast naming the repo and the
 * check, because the sheet it belonged to is not what the person is looking at (ux §3: no tap ends in nothing).
 */
export function remedyOutcome(current: boolean, reply: RemedyReply, repoName: string, check: string): RemedyOutcome {
  if (current) return reply.ok
    ? { navigate: true, toast: reply.text, sheetErr: null }
    : { navigate: false, toast: null, sheetErr: reply.error };
  return reply.ok
    ? { navigate: false, toast: `${repoName}: ${reply.text}`, sheetErr: null }
    : { navigate: false, toast: `${repoName}: could not ask Claude about ${check} — ${reply.error}`, sheetErr: null };
}
