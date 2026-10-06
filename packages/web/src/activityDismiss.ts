/**
 * "I have dealt with this one" — the Activity list's own mark.
 *
 * ── Why a mark and not a delete ────────────────────────────────────────────
 *
 * The measured state of one real phone: 217 rows, 84 of them failed. Every one
 * of those rows is individually actionable, which is correct, and which at 84
 * is the same as not being actionable at all — there is no way to say "I have
 * read this, it is obsolete, stop showing it to me" short of destroying it.
 *
 * The rest of this app is built on the rule that the user's words are never
 * lost, so the answer cannot be a delete. It is a mark: the row keeps its
 * words, its verdict and its buttons, it moves under the `dismissed` chip, and
 * it stops being counted by every other one. `bring back` undoes it. That is
 * also the vocabulary the durable host store uses — `Intent.dismissedAt` is the
 * gate that lets a failed intent be compacted, and is explicitly *not* how work
 * is deleted — so when a row here starts carrying an intent id this ledger
 * becomes the client half of the same word rather than a second idea.
 *
 * ── Why it lives on the phone ──────────────────────────────────────────────
 *
 * Most of what it names is the phone's own ledger. A give-up row's key is an
 * ackId this device minted; the desktop has never heard of it, and no other
 * device ever will. So the store is local, it is NOT synced (`storage.ts` says
 * why at the key), and it is a plain key → instant map rather than a list, so
 * "is this row filed?" is one lookup on a list of a few hundred.
 *
 * ── Bounded, like every other ledger here ──────────────────────────────────
 *
 * A row key can outlive its row — the give-ups ledger caps at 200 and drops its
 * oldest, and a queue ackId is gone the moment the entry is. Those dismissals
 * then name nothing, for ever. Nothing can detect that from here (the row is
 * simply absent, which is indistinguishable from "not loaded yet"), so the only
 * honest bound is a count: keep the newest `CAP`, drop the rest. Dropping one
 * is harmless in the direction that matters — the row it named is gone too, and
 * if it is not, it reappears in the list unfiled, which is the safe error.
 */
import { LS, lsJson, lsSetJson } from "./storage";

/**
 * How many dismissals are remembered.
 *
 * Comfortably more than the give-ups ledger's own 200 rows plus a full queue
 * plus every host-side row a phone sees at once — i.e. it should never be the
 * thing that runs out first. Each record is a short key and a number.
 */
const CAP = 1000;

/** Row key → when it was filed. */
export type Dismissals = Map<string, number>;

function load(): Record<string, number> {
  const raw = lsJson<Record<string, number>>(LS.activityDismissed, {});
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw)) if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
  return out;
}

function save(rec: Record<string, number>): void {
  const keys = Object.keys(rec);
  if (keys.length <= CAP) { lsSetJson(LS.activityDismissed, rec); return; }
  // Newest kept. The oldest dismissal is the one whose row is most likely gone
  // anyway, and losing it costs a row reappearing — never a row disappearing.
  const kept: Record<string, number> = {};
  for (const k of keys.sort((a, b) => rec[b] - rec[a]).slice(0, CAP)) kept[k] = rec[k];
  lsSetJson(LS.activityDismissed, kept);
}

/** Everything filed, as the map `activityRows()` takes. */
export function dismissedRows(): Dismissals {
  return new Map(Object.entries(load()));
}

/**
 * File these rows. Returns the new map, so the caller sets state from the
 * value that was written rather than from a second read that could disagree.
 *
 * Re-filing a row already filed keeps the ORIGINAL instant: "when did I decide
 * this" is the question the timestamp answers, and a bulk action sweeping over
 * a row a second time must not restate it as a fresh decision.
 */
export function dismissRows(keys: readonly string[], at = Date.now()): Dismissals {
  const rec = load();
  for (const k of keys) if (rec[k] == null) rec[k] = at;
  save(rec);
  return new Map(Object.entries(rec));
}

/** Put them back in the list. */
export function undismissRows(keys: readonly string[]): Dismissals {
  const rec = load();
  for (const k of keys) delete rec[k];
  save(rec);
  return new Map(Object.entries(rec));
}
