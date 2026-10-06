/**
 * The sent-command log's one piece of pure bookkeeping: folding a live
 * `sent.new` frame into the list. Type-only imports, so `logic.test.mjs` runs it under
 * plain node.
 */
import type { SentCommand } from "@waterplane/shared";

/** Rows kept on the phone (App kept the same 300). */
export const SENT_CAP = 300;

/**
 * Appended live rather than re-fetching the list: the log is written from
 * inside a delivery, and a full refetch per send is pointless traffic on the
 * one link this app spends its life apologising for.
 *
 * The same frame also carries a CORRECTION: an ambiguous delivery that the host
 * later proved landed comes back with the same id and a `settled` verdict.
 * Replacing by id is what makes that work, and the re-sort is what stops a row
 * from jumping to the top of a newest-first list hours after it was sent.
 */
export function mergeSent<T extends Pick<SentCommand, "id" | "ts">>(prev: readonly T[], entry: T, cap = SENT_CAP): T[] {
  return [entry, ...prev.filter((e) => e.id !== entry.id)].sort((a, b) => b.ts - a.ts).slice(0, cap);
}
