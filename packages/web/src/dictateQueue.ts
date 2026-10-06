/**
 * The recordings waiting to be read, and the pump that reads them.
 *
 * `useVoice.ts` used to do this inline: stop the microphone, POST the WAV, show
 * the answer or a toast. That is fine while the tunnel is fine, and it loses a
 * minute of somebody's speech the moment it is not — which is exactly what was
 * reported (see `dictateHold.ts` for the screenshot and the arithmetic). A
 * typed prompt on this app survives a dead link because it is QUEUED: parked
 * before it is sent, retried with a backoff, delivered when the link comes
 * back. This is that same promise for a spoken one.
 *
 * ── The shape ───────────────────────────────────────────────────────────────
 *
 *  - the WAV goes to IndexedDB (`dictations`) BEFORE any attempt, so the bytes
 *    outlive the request, the screen, and the app being killed;
 *  - the index of what is waiting is in localStorage (`dictateHold.ts` owns its
 *    rules and its words), so a cold start knows what it is holding;
 *  - one attempt at a time, oldest first — the desktop transcribes on one GPU
 *    and the words should come back in the order they were said;
 *  - an attempt bounds SILENCE, not the transfer (`STALL_MS`), for the reason
 *    `App.tsx`'s upload pump does: a 9 MB clip on a slow uplink is not a stall.
 *
 * ── Where the words land ────────────────────────────────────────────────────
 *
 * Whoever recorded the clip CLAIMS it (`claimDictation`), and gets the words if
 * it is still on screen — appended to what its box holds AT THAT MOMENT, never
 * to a snapshot from when the microphone opened (`appendDictation`). If it has
 * gone — a closed sheet, a reload, a phone put in a pocket for ten minutes —
 * the words go to the PAD, which is this app's home for words with no target
 * yet, and a toast says so. They are never dropped on the floor, and they never
 * overwrite something typed since.
 *
 * Nothing here sends anything anywhere: a transcription is a READ of the audio.
 * The words arrive in a box a person then decides about, exactly as before.
 */
import { appendDictation, serializeDictateTerms } from "@waterplane/shared";
import { dictateTerms } from "./dictateLang";
import { api, type UploadError } from "./api";
import { idbDel, idbGet, idbKeys, idbSet } from "./idb";
import { subscribeLink } from "./link";
import { addPadNote } from "./outbox";
import { LS, lsJson, lsSetJson } from "./storage";
import { showToast } from "./toast";
import {
  afterMiss,
  holdNews,
  holdRefusal,
  landRefusedWords,
  landedAwayWords,
  nextDue,
  saidNothing,
  nextWakeAt,
  releaseHold,
  type HeldClip,
} from "./dictateHold";

/**
 * No progress for this long ⇒ the transfer is wedged; abort it and put the clip
 * back on the ladder. Same rule and same reason as `UPLOAD_STALL_MS`: XHR's own
 * `timeout` bounds the WHOLE request, which would kill a legitimate five-minute
 * clip on a slow uplink. What is bounded here is silence.
 */
const STALL_MS = 45_000;

/**
 * How long a clip waits when the words came back and the PAD would not take
 * them. The ordinary ladder is wrong here: nothing about the link is broken, so
 * retrying in two seconds re-uploads megabytes of audio, re-runs whisper, and
 * gets the same refusal — the condition only clears when a person clears space
 * on the pad. The clip is kept, because the words are still recoverable; it
 * simply asks again at a human interval.
 */
const PAD_FULL_WAIT_MS = 5 * 60_000;

/** The store in `idb.ts` these bytes live in. */
const STORE = "dictations";

let clips: HeldClip[] = [];
let loaded = false;
/** The clip currently on the wire, if any. One at a time, always. */
let sending: string | null = null;
/** The pump is walking the hold. Set synchronously — see `pumpDictations`. */
let pumping = false;
let wake = 0;
const landers = new Map<string, (text: string) => boolean>();
const listeners = new Set<() => void>();

// ── The index ───────────────────────────────────────────────────────────────

function load(): HeldClip[] {
  if (loaded) return clips;
  loaded = true;
  const raw = lsJson<unknown>(LS.dictations, []);
  clips = Array.isArray(raw)
    ? raw.filter((c): c is HeldClip => !!c && typeof (c as { id?: unknown }).id === "string")
      .map((c) => ({ ...c, tries: Number(c.tries) || 0 }))
    : [];
  return clips;
}

function save(next: HeldClip[]): void {
  clips = next;
  lsSetJson(LS.dictations, next);
  emit();
}

function emit(): void { for (const fn of listeners) fn(); }

/** What the microphone buttons draw from: how many are waiting, and whether one
 *  is on the wire right now. */
export interface DictateHoldState { held: number; sending: boolean }

export function dictationState(): DictateHoldState {
  return { held: load().length, sending: sending !== null };
}

export function subscribeDictations(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

// ── Parking a recording ─────────────────────────────────────────────────────

/**
 * Park a recording and start trying to read it. The id is what a caller claims
 * the words with; a REASON instead means nothing was kept, and the caller says
 * so rather than pretending the audio is safe.
 *
 * The bytes are written BEFORE the index, and the index is what the pump reads:
 * an id that has no blob behind it is a promise this module cannot keep, which
 * is the same rule `queueImageUpload` follows for an attachment.
 */
export async function holdDictation(wav: Blob, o: { seconds: number; lang?: string }): Promise<{ id: string } | { error: string }> {
  const held = load();
  const refusal = holdRefusal(held, wav.size);
  if (refusal) return { error: refusal };
  const id = `d_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  await idbSet(STORE, id, wav);
  // Written, and CHECKED — by key, never by reading the blob back: `idbSet`
  // swallows a quota refusal, and an index entry with no bytes behind it is a
  // promise this module cannot keep (`queueImageUpload`'s rule for a picture).
  if (!(await idbKeys(STORE)).includes(id)) {
    return { error: "this phone would not store the recording, so it was not kept" };
  }
  save([...load(), { id, ts: Date.now(), seconds: o.seconds, bytes: wav.size, lang: o.lang, tries: 0 }]);
  void pumpDictations();
  return { id };
}

/**
 * "These words are mine" — the box that recorded the clip, for as long as it is
 * on screen. The callback answers whether it actually took them; anything else
 * (it returned false, or it was never registered because the app has since
 * reloaded) sends them to the pad.
 */
export function claimDictation(id: string, land: (text: string) => boolean): () => void {
  landers.set(id, land);
  return () => { if (landers.get(id) === land) landers.delete(id); };
}

/** Forget one clip completely — index, bytes and any claim on it. */
function drop(id: string): void {
  landers.delete(id);
  save(load().filter((c) => c.id !== id));
  void idbDel(STORE, id);
}

// ── The pump ────────────────────────────────────────────────────────────────

/**
 * Work through whatever is due, oldest first, one at a time.
 *
 * The busy flag is set SYNCHRONOUSLY and the walk is a loop rather than a tail
 * call, and both are the same rule: `holdDictation`, a reconnect and the wake
 * timer all call this, and two of them landing in the same tick either side of
 * an `await` would put one recording on the wire twice. Every branch below
 * either drops the clip or gives it a future `retryAt`, so the loop always
 * makes progress and always ends at `schedule()`.
 */
export async function pumpDictations(): Promise<void> {
  if (pumping) return;
  pumping = true;
  try {
    for (;;) {
      const clip = nextDue(load(), Date.now());
      if (!clip) { schedule(); return; }
      await attempt(clip);
    }
  } finally { pumping = false; }
}

/** One recording, one attempt. Leaves the clip dropped or backed off. */
async function attempt(clip: HeldClip): Promise<void> {
  const blob = await idbGet<Blob>(STORE, clip.id);
  if (!blob) {
    // The one unrecoverable case, and it is said plainly rather than silently:
    // storage pressure (or a browser clearing site data) took the audio. There
    // is nothing to retry — a retry would upload nothing.
    drop(clip.id);
    showToast("a recording waiting to be read is no longer on this phone");
    return;
  }

  sending = clip.id;
  emit();
  const ctrl = new AbortController();
  let stall = 0;
  const armStall = () => {
    window.clearTimeout(stall);
    stall = window.setTimeout(() => ctrl.abort(), STALL_MS);
  };
  armStall();
  try {
    const terms = serializeDictateTerms(dictateTerms());
    const answer = await api.dictate(blob, { lang: clip.lang, terms, signal: ctrl.signal, onProgress: armStall });
    // A reason IS the desktop's answer about this audio — no model installed,
    // nothing said, not a shape it can read. None of those change on a retry,
    // so the clip goes and the sentence is shown.
    if ("error" in answer) { drop(clip.id); showToast(answer.error); }
    else await landWords(clip, answer.text);
  } catch (err) {
    if ((err as UploadError)?.permanent) { drop(clip.id); showToast((err as Error).message); }
    else miss(clip);
  } finally {
    window.clearTimeout(stall);
    sending = null;
    emit();
  }
}

/** An attempt nobody answered: back on the ladder, and said ONCE. */
function miss(clip: HeldClip): void {
  const next = afterMiss(clip, Date.now());
  const first = !clip.told;
  save(load().map((c) => (c.id === clip.id ? { ...next, told: true } : c)));
  // Said once. A sentence per retry would be a toast every few seconds about a
  // condition that has not changed, and the button already says it is holding.
  if (first) showToast(holdNews(clip));
}

/** Hand the words over: to the box that asked, or to the pad. */
async function landWords(clip: HeldClip, text: string): Promise<void> {
  const said = text.trim();
  if (!said || saidNothing(said)) { drop(clip.id); showToast("nothing was said"); return; }
  const take = landers.get(clip.id);
  if (take && take(said)) { drop(clip.id); return; }
  const refusal = addPadNote({ id: `p_${clip.id}`, text: said, ts: Date.now() });
  if (refusal) {
    // The pad refuses rather than sheds when it is full, and so does this: the
    // clip STAYS, on the ladder, so the words can still be recovered once
    // there is room. Nothing is destroyed for being late.
    save(load().map((c) => (c.id === clip.id
      ? { ...c, tries: c.tries + 1, retryAt: Date.now() + PAD_FULL_WAIT_MS, told: true }
      : c)));
    if (!clip.told) showToast(landRefusedWords(refusal));
    return;
  }
  drop(clip.id);
  showToast(landedAwayWords(clip.seconds));
}

/** Look again when the nearest backoff is up. One timer for the whole hold. */
function schedule(): void {
  window.clearTimeout(wake);
  const at = nextWakeAt(load(), Date.now());
  if (at === null) return;
  wake = window.setTimeout(() => { void pumpDictations(); }, Math.max(250, at - Date.now()));
}

/** A link that just came back is new information: every backoff computed while
 *  it was down is stale, so the whole hold is released and tried at once. */
export function releaseDictations(): void {
  if (!load().some((c) => c.retryAt)) { void pumpDictations(); return; }
  save(releaseHold(load()));
  void pumpDictations();
}

// ── Boot ────────────────────────────────────────────────────────────────────

/**
 * Pick up whatever this phone was holding and keep trying — installed in
 * `main.tsx` above `App`, for the case the feature exists for: the app was
 * killed with words in it, and nobody has to open the right screen for them to
 * come back.
 *
 * It also sweeps blobs the index no longer names. That is not tidiness: those
 * are megabytes of audio that would otherwise sit in IndexedDB for ever, on the
 * one device whose storage the send queue's images are also competing for.
 */
export function installDictations(): void {
  load();
  window.addEventListener("online", releaseDictations);
  // The TRANSITION, not the state: this store emits for every ping and byte
  // counted, and releasing on each of them would rewrite the index continuously
  // while the link is perfectly fine.
  let wasOpen = false;
  subscribeLink((s) => {
    const open = s.status === "open";
    if (open && !wasOpen) releaseDictations();
    wasOpen = open;
  });
  void sweepOrphans();
  void pumpDictations();
}

async function sweepOrphans(): Promise<void> {
  const keys = await idbKeys(STORE);
  const known = new Set(load().map((c) => c.id));
  for (const k of keys) if (!known.has(k)) void idbDel(STORE, k);
}

/** Append transcribed words to what a box holds NOW — re-exported so the two
 *  microphone chromes reach for one rule rather than writing `base + text`. */
export { appendDictation };

/**
 * Throw away every recording still waiting to be read — the storage screen's
 * button (`storageAudit.ts`).
 *
 * Nobody can re-say a sentence, so this is a `keep` row that asks twice. Two
 * things make it more than an `idbClear`:
 *
 *  - **the index and the bytes go together.** They live in two different
 *    stores (localStorage and IndexedDB) and this module's whole contract is
 *    that an index entry always has bytes behind it — clearing one side leaves
 *    the pump chasing ids whose audio is gone, which is the failure
 *    `holdDictation` writes the bytes first to avoid.
 *  - **the clip on the wire right now is left alone.** It is mid-send; its
 *    words may be about to land, and deleting its audio under the request
 *    turns a transcription that was working into a loss. It stays held and is
 *    reported back, so the screen can say the number it did not take.
 */
export async function forgetDictations(): Promise<{ dropped: number; bytes: number; kept: number }> {
  const held = load();
  const busy = sending;
  const doomed = held.filter((c) => c.id !== busy);
  for (const c of doomed) await idbDel(STORE, c.id);
  save(held.filter((c) => c.id === busy));
  return {
    dropped: doomed.length,
    bytes: doomed.reduce((n, c) => n + (c.bytes || 0), 0),
    kept: held.length - doomed.length,
  };
}
