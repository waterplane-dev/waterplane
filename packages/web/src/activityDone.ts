/**
 * "I checked — it actually ran." A person's own mark, apart from `activityDismiss.ts`.
 *
 * `DeliveryTruth === "unconfirmed"` is the one verdict that is honestly a shrug:
 * the desktop typed the words into the session and then could not read the
 * screen back to say whether they landed (`sendConfirm.ts`, `activityRows.ts`'s
 * `stuckSend` text). Usually the desktop's own retry-and-read settles it within
 * seconds. When the detector itself has degraded — a TUI repaint it doesn't
 * recognise, a theme it can't parse — it never does, and the row sits under
 * "failed" for good with words that a glance at the terminal shows already ran.
 *
 * This is the way out that "save for later" is not: dismissing files the row
 * away with its failed verdict intact, and a person re-reading "may not have
 * run" a week later is no better informed than the first time. Marking it done
 * says what was actually established — by a person, not the heuristic — and
 * moves the row where it belongs.
 *
 * Deliberately NOT the same store as `activityDismiss.ts`: one hides a row from
 * the count, the other reclassifies what happened to it, and folding them into
 * one boolean would make "why is this in done" and "why is this off my list"
 * the same unanswerable question.
 *
 * Local and not synced, for the same reason as `activityDismissed`: the row it
 * names is a queue entry this device minted, and no other device has heard of
 * it.
 */
import { LS, lsJson, lsSetJson } from "./storage";

/** Same bound as `activityDismiss.ts`, same reasoning: comfortably above
 *  anything this ledger could ever need to hold at once. */
const CAP = 1000;

export type ConfirmedDone = Map<string, number>;

function load(): Record<string, number> {
  const raw = lsJson<Record<string, number>>(LS.activityConfirmedDone, {});
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw)) if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
  return out;
}

function save(rec: Record<string, number>): void {
  const keys = Object.keys(rec);
  if (keys.length <= CAP) { lsSetJson(LS.activityConfirmedDone, rec); return; }
  const kept: Record<string, number> = {};
  for (const k of keys.sort((a, b) => rec[b] - rec[a]).slice(0, CAP)) kept[k] = rec[k];
  lsSetJson(LS.activityConfirmedDone, kept);
}

/** Everything a person has marked as actually run, as the map `activityRows()`
 *  takes. */
export function confirmedDoneRows(): ConfirmedDone {
  return new Map(Object.entries(load()));
}

/** Mark these rows done. Re-marking an already-marked row keeps the original
 *  instant, same as `dismissRows` — the question is when it was decided. */
export function markRowsDone(keys: readonly string[], at = Date.now()): ConfirmedDone {
  const rec = load();
  for (const k of keys) if (rec[k] == null) rec[k] = at;
  save(rec);
  return new Map(Object.entries(rec));
}
