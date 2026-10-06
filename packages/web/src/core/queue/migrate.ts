/**
 * Two one-shot migrations the queue runs on mount: the retired pad rescue
 * store back onto the pad, and the retired give-ups ledger back into the queue
 * as failed rows. Neither deletes its source.
 */
import { loadPad, loadPadDoc, newAckId, writePadDoc, type OutboxEntry } from "../../outbox";
import { LS, lsGet, lsJson, lsSet } from "../../storage";
import { migrateRescueRows } from "../../padMigrate";

/**
 * Put the RETIRED pad rescue store back on the pad, once.
 *
 * `LS.padRescue` was the compensation for a pad merged last-write-wins on
 * the whole list: the notes an adopted value dropped were kept there, on this
 * device only, for a week. The merge is per note now (`shared/pad.ts`), so
 * nothing drops and nothing needs catching — but a phone coming to this build
 * has notes in there and nowhere else, ten of them on the device this was
 * reported from, and shipping the fix without this would be exactly the loss
 * the fix exists to prevent.
 *
 * Four rules, each of which would otherwise re-create a bug this replaces:
 *   • the source is read RAW, never through the old `rescuedNotes()`, which
 *     applied a 7-day TTL and rewrote the key on read — i.e. the reader was
 *     itself a delete, and the notes worth rescuing are the old ones.
 *   • the ORIGINAL id and `ts` are kept. Anything that ever pointed at a note
 *     did so by id, and a note that came back renamed leaves every reference
 *     to it pointing at nothing. `how` is irrelevant now: there is one pad.
 *   • a note already on the pad, or tombstoned at or after its own `ts`, is
 *     skipped — putting back something deliberately deleted since is the
 *     resurrection the tombstones exist to stop.
 *   • the migrated mark is written only if the pad write SUCCEEDED, so a
 *     quota refusal retries on the next boot instead of eating the input.
 *
 * The source value is deliberately NOT deleted, the `giveups` precedent: a
 * migration that got something wrong must not also have destroyed its input.
 */
export function migratePadRescue(): number {
  if (lsGet(LS.padRescueMigrated)) return 0;
  const mark = () => lsSet(LS.padRescueMigrated, String(Date.now()));
  // Every rule about what happens to these words is `padMigrate.ts`'s, where
  // `node --test` states each one. What is left here is the browser half: the
  // raw read, the write, and the mark — which is written only when the write
  // SUCCEEDED, so a quota refusal retries on the next boot instead of eating
  // the input.
  const { doc, n } = migrateRescueRows(lsJson<unknown>(LS.padRescue, []), loadPadDoc(), Date.now());
  if (!n) { mark(); return 0; }
  if (!writePadDoc(doc)) return 0; // the store refused — try again next boot
  mark();
  return n;
}

/**
 * Bring the retired give-ups ledger's rows into the queue, once.
 *
 * The ledger is deleted, and a deletion that took the user's words with it
 * would be the exact failure this whole rework is about. A phone upgrading to
 * this build has rows in `LS.giveups` naming sends that stopped days ago —
 * on the device this was reported from, eighty-four of them — and the queue
 * rows they described are long gone, expired at thirty minutes and retired at
 * ninety.
 *
 * So each one becomes a `failed` queue row: its words (the pad note's, in
 * full, when the note it named is still there — otherwise the ledger's
 * clipped head, which is all that was ever kept), the repo it was written
 * for, and a reason that says where it came from. Activity then shows it like
 * any other failed send, with the button that posts it back to that repo.
 *
 * Three rules, each of which would otherwise re-create a bug this replaces:
 *   • a FRESH ackId. The ledger's id may still hold a verdict in the host's
 *     ledger, and "try again" on a row carrying it would be re-acked with
 *     that stale verdict and never delivered. A new id is provably un-sent.
 *   • rows already `retriedAt`, and rows whose ackId the queue still holds,
 *     are skipped — they would be the same message twice.
 *   • `mode: "backlog"`, aimed at the row's own `cwd`. A session id from days
 *     ago names nothing; a work item names the repo, which is the fact the
 *     ledger always had and nothing ever used.
 *
 * The source value is deliberately NOT deleted. If this conversion gets
 * something wrong, the input is still on the device.
 */
export function migrateGiveUps(list: OutboxEntry[]): OutboxEntry[] {
  if (lsGet(LS.giveupsMigrated)) return list;
  type Row = {
    ackId?: string; ts?: number; kind?: string; text?: string; clipped?: boolean;
    cwd?: string; reason?: string; failState?: OutboxEntry["failState"];
    padId?: string; retriedAt?: number; bytes?: boolean; discarded?: boolean; dropped?: boolean;
  };
  const rows = lsJson<Row[]>(LS.giveups, []);
  lsSet(LS.giveupsMigrated, String(Date.now()));
  if (!Array.isArray(rows) || !rows.length) return list;
  const have = new Set(list.map((e) => e.ackId));
  const notes = new Map(loadPad().map((d) => [d.id, d]));
  const add: OutboxEntry[] = [];
  for (const g of rows) {
    if (!g || g.retriedAt || (g.ackId && have.has(g.ackId))) continue;
    // Bytes and keystrokes never had words to bring across, and a row that
    // says so is a row offering a re-send that would refuse itself.
    if (g.bytes || g.kind === "file" || g.kind === "answer") continue;
    const note = g.padId ? notes.get(g.padId) : undefined;
    const text = (note ? [note.text, ...(note.steps ?? [])].join("\n\n") : g.text ?? "").trim();
    if (!text) continue;
    const cwd = g.cwd ?? "";
    add.push({
      ackId: newAckId(),
      sessionId: cwd || "unknown",
      cwd,
      text,
      ts: g.ts ?? Date.now(),
      status: "failed",
      mode: "backlog",
      label: text.slice(0, 40),
      failedAt: g.ts ?? Date.now(),
      failState: g.failState,
      reason: g.reason
        ? `${g.reason}${note ? "" : g.clipped ? " (only the shortened copy was kept)" : ""}`
        : "this one never reached a session",
    });
  }
  if (!add.length) return list;
  // Oldest first, behind whatever is already queued: these are history, and
  // nothing here is going out on its own — every row is `failed`.
  return [...list, ...add.sort((a, b) => a.ts - b.ts)];
}
