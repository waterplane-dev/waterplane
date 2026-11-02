/**
 * The note a backlog/Activity row wears while the session its work runs in is
 * behind a SIGN-IN (`blockOf(s)?.kind === "auth"`), the sibling of `netStalledOf`:
 * the row stays `running` — the host holds it like a net stall and never fails
 * it for its silence — and says why, in the one sentence every reader shares.
 *
 * Pure, so `NetStalled.tsx` (which draws it) and `signedOutStall.test.mjs`
 * read the same edge. Null for a row that is not running, has no session, or
 * whose session is behind anything but a sign-in.
 */
import { SIGNED_OUT_STALL_TEXT, blockOf, type SessionInfo } from "@waterplane/shared";

export function signedOutStallText(
  row: { state: string; sessionId?: string | null },
  sessions: readonly SessionInfo[],
): string | null {
  if (row.state !== "running" || !row.sessionId) return null;
  const s = sessions.find((x) => x.id === row.sessionId);
  const b = s ? blockOf(s) : null;
  if (!b || b.kind !== "auth") return null;
  // Signed out: the shared sentence. Once signed in again the block's own words
  // say where it stands ("signed in again — continue?", "continuing after the sign-in").
  return b.phase === "needsYou" ? SIGNED_OUT_STALL_TEXT : (b.detail ?? SIGNED_OUT_STALL_TEXT);
}
