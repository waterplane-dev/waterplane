/**
 * The retired rescue store, put back on the pad — the decision half, on its own.
 *
 * `waterplane.padRescue` was where a seeded sheet draft used to be parked, under a
 * seven-day TTL that the READER applied, so reading the store was itself a
 * delete. The pad replaces it, and the notes that matter are precisely the old
 * ones: on the device this was reported from there are ten of them, and they
 * exist there and nowhere else. A migration that gets this wrong is not a bug
 * anybody can report twice.
 *
 * Which is the reason this is a module and not twenty lines inside `App.tsx`:
 * `App` keeps the read, the write and the once-only mark — the parts that need
 * a browser — and every rule that decides what happens to somebody's words is
 * here, where `node --test` can state each one out loud. The rules, each of
 * which is a bug this replaces if it goes:
 *
 *   • a note already on the pad is left alone. The pad is the live copy; the
 *     rescue store is a fossil, and letting the fossil win would re-open an
 *     edit the person made since.
 *   • the ORIGINAL id and `ts` are kept. Anything that ever pointed at a note
 *     did so by id, and a note that came back renamed leaves every reference to
 *     it pointing at nothing. A row with no usable `ts` is stamped `now`, which
 *     is the only honest answer and the one that loses to a tombstone least.
 *   • a repeated id takes the NEWEST row, because `upsertNote` replaces
 *     wholesale and "whichever came last in the file" is not a rule.
 *   • a tombstone at or after a row's own `ts` wins: that is a delete the
 *     person made AFTER writing these words, and resurrecting it is the exact
 *     thing tombstones exist to stop. A tombstone from BEFORE it does not —
 *     those words were typed after the delete.
 *   • a row with no id or no text is dropped. There is nothing to put back and
 *     nothing to point at it.
 *   • `steps` and `cwd` come across when they are there and are simply absent
 *     when they are not; `lostAt` and `how` are dropped, because there is one
 *     pad now and no second place a note could have come from.
 *
 * The count is what was actually ADDED, so the sentence a person reads is about
 * their notes and not about the size of the file it read.
 */
import { upsertNote, type PadDoc, type PadNote } from "@waterplane/shared";

/** A row as the retired store left it. Every field is re-checked rather than
 *  trusted: this is raw JSON off a phone that has been through several builds. */
export interface RescueRow {
  id?: unknown;
  text?: unknown;
  ts?: unknown;
  steps?: unknown;
  cwd?: unknown;
}

export interface RescueMigration {
  /** The pad with the rescued notes in it — the same doc when nothing moved. */
  doc: PadDoc;
  /** How many notes were added. `0` ⇒ there is nothing to write and nothing to
   *  say; the caller still marks the migration done. */
  n: number;
}

/**
 * Put every rescuable row onto the pad, once.
 *
 * `rows` is deliberately `unknown`: it comes straight off `localStorage` and
 * the one thing a migration may not do is throw on the shape it finds.
 */
export function migrateRescueRows(rows: unknown, doc: PadDoc, now: number): RescueMigration {
  if (!Array.isArray(rows) || !rows.length) return { doc, n: 0 };
  // The ids the pad ALREADY held when this started — `upsertNote` would
  // otherwise make the second reading of this set include our own writes.
  const had = new Set(doc.notes.map((n) => n.id));
  const tombs = new Map(doc.tombs.map((t) => [t.id, t.gone]));
  /** id → the `ts` we put back under it, so a repeated id can take the newest. */
  const added = new Map<string, number>();
  let out = doc;
  for (const raw of rows) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as RescueRow;
    if (typeof r.id !== "string" || !r.id) continue;
    if (typeof r.text !== "string" || !r.text.trim()) continue;
    if (had.has(r.id)) continue;
    const ts = typeof r.ts === "number" && Number.isFinite(r.ts) ? r.ts : now;
    const gone = tombs.get(r.id);
    if (gone !== undefined && gone >= ts) continue;
    const already = added.get(r.id);
    if (already !== undefined && already >= ts) continue;
    const note: PadNote = { id: r.id, text: r.text, ts };
    const steps = Array.isArray(r.steps) ? r.steps.filter((x): x is string => typeof x === "string" && !!x.trim()) : [];
    if (steps.length) note.steps = steps;
    if (typeof r.cwd === "string" && r.cwd) note.cwd = r.cwd;
    out = upsertNote(out, note);
    added.set(r.id, ts);
  }
  return { doc: out, n: added.size };
}
