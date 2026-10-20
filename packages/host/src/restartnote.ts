/**
 * Why the next SIGTERM is coming, as said by whoever is about to send it.
 *
 * The SIGTERM handler (`server/shutdown.ts`) knows THAT the host is going, never
 * WHY: `npm run restart`, `update`, a launchd kick and a hand kill all arrive as
 * the same signal. The caller does know, so it posts one sentence here first
 * (`POST /api/host/restart-note`, loopback only) and `host.restarting` carries
 * it to the phone. A note older than `NOTE_TTL_MS` is dropped rather than
 * attached to an unrelated later restart; no note ⇒ no reason, never a guess.
 */

/** Long enough to cover `npm run restart`'s build, which runs between the note and the signal. */
export const NOTE_TTL_MS = 10 * 60_000;
const MAX_CHARS = 160;

let note: { reason: string; at: number } | null = null;

/** One line of plain text, or null when nothing usable is left. */
export function cleanReason(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  // eslint-disable-next-line no-control-regex
  const s = raw.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  if (!s) return null;
  return s.length > MAX_CHARS ? `${s.slice(0, MAX_CHARS - 1)}…` : s;
}

export function setRestartNote(raw: unknown, now = Date.now()): boolean {
  const reason = cleanReason(raw);
  if (!reason) return false;
  note = { reason, at: now };
  return true;
}

/** The pending reason, if fresh. */
export function restartReason(now = Date.now()): string | undefined {
  return note && now - note.at <= NOTE_TTL_MS ? note.reason : undefined;
}
