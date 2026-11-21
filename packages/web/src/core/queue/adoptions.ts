/**
 * Which `pending:<createAck>` screens became which real session — pure, no storage, no React.
 *
 * `adoptPendingSession` moves the screen and its draft only when the person is standing on the pending
 * screen at ack time. A write aimed at the old id afterwards (the annotator's landing, a seed, a stale
 * composer) would otherwise sit under a key no screen loads again and be rescued onto the PAD although the
 * session DID open (2026-11-20, twice). So every adoption is remembered, bounded, and a later write
 * aimed at an adopted id is redirected to the session (`redirectDraftWrite`, APPENDING, never clobbering).
 */
import { parsePendingId } from "./pendingId";

export type Adoptions = Record<string, { sid: string; at: number }>;
export const ADOPTION_CAP = 50;
export const ADOPTION_TTL_MS = 604_800_000; // a bounded memory (a week of ms), not a calendar rule

/** Record one adoption; bounded by age and count (oldest go first). */
export function recordAdoption(map: Adoptions, createAck: string, sessionId: string, now: number): Adoptions {
  const next: Adoptions = { ...map, [createAck]: { sid: sessionId, at: now } };
  const live = Object.entries(next)
    .filter(([, v]) => v && typeof v.sid === "string" && typeof v.at === "number" && now - v.at <= ADOPTION_TTL_MS)
    .sort((a, b) => b[1].at - a[1].at)
    .slice(0, ADOPTION_CAP);
  return Object.fromEntries(live);
}

/** The session a `pending:<ack>` id was adopted into; null if it was not (or is not a pending id). */
export function adoptedSession(map: Adoptions, id: string): string | null {
  const ack = parsePendingId(id);
  return ack ? map[ack]?.sid ?? null : null;
}

/**
 * Where a draft write for `id` really goes. `text` empty on an adopted id only clears the stale key
 * (it must not erase the session's own draft). Non-empty text lands in the session's draft: set when
 * that is empty, left alone when it already holds these words, appended (blank line) otherwise.
 */
export function redirectDraftWrite(
  drafts: Record<string, string>, map: Adoptions, id: string, text: string,
): { drafts: Record<string, string>; sid: string | null } {
  const sid = adoptedSession(map, id);
  if (!sid) return { drafts, sid: null };
  const next = { ...drafts };
  delete next[id];
  if (text) {
    const have = next[sid] ?? "";
    next[sid] = !have ? text : have.includes(text) ? have : `${have}\n\n${text}`;
  }
  return { drafts: next, sid };
}

/** A stranded pending draft that has an adoption: the session to append it to, else null. */
export const strandedTarget = (map: Adoptions, id: string): string | null => adoptedSession(map, id);
