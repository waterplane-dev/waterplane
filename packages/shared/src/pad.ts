/**
 * The pad, as a value two devices can both write to without deleting each
 * other's words.
 *
 * The pad is a synced setting, and a synced setting is an OPAQUE STRING with
 * one `ts` — the host never parses it (`shared/settings.ts` argues why at
 * length). So the merge the host can perform is last-write-wins on the whole
 * value: a device that pushes its pad while holding an older copy replaces
 * every note the other one had, with no diff, no warning, and nothing on the
 * wire that distinguishes it from a deliberate delete. For a preference that is
 * the right rule; for the store whose entire job is to be the last copy of
 * words that never ran, it is a silent delete.
 *
 * Everything that used to compensate for that — a diff that guessed which
 * drops were losses, a device-local rescue store, an amber "N notes were kept
 * for you" block — is gone, because the merge is fixed instead. The CLIENT
 * merges per note on adopt (`web/settings.ts`'s `onAdopt`), the host still
 * stores a string and still compares a `ts`, and nothing on the wire changed.
 *
 * ── The shape, and why it is still one array ──────────────────────────────
 *
 * The synced value stays ONE JSON array under `waterplane.pad`, with two element
 * shapes discriminated by their fields: a note has a string `text`, a
 * tombstone has a finite `gone` and no text. It is not `{v:2,notes,tombs}`,
 * which would have been tidier, because an older bundle's `loadPad` and its
 * `onAdopt` guard both filter to elements with a string `text` — against an
 * array they drop the tombstones silently and keep a working pad, where
 * against an object they would show the user an EMPTY pad. The host's
 * `padNotesFor` already skips text-less elements for the same reason.
 *
 * ── The failure mode this chooses ─────────────────────────────────────────
 *
 * A legacy array parses as a `PadDoc` with `tombs: []`. So a delete made on a
 * device still running an old bundle — or one that fell more than
 * `PAD_TOMB_TTL_MS` behind the newest words either copy carries — is forgotten,
 * and the note comes back once, everywhere, wearing its original date. That
 * costs one tap. The failure it replaces cost words.
 *
 * Pinned by `packages/shared/test/pad.test.mjs`.
 */

/** One note on the pad. */
export interface PadNote {
  id: string;
  text: string;
  /**
   * When this note was last WRITTEN — not when it was first thought of.
   *
   * `PadSheet.commit()` stamps `Date.now()` on every save, an edit of an
   * existing note included, so this is a per-note edit stamp and that is what
   * `mergePad` compares. A field that only recorded creation could not decide
   * which of two copies of one id is the newer one, which is the whole merge.
   */
  ts: number;
  /** The rest of the chain — the steps after `text`, each delivered only once
   *  the one before it has finished its turn. Beside the text, never inside it. */
  steps?: string[];
  /** The repo this note was written FOR, when it has one: a note that names
   *  `.claude/inbox/…` paths only means anything inside one worktree, and a note
   *  that names a repo can be filed straight onto that repo's backlog. Absent on
   *  a hand-written note, which is the ordinary case. */
  cwd?: string;
}

/**
 * A delete, as something that can travel.
 *
 * Without one, "this note is not in my copy" is indistinguishable from "I have
 * not seen this note yet", and a union merge would resurrect every note anybody
 * ever deleted, for ever.
 */
export interface PadTombstone { id: string; gone: number }

/** The pad as this module reasons about it. */
export interface PadDoc { notes: PadNote[]; tombs: PadTombstone[] }

/**
 * Hard bounds on the pad — a COUNT that rarely binds and a BYTE budget that does.
 *
 * The pad is not a scratch list. It holds words that have no target yet, which
 * is the one kind this app cannot reconstruct from anywhere else. Both bind on
 * a LOCAL ADD only, and an add past them is REFUSED rather than silently
 * shedding the oldest note — a refusal leaves the words in the editor, where
 * their author can see them; shedding deleted a note precisely because it was
 * old, and a note is old exactly when nobody has dealt with it yet.
 */
export const PAD_CAP = 400;
export const PAD_BYTES = 512 * 1024;

/**
 * How long a tombstone suppresses the note it names: 30 days.
 *
 * The argument is "how long may a device be offline before its stale copy is
 * allowed to resurrect a delete", not the retired rescue store's 7 days, which
 * measured something else entirely. A month is the longest a phone left in a
 * drawer plausibly stays paired; past that the delete is forgotten and the
 * stale copy comes back once, wearing its old date.
 *
 * Measured against the PAD's own newest stamp, never against a device clock —
 * `mergePad` argues why at length. So "30 days" means 30 days of the pad being
 * written to without this delete travelling, which is the thing the number was
 * ever a guess about.
 */
export const PAD_TOMB_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Tombstones are capped like notes, newest `gone` kept. Same number, because
 *  the worst case is one tombstone per note and there is no reason for the two
 *  halves of one value to have different ceilings. */
export const PAD_TOMB_CAP = PAD_CAP;

// ── Parse and serialize ──────────────────────────────────────────────

function finite(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * Read the stored value, tolerating everything.
 *
 * Nothing here throws and nothing here is authoritative: a value written by a
 * newer bundle, an older one, or half a bundle must still produce a pad
 * somebody can use. Not an array (or unparseable) is an EMPTY doc, never an
 * error — the alternative is a sheet that cannot render.
 */
export function parsePad(raw: string | null | undefined): PadDoc {
  let list: unknown;
  try { list = raw ? JSON.parse(raw) : null; } catch { return { notes: [], tombs: [] }; }
  if (!Array.isArray(list)) return { notes: [], tombs: [] };
  const notes = new Map<string, PadNote>();
  const tombs = new Map<string, PadTombstone>();
  for (const el of list) {
    if (!el || typeof el !== "object") continue;
    const d = el as { id?: unknown; text?: unknown; ts?: unknown; steps?: unknown; cwd?: unknown; gone?: unknown };
    if (typeof d.id !== "string" || !d.id) continue;
    if (typeof d.text === "string") {
      const steps = Array.isArray(d.steps) ? d.steps.filter((s): s is string => typeof s === "string") : [];
      const note: PadNote = { id: d.id, text: d.text, ts: finite(d.ts) ?? 0 };
      if (steps.length) note.steps = steps;
      if (typeof d.cwd === "string" && d.cwd) note.cwd = d.cwd;
      // Duplicate ids keep the greater `ts`: two copies of one note in one
      // value is malformed, and the newer one is the one somebody typed last.
      const have = notes.get(note.id);
      if (!have || note.ts > have.ts) notes.set(note.id, note);
      continue;
    }
    const gone = finite(d.gone);
    if (gone !== null) {
      const have = tombs.get(d.id);
      if (!have || gone > have.gone) tombs.set(d.id, { id: d.id, gone });
    }
    // Anything else is dropped: an element that is neither a note nor a delete
    // says nothing, and guessing which it meant is how a pad loses a note.
  }
  return { notes: [...notes.values()], tombs: [...tombs.values()] };
}

function canonNote(n: PadNote): Record<string, unknown> {
  // Insertion order IS key order in `JSON.stringify`, so this is the fixed
  // order the canonical form promises.
  const o: Record<string, unknown> = { id: n.id, text: n.text, ts: n.ts };
  if (n.steps && n.steps.length) o.steps = n.steps;
  if (n.cwd) o.cwd = n.cwd;
  return o;
}

/** One note's canonical JSON — the merge's tie-break reads this, so it must be
 *  the same bytes the serializer would emit. */
function noteKey(n: PadNote): string { return JSON.stringify(canonNote(n)); }

/**
 * The value this device writes — CANONICAL, and that is load-bearing.
 *
 * Notes newest first (`ts` desc, then `id` asc), tombstones after them
 * (`gone` desc, then `id` asc), keys in a fixed order. The convergence in
 * `web/settings.ts` terminates only because two devices holding the same set of
 * notes produce byte-identical strings: the loser of a concurrent push
 * re-merges the winner's value, gets exactly that string back, and
 * `applyRemoteSetting`'s equality branch stops the exchange. A serializer that
 * ordered by insertion would hand the two devices two different strings for one
 * pad, and they would push at each other until one of them was closed.
 */
export function serializePad(doc: PadDoc): string {
  const notes = [...doc.notes].sort((a, b) => b.ts - a.ts || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const tombs = [...doc.tombs].sort((a, b) => b.gone - a.gone || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return JSON.stringify([...notes.map(canonNote), ...tombs.map((t) => ({ id: t.id, gone: t.gone }))]);
}

// ── The merge ────────────────────────────────────────────────────────

/**
 * Two copies of the pad, one pad.
 *
 * Commutative and idempotent by construction, which is what lets both devices
 * run it on whatever they happen to hold and land on the same value:
 *
 *  1. **Tombstones union** by id, greater `gone` wins; anything older than
 *     `PAD_TOMB_TTL_MS` **before the newest stamp in the union** is forgotten.
 *  2. **Per note id**, the copy with the greater `ts` is the candidate. On an
 *     exact tie the one whose canonical JSON sorts lexically LATER wins —
 *     "prefer mine" would make the function non-commutative, i.e. the two
 *     devices would converge on two different values and push for ever.
 *  3. A tombstone with `gone >= candidate.ts` drops the note. A candidate whose
 *     `ts` is GREATER than the tombstone's `gone` keeps the note **and drops
 *     the tombstone**: those are words somebody typed after the delete, and the
 *     delete was made on a device that had not seen them.
 *  4. **Then** the newest `PAD_TOMB_CAP` tombstones are kept.
 *  5. **No note is ever dropped for size here.** The caps bind on a local add,
 *     where a person is present to be told. A merge that shed notes would
 *     delete words on the device that was merely receiving them.
 *
 * ── Why the TTL is cut on the DATA and not on a clock ─────────────────────
 *
 * "Same union ⇒ same bytes" is the whole contract, and a `Date.now()` anywhere
 * inside it breaks that between two devices whose clocks disagree — which is
 * every pair of devices. Trace the version that read the clock: A is two hours
 * behind B, and a tombstone `T` has `gone` between the two cutoffs. A merges
 * the host's value, keeps `T`, sees `changed`, pushes. B adopts it, drops `T`,
 * sees `changed`, pushes. A adopts THAT, re-adds `T`, pushes — one round per
 * `PUSH_DEBOUNCE_MS` for the whole skew window, each one re-stamping the
 * setting and firing `announce`, and neither device is wrong.
 *
 * So the cutoff is `max(every ts and every gone across both copies) −
 * PAD_TOMB_TTL_MS`. It is a fact about the two documents, so both devices
 * compute it identically and the function is a pure fold over the union again.
 * The cost is that the newest tombstone in a pad nobody touches is never aged
 * out — which is correct: "30 days" was always meant as *30 days of the pad
 * moving on without this delete*, and a pad that has not moved has no newer
 * words for a stale copy to overwrite.
 *
 * `now` is therefore UNREAD, and kept in the signature deliberately: the call
 * sites pass it, and `pad.test.mjs` hands the two sides wildly different values
 * and asserts the bytes are identical, which is a pin a removed parameter
 * could not carry.
 *
 * ── Why the cap is applied AFTER rule 3 ───────────────────────────────────
 *
 * Cutting to `PAD_TOMB_CAP` first meant the resurrection rule then deleted
 * tombstones out of an already-cut list, so the output could hold fewer than
 * the cap while the union still held tombstones that belonged in it — and the
 * next exchange with the same peer put them back. The merged value was not a
 * fixed point of merging with its own input, which is the same
 * push-at-each-other loop by another route. Resurrect first, cut last: the cut
 * is then a function of what actually survived.
 */
export function mergePad(mine: PadDoc, theirs: PadDoc, _now?: number): PadDoc {
  const allTombs = [...mine.tombs, ...theirs.tombs].filter((t) => t && t.id && Number.isFinite(t.gone));
  const allNotes = [...mine.notes, ...theirs.notes].filter((n) => n && n.id);

  let latest = 0;
  for (const n of allNotes) if (Number.isFinite(n.ts) && n.ts > latest) latest = n.ts;
  for (const t of allTombs) if (t.gone > latest) latest = t.gone;
  const cutoff = latest - PAD_TOMB_TTL_MS;

  const live = new Map<string, PadTombstone>();
  for (const t of allTombs) {
    if (t.gone < cutoff) continue;
    const have = live.get(t.id);
    if (!have || t.gone > have.gone) live.set(t.id, { id: t.id, gone: t.gone });
  }

  const cand = new Map<string, PadNote>();
  for (const n of allNotes) {
    const have = cand.get(n.id);
    if (!have) { cand.set(n.id, n); continue; }
    if (n.ts > have.ts) { cand.set(n.id, n); continue; }
    if (n.ts === have.ts && noteKey(n) > noteKey(have)) cand.set(n.id, n);
  }

  const notes: PadNote[] = [];
  for (const n of cand.values()) {
    const tomb = live.get(n.id);
    if (!tomb) { notes.push(n); continue; }
    if (tomb.gone >= n.ts) continue; // deleted at or after these words: stay deleted
    live.delete(n.id); // typed after the delete: the words win and the delete goes
    notes.push(n);
  }

  let kept = [...live.values()].sort((a, b) => b.gone - a.gone || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (kept.length > PAD_TOMB_CAP) kept = kept.slice(0, PAD_TOMB_CAP);
  return { notes, tombs: kept };
}

/**
 * Delete notes — and say so in a way that travels.
 *
 * A tombstone is written for every id, INCLUDING ids this device has never
 * seen: a delete made against a note that only exists on the other device still
 * has to reach it, and "I do not have it" is not a delete.
 */
export function removeNotes(doc: PadDoc, ids: readonly string[], now: number): PadDoc {
  const gone = new Set(ids.filter((id) => typeof id === "string" && id));
  if (!gone.size) return doc;
  const tombs = new Map(doc.tombs.map((t) => [t.id, t]));
  for (const id of gone) {
    const have = tombs.get(id);
    if (!have || now > have.gone) tombs.set(id, { id, gone: now });
  }
  return { notes: doc.notes.filter((n) => !gone.has(n.id)), tombs: [...tombs.values()] };
}

/** Write a note, by id — and forget any delete for it, since this is somebody
 *  typing after that delete, which is rule 3 stated locally. */
export function upsertNote(doc: PadDoc, note: PadNote): PadDoc {
  const notes = doc.notes.some((n) => n.id === note.id)
    ? doc.notes.map((n) => (n.id === note.id ? note : n))
    : [note, ...doc.notes];
  return { notes, tombs: doc.tombs.filter((t) => t.id !== note.id) };
}

/**
 * A remote value is about to replace this device's copy: merge instead.
 *
 * `changed` says the merged value differs from what arrived — i.e. this device
 * holds something the host does not, and has to push it back. An incoming `""`
 * is an EMPTY doc rather than "no opinion", so a removal on the wire cannot
 * take this device's notes with it: they survive the merge and go back up.
 */
export function adoptPad(incomingRaw: string, currentRaw: string | null, now: number): { value: string; changed: boolean } {
  const value = serializePad(mergePad(parsePad(currentRaw), parsePad(incomingRaw), now));
  return { value, changed: value !== incomingRaw };
}

// ── Words ────────────────────────────────────────────────────────────
// Here rather than in a web module for `shared/assess.ts`'s reason: a sheet's
// sentences are part of what the app MEANS, they are pinned by a node test, and
// this file already owns everything else about the pad that is not pixels.

/** What the pad IS, at the top of the sheet. */
export const PAD_HINT =
  "Notes with no target yet — write them anywhere, offline included, and aim them later. " +
  "A note that names a repo can be filed straight onto that repo's backlog. " +
  "Sending or filing one uses the normal queue, so it survives a dead tunnel like anything else you type.";

/** The refusal: the add did not happen, and the words are still where you can
 *  see them. Never a shed note — that deleted somebody's words to make room for
 *  somebody's words. */
export function padFullText(n: number, kb: number): string {
  return `the pad is full (${n} notes, ${kb} KB) — your text is still in the editor; send, file or clear a note first`;
}

/** The other refusal: this browser refused the write outright (private mode, an
 *  origin at quota). Same promise — the words did not move. */
export const PAD_WRITE_REFUSED =
  "this phone's storage refused the note — your text is still in the editor; free some space, or send or clear a note first";

/** The retired device-local rescue store, handed back to the pad it was
 *  guarding. Said once, on the boot that moves them. */
export function padMigratedToast(n: number): string {
  return n === 1
    ? "one note that was kept on this phone is back on the pad"
    : `${n} notes that were kept on this phone are back on the pad`;
}

/** A half-written prompt about to be replaced by words nobody typed, parked
 *  where there is a listing to find it again. */
export const DRAFT_KEPT_TOAST = "kept your unfinished prompt — it is a note on the pad";
/** …and when the pad could not take it. The draft is NOT overwritten: a rescue
 *  that failed must not also be a delete. */
export const DRAFT_REFUSED_TOAST =
  "the pad could not take your unfinished prompt, so it was left in the box — nothing was replaced";

/** *file it* — the verb for a note that already knows which repo it is for. */
export const FILE_WORDS = {
  label: "file it",
  title: (repo: string) => `put it on ${repo}'s backlog as it is — it waits there, nothing runs now`,
};

/** What filing did. Offline is its own sentence: the row is durable either way,
 *  and a promise about "when the link is back" is the honest half. */
export function padFiledToast(repo: string, offline: boolean): string {
  return offline
    ? `filed offline — it reaches ${repo}'s backlog when the link is back`
    : `filed — on ${repo}'s backlog`;
}

/**
 * A draft about to be replaced by words nobody typed — what, if anything, to
 * keep.
 *
 * The merge above guards the pad against a synced overwrite. This guards the
 * *sheet drafts* against the local equivalent, and the local one is worse: the
 * sheet-draft store has no listing of its own, so the only route back to a
 * draft is re-opening the exact sheet that wrote it. When anything breaks that
 * single route — a routing bug, a reload, an OTA bundle swap, a killed tab —
 * the words still exist and nothing on the phone can reach them, and the next
 * open of that sheet seeds the slot and deletes them. A prompt typed on a
 * train, with a schedule set and a screenshot marked up, went that way.
 *
 * Two things are NOT rescued, and both are the ordinary case: an empty slot
 * (nothing to keep), and a slot that already holds exactly the incoming seed
 * (re-opening the same message is not an overwrite). Whitespace-only counts as
 * empty — a stray newline is not a draft, and a rescue row for one teaches the
 * user to ignore the section.
 *
 * Returns the chain SPLIT: `text` is the first step and `steps` the rest, which
 * is the shape a pad note wants (`PadNote.steps`) rather than a string with
 * control characters in it.
 */
export function draftToRescue(current: string, seed: string): { text: string; steps?: string[] } | null {
  if (!current.trim() || current === seed) return null;
  const [text = "", ...steps] = current.split("\f");
  return steps.length ? { text, steps } : { text };
}
