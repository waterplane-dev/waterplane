/**
 * **Which of the things this phone wrote have actually reached the desktop.**
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * Everything a person AUTHORS in this app is written locally first and synced
 * afterwards — prompt templates, the toolbar, hidden repos, the fan-out presets,
 * and above all the PAD, which is by design the last copy of words nobody has
 * decided about yet. The write lands in `localStorage`, `settings.ts`'s patch
 * stamps it and pushes it, and the screen shows the new value immediately.
 *
 * That is the right behaviour and it is also, on this app's link, a lie of
 * omission: the value on screen looks identical whether the desktop has it or
 * whether it is sitting in a phone that has been off the tunnel for a day. The
 * one question a person asks about a synced store — *is this actually
 * anywhere but here?* — had no answer on any screen.
 *
 * ── The signal was already on the wire ──────────────────────────────────────
 *
 * Nothing new had to be sent for this. `routes/system.ts` broadcasts
 * `settings.update` to EVERY socket "the writer included: the echo is what
 * confirms the write landed" — and `applyRemoteSetting` recognised that echo,
 * for years, only to drop it:
 *
 *     if (ts <= known) return; // our own echo, or a value we have already beaten
 *
 * The confirmation arrived and was thrown away one line before it could be
 * recorded. This module is where it goes instead.
 *
 * ── The four states, and why none of them collapses into another ────────────
 *
 * `synced`      the desktop holds what this phone holds.
 * `pending`     this phone wrote it, the desktop has not confirmed.
 * `offline`     …and there is no desktop to confirm it right now.
 * `superseded`  another device wrote a newer value and it replaced ours.
 *
 * **`pending` and `offline` are deliberately separate**, for the reason
 * `useRemoteResource` gives about `error` and `offline`: "waiting for the
 * desktop" and "there is no desktop right now" are different sentences, and
 * only one of them is a reason to look for a problem. Collapsing them is how a
 * push that is genuinely stuck reads as a bad tunnel for a week.
 *
 * **`superseded` is not a failure**, and saying so matters more here than
 * anywhere: last-write-wins on the whole value is what the HOST does, so
 * "another device replaced this" is an ordinary outcome that a person
 * nonetheless has to be able to see. The pad merges per note on adopt
 * (`shared/pad.ts`), so nothing of theirs was dropped; this says why the value
 * moved.
 *
 * `unknown` is the fifth and is not a state anybody renders: it is the honest
 * answer between a cold start and the `settings.all` that arrives on hello, and
 * a screen shows NOTHING rather than claiming either way. That window is about
 * a second on a live link and for ever on a dead one — which is exactly when a
 * confident "synced" would be the most damaging thing to print.
 *
 * ── Not persisted, on purpose ───────────────────────────────────────────────
 *
 * A stored verdict would survive a reload and be a claim about a conversation
 * this process never had. `settings.all` lands on every connect and carries the
 * host's timestamp for every key, so the truth is re-derived from the source
 * within a second of there being a link at all — and until then the answer is
 * `unknown`, which is what it is.
 */

/** What a screen may say about one synced key. */
export type SyncPhase = "unknown" | "synced" | "pending" | "offline" | "superseded" | "failed";

export interface SyncState {
  phase: SyncPhase;
  /** When this phone last wrote it. `null` when this phone never has. */
  wroteAt: number | null;
  /** The newest instant the desktop is known to hold. `null` until it says. */
  ackedAt: number | null;
}

interface Entry { wroteAt: number | null; ackedAt: number | null; superseded: boolean }

const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();
/** The link, as the app already knows it. An input rather than a second
 *  derivation — `link.ts` is the ONE writer of online-ness and this must not
 *  become a fifth. */
let online = false;

function entry(key: string): Entry {
  let e = entries.get(key);
  if (!e) { e = { wroteAt: null, ackedAt: null, superseded: false }; entries.set(key, e); }
  return e;
}

function emit(): void { for (const fn of listeners) fn(); }

/** Subscribe to any change. Deliberately coarse — the screens that render this
 *  show a line per SHEET, not a mark per key, so a per-key subscription would
 *  be machinery with no reader. */
export function subscribeSync(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** This phone wrote a synced key. Called from `settings.ts`'s patch, so no call
 *  site has to remember — the same argument that patch itself rests on. */
export function noteLocalWrite(key: string, ts: number): void {
  const e = entry(key);
  e.wroteAt = ts;
  e.superseded = false;
  emit();
}

/** The desktop is known to hold this phone's value for this key. */
export function noteSynced(key: string, ts: number): void {
  const e = entry(key);
  if (e.ackedAt != null && e.ackedAt >= ts) return;
  e.ackedAt = ts;
  e.superseded = false;
  emit();
}

/** Another device's newer value replaced what this phone had. */
export function noteSuperseded(key: string, ts: number): void {
  const e = entry(key);
  e.ackedAt = ts;
  e.superseded = true;
  emit();
}

/** The link changed. `link.ts` owns the fact; this only renders differently. */
export function setSyncOnline(v: boolean): void {
  if (online === v) return;
  online = v;
  emit();
}

export function syncStateOf(key: string): SyncState {
  const e = entries.get(key);
  if (!e || (e.wroteAt == null && e.ackedAt == null)) return { phase: "unknown", wroteAt: null, ackedAt: null };
  const base = { wroteAt: e.wroteAt, ackedAt: e.ackedAt };
  if (e.superseded) return { phase: "superseded", ...base };
  // Confirmed when the desktop's instant is at least as new as our write. A
  // phone that has never written a key but has heard the host's value for it is
  // synced too — there is nothing of ours outstanding.
  if (e.wroteAt == null || (e.ackedAt != null && e.ackedAt >= e.wroteAt)) return { phase: "synced", ...base };
  return { phase: online ? "pending" : "offline", ...base };
}

/**
 * The worst phase across a set of keys — what a SHEET says about everything it
 * edits.
 *
 * "Worst" is by how much a person needs to know, which is the same argument
 * `activityRows`' bucket order rests on: something that GAVE UP outranks
 * something replaced behind your back, which outranks something still on its
 * way, which outranks a link that is simply down, which outranks all-clear.
 * `unknown` loses to everything, since one key nobody has heard about must not
 * silence a real answer about the others — and wins only when it is all there
 * is. (`failed` cannot arise from a settings key; it is `queueSync`'s, and it
 * is ranked here so the two vocabularies stay one.)
 */
const RANK: Record<SyncPhase, number> = { failed: 5, superseded: 4, pending: 3, offline: 2, synced: 1, unknown: 0 };

export function worstSync(keys: readonly string[]): SyncState {
  let worst: SyncState = { phase: "unknown", wroteAt: null, ackedAt: null };
  for (const k of keys) {
    const s = syncStateOf(k);
    if (RANK[s.phase] > RANK[worst.phase]) worst = s;
  }
  return worst;
}

/**
 * The sentence. One wording, so a pad, a template list and a settings page
 * cannot describe the same fact three ways.
 *
 * `thing` stays in object position in every one of them — `Empty.tsx`'s rule,
 * and for its reason: a template that has to agree in number with a caller's
 * noun is wrong for half of them.
 */
export function syncSentence(s: SyncState, thing = "these", plural = true): string | null {
  // The one place number agreement is allowed in, because the alternative is a
  // second copy of five sentences for the singular — and a row chip's title and
  // a sheet's line saying the same fact two ways is the failure this whole file
  // exists to prevent.
  const are = plural ? "are" : "is";
  const were = plural ? "were" : "was";
  switch (s.phase) {
    case "synced": return `saved on the desktop — ${thing} ${are} on more than this phone`;
    case "pending": return `not on the desktop yet — ${thing} ${are} still only on this phone`;
    case "offline": return `no connection — ${thing} ${are} only on this phone until the link is back`;
    case "superseded": return `another device wrote a newer version — ${thing} ${were} replaced, and nothing of yours was deleted`;
    case "failed": return `the send gave up — ${thing} never reached the desktop, and the words are still here`;
    default: return null;
  }
}

/** Test seam: forget everything. Never called by the app. */
export function resetSyncState(): void { entries.clear(); online = false; emit(); }

// ────────────────────────────────────────────────────────────────────────────
// The other half: things whose sync rides the SEND QUEUE
// ────────────────────────────────────────────────────────────────────────────

/**
 * A schedule, a work item, a session that was opened — these do not travel
 * through `settings.ts`'s last-write-wins merge. They are durable ops in
 * `outbox.ts`, and the proof they arrived is different: the host's own list
 * comes back carrying the row.
 *
 * The vocabulary is deliberately the SAME one. A person asking "is this
 * anywhere but this phone?" is asking one question, and answering it with
 * "synced" on the pad and "armed" on a schedule is how two words for one fact
 * become two mental models of one app.
 *
 * The four inputs, and why none is inferred from another:
 *
 *  - `queued`  the send is still in this phone's queue. Nothing about the host.
 *  - `failed`  it gave up. **Not the same as queued**, and it used to render as
 *              it: a `schedule.save` that had exhausted its retries still sat in
 *              the pending list and still drew the amber "queued" chip, so the
 *              one row that will never arrive was the one claiming to be on its
 *              way. A failed row outranks everything for that reason.
 *  - `onHost`  the host's own listing carries this id. This is the ONLY thing
 *              that earns a green mark — an ack says a frame was taken, the
 *              listing says it was stored.
 *  - `online`  splits "waiting for the desktop" from "there is no desktop", the
 *              same split `syncStateOf` makes and for the same reason.
 *
 * `unknown` when none of them holds: a row this phone neither wrote nor has
 * heard the host list. Screens render nothing for it rather than guessing.
 */
export function queueSync(o: {
  queued: boolean;
  failed?: boolean;
  onHost: boolean;
  online: boolean;
}): SyncPhase {
  if (o.failed) return "failed";
  if (o.queued) return o.online ? "pending" : "offline";
  return o.onHost ? "synced" : "unknown";
}

/**
 * The chip word — what a LIST ROW says, where the full sentence would be the
 * same ten lines of prose ten times over.
 *
 * The sentence still exists: it is the chip's `title`, and on the screens that
 * have room `SyncMark` prints it. What a LIST cannot do is say nothing in the
 * good case — that silence is the entire complaint this whole file answers, and
 * a list is exactly where it bit: a schedule that had reached the desktop and
 * one that was stuck in a phone rendered identically.
 *
 * Saying it on EVERY row was the other failure: ten cards each wearing "on
 * desktop" is one fact printed ten times, and a chip that never changes is a
 * chip the eye stops reading — so the one row NOT on the desktop looked like the
 * rest. A list may therefore say the good case ONCE, at its head
 * (`syncSummary`), and a row then wears a chip only when it is the exception
 * (`rowChipWord(phase, true)`). Never silence on both: a list that drops the
 * row's green chip must draw the head.
 */
export function syncChipWord(phase: SyncPhase): string | null {
  switch (phase) {
    case "synced": return "on desktop";
    case "pending": return "queued";
    case "offline": return "queued · offline";
    case "superseded": return "replaced";
    case "failed": return "not sent";
    default: return null;
  }
}

/**
 * A row's chip word on a list whose HEAD already says the good case
 * (`saidAbove`): the exceptions only. Without `saidAbove` it is
 * `syncChipWord`, unchanged — a list with no head summary keeps its green
 * chips, because a row may never be silent about where it is.
 */
export function rowChipWord(phase: SyncPhase, saidAbove = false): string | null {
  return saidAbove && phase === "synced" ? null : syncChipWord(phase);
}

/**
 * The good case of a whole list, said once at its head — what lets its rows
 * drop the green chip (`rowChipWord(phase, true)`).
 *
 * The word is `syncChipWord("synced")`: the same claim at a third size. It says
 * a bare "on desktop" only when EVERY row with an answer is there; otherwise it
 * COUNTS ("3 of 4 on desktop"), because a bare "on desktop" over a list holding
 * one queued row is the green light this file was written to retire — the
 * exception still wears its own chip below. `unknown` rows are counted neither
 * way (no honest answer, so no claim), and with no synced row at all the head
 * says nothing: the rows' own chips are then the whole story.
 */
export function syncSummary(phases: readonly SyncPhase[]): { word: string; title: string } | null {
  const known = phases.filter((p) => p !== "unknown").length;
  const synced = phases.filter((p) => p === "synced").length;
  if (synced === 0) return null;
  const on = syncChipWord("synced")!;
  const all = synced === known;
  const rows = all
    ? known === 1 ? "the one row here" : `all ${known} rows here`
    : `${synced} of the ${known} rows here`;
  return {
    word: all ? on : `${synced} of ${known} ${on}`,
    title: syncSentence({ phase: "synced", wroteAt: null, ackedAt: null }, rows, all ? known !== 1 : synced !== 1)!,
  };
}

/**
 * How many of these keys this phone is still holding alone.
 *
 * A COUNT rather than `worstSync`'s verdict, because the strip's all-clear is
 * the sentence "there is nothing left", and a verdict cannot say how far from
 * it you are. `superseded` is not counted: another device's value replacing
 * ours leaves nothing of ours outstanding, which is precisely why it is not a
 * failure.
 */
export function outstandingSync(keys: readonly string[]): number {
  let n = 0;
  for (const k of keys) {
    const p = syncStateOf(k).phase;
    if (p === "pending" || p === "offline") n++;
  }
  return n;
}
