/**
 * What happens to a recording the desktop could not read YET — the pure half.
 *
 * ── The failure this exists for ─────────────────────────────────────────────
 *
 * Reported, with a screenshot of the activity strip reading *sending · 15s —
 * the connection may be down*: **"very annoying to talk for a minute and then
 * see it run into an error due to connection"**. That strip was the dictation
 * itself. A minute of speech is 1.9 MB of 16 kHz PCM, the POST carries all of
 * it before a single response header comes back, and `api.dictate` went out on
 * the ordinary JSON fuse — `FETCH_TIMEOUT_MS`, 20 seconds. On a tunnel that is
 * merely SLOW the upload does not finish inside the fuse, the request is
 * aborted, and `useVoice` showed a toast and dropped the only copy of the
 * audio. A typed prompt in the same second would have been queued, retried and
 * delivered minutes later; the spoken one was gone.
 *
 * So a recording becomes a THING THAT WAITS, exactly like a queued prompt: the
 * bytes are parked before the first attempt, the attempt is retried for as long
 * as it takes, and the words land when they land. This module is the part of
 * that with no browser in it — which clip is next, when it may be tried again,
 * what the button says, and what a person is told.
 *
 * ── Why it never gives up ───────────────────────────────────────────────────
 *
 * The send queue eventually marks a delivery `failed`, because a prompt that
 * was never delivered is still on screen in full and can be sent again by hand.
 * A recording cannot: the audio exists nowhere but here, and nobody can re-say
 * a sentence they said a minute ago the same way. The ladder therefore backs
 * off (`retryDelay`, 2 s doubling to a minute) and keeps going. What is bounded
 * instead is how much can be WAITING — `HOLD_CAP` clips, `HOLD_MAX_BYTES` of
 * them — and the cap REFUSES a new recording rather than shedding an old one,
 * for `addPadNote`'s reason: an old clip is old exactly because nobody has had
 * their words back yet.
 */
import { retryDelay } from "@waterplane/shared";

/**
 * One recording waiting to be read, as it is persisted.
 *
 * The bytes are NOT here — they live in IndexedDB under `id` (a WAV is
 * megabytes, and localStorage is where the send queue lives; see `idb.ts`'s
 * `uploads` store for the same split and the same reason).
 */
export interface HeldClip {
  /** Key of the WAV in the `dictations` store, and the id a listener claims. */
  id: string;
  /** When it was recorded — the FIFO order, so words come back in the order
   *  they were said even when three clips are waiting on one tunnel. */
  ts: number;
  /** Length of the audio, for the sentence a person is told. */
  seconds: number;
  bytes: number;
  /** Recogniser language, as the capture decided it. */
  lang?: string;
  /** Attempts made. Never reset — it is the backoff clock. */
  tries: number;
  /** Earliest ms-epoch this may be attempted again. Cleared by a reconnect and
   *  by any explicit retry: a link that just came back is new information and
   *  must not be made to wait out a backoff computed while it was down. */
  retryAt?: number;
  /** The "it is being held" sentence has been said for this clip. Said ONCE:
   *  a toast per retry is noise about a condition that has not changed. */
  told?: boolean;
}

/**
 * How many recordings may be waiting at once, and how many bytes of them.
 *
 * Twelve clips at the five-minute cap is 96 MB, which is why there is a byte
 * bound as well — a phone that has been dictating into a dead tunnel for an
 * afternoon must not be the reason IndexedDB starts evicting the send queue's
 * image bytes. Both are deliberately generous: the common case is one clip.
 */
export const HOLD_CAP = 12;
export const HOLD_MAX_BYTES = 48 * 1024 * 1024;

/**
 * May one more recording be parked? The REASON when it may not.
 *
 * Refuses rather than sheds (`addPadNote`'s rule). The sentence names the
 * condition and what to do about it, because the alternative reading — "the
 * microphone is broken" — is the one a person reaches for otherwise.
 */
export function holdRefusal(held: readonly HeldClip[], bytes: number): string | null {
  if (held.length >= HOLD_CAP) {
    return `${held.length} recordings are already waiting for the desktop — nothing is lost, but this one was not kept`;
  }
  const total = held.reduce((n, c) => n + c.bytes, 0);
  if (total + bytes > HOLD_MAX_BYTES) {
    return "there is already more audio waiting than this phone will hold — this one was not kept";
  }
  return null;
}

/** The clip to attempt now: oldest first, and only one whose backoff is up. */
export function nextDue(held: readonly HeldClip[], now: number): HeldClip | null {
  const due = held.filter((c) => (c.retryAt ?? 0) <= now);
  if (!due.length) return null;
  return due.reduce((a, b) => (a.ts <= b.ts ? a : b));
}

/** The same clip after an attempt nobody answered: one more try on the clock. */
export function afterMiss(clip: HeldClip, now: number): HeldClip {
  const tries = clip.tries + 1;
  return { ...clip, tries, retryAt: now + retryDelay(tries) };
}

/** Every backoff cleared — what a reconnect does to the whole hold. */
export function releaseHold(held: readonly HeldClip[]): HeldClip[] {
  return held.map((c) => ({ ...c, retryAt: undefined }));
}

/** When the pump should look again: the nearest backoff, or null if something
 *  is due right now or nothing is waiting. */
export function nextWakeAt(held: readonly HeldClip[], now: number): number | null {
  // Something due NOW needs a pump, not a timer — answering a clock for that
  // case would park a clip that could be on the wire this second.
  if (held.some((c) => (c.retryAt ?? 0) <= now)) return null;
  const waits = held.map((c) => c.retryAt ?? 0).filter((t) => t > now);
  if (!waits.length) return null;
  return Math.min(...waits);
}

/** Round seconds the way a person says them, for every sentence below. */
function saidFor(seconds: number): string {
  const s = Math.max(1, Math.round(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  return rest ? `${m}m ${rest}s` : `${m}m`;
}

/** What the microphone button says about work it is holding, as its title
 *  (`VoiceButton`) — the badge carries the count. */
export function holdTitle(held: number, sending: boolean): string | null {
  if (sending && held > 1) return `the desktop is reading what you said — ${held - 1} more recording${held - 1 === 1 ? "" : "s"} behind it`;
  if (sending) return "the desktop is reading what you said";
  if (held === 1) return "one recording is waiting for the desktop — it is read the moment the link is back, and the words come to the box";
  if (held > 1) return `${held} recordings are waiting for the desktop — they are read in the order you said them, the moment the link is back`;
  return null;
}

/**
 * Is what came back actually words?
 *
 * whisper answers `"."` for a clip with no speech in it — measured here, a
 * two-second tone POSTed to the route came back as exactly that. A lone full
 * stop appended to somebody's prompt is a guess about what they said, which is
 * the one thing this feature does not do; so a transcript with no letter and no
 * digit in it is silence, said as silence, and nothing is written.
 */
export function saidNothing(text: string): boolean {
  return !/[\p{L}\p{N}]/u.test(text);
}

/** Said ONCE per clip, when an attempt failed and the audio went into the hold:
 *  the point is that nothing was lost, which is the opposite of what the old
 *  "the host could not be reached" toast meant on this path. */
export function holdNews(clip: HeldClip): string {
  return `${saidFor(clip.seconds)} of what you said is held — the desktop could not be reached. It is read as soon as it can be, and the words come back to the box.`;
}

/** Said when the words come back and the box that asked for them is gone — a
 *  closed sheet, a reloaded app, a phone that was put away. They go to the pad,
 *  which is this app's home for words with no target yet. */
export function landedAwayWords(seconds: number): string {
  return `${saidFor(seconds)} of dictation came back after the box it was said into had gone — the words are on the pad.`;
}

/** Said when even the pad refused them (it is capped, and refusing is how it
 *  protects what is already written). The clip is KEPT; nothing is destroyed. */
export function landRefusedWords(reason: string): string {
  return `your words came back but could not be parked: ${reason}`;
}
