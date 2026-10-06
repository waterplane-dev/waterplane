/**
 * Orphaned exports: a value export that no other blob in the tree names.
 *
 * This is the other mark the fork described in `dups.mjs` leaves. The copy is
 * a PAIR of blocks that look alike; the original is an exported name that
 * nothing else writes any more. Both are read off the same analysis of the
 * same tree — the ANALYZER of the pack that owns each file's extension, one
 * parse feeding both metrics — and neither is a judgment: a dead export is a
 * sorted list of `path#name`, and what the narrative is allowed to say about
 * it lives in `narrate.mjs`.
 *
 * A language with no analyzer here reports `{value: null, reason}` naming the
 * packs that declined. That is the whole reason the parser arrives from a
 * pack rather than being imported: "no exported name in this tree is dead" is
 * what an empty list claims, and over a tree nothing parsed it is a claim
 * about files that were never opened. A file whose pack has no analyzer is
 * skipped on both sides of the question — it contributes no export to the
 * list and no mention to the table.
 *
 * ── Why this is a list and not an event ─────────────────────────────────────
 *
 * It used to be a tripwire that fired on a file's FIRST dead export, and that
 * was a state reported as an event. What it caught was not an orphan but a
 * BIRTH: a new module whose consumer had not landed yet. Measured over this
 * repo's own 157 commits, it fired 126 times naming 277 exports — 126 of the
 * 137 tripwires in the whole series — and 100 of those 277 were named by a
 * blob in the tree by the END OF THE SAME DAY (`attachBlockers`,
 * `filterGalleryRows`, `HINTS` …, 26 events stale in every name they listed).
 * 8 more were never dead at all, just invisible to a tokenizer that stopped
 * reading at the first backtick. Every one of those lines told a reader to go
 * and look at live code.
 *
 * So this row carries the STATE, sorted, exactly like `untested` — and the
 * event is left to the one comparison that means what the header always
 * claimed: a name that yesterday's row shows another blob naming, whose file
 * still exists today, that no blob names today. That is the orphaning, it
 * needs no threshold, and it cannot fire on a file's first day.
 *
 * ── What counts as a use ────────────────────────────────────────────────────
 *
 * Deliberately over-cautious. The union covers every other source blob AND
 * every test AND every `scripts/e2e-*.mjs`; a bare mention anywhere counts,
 * because a property access, an import specifier and a JSX tag are all just
 * the name; and only value-level exports are considered, because a type nobody
 * names is a word, not debt. A missed orphan costs nothing. A wrongly reported
 * one sends somebody to delete live code.
 *
 * Built from one identifier→blob-count table rather than 325 set unions: the
 * table is one pass over every blob, and "named by some other blob" is then
 * `count - (this blob names it ? 1 : 0) > 0`.
 */

import { analyzers, packFor } from "./route.mjs";

/**
 * Every value export that no other blob in the tree names, as `path#name`.
 *
 * @param {import("../types.mjs").Snapshot} snapshot
 * @param {import("../types.mjs").History} _history
 * @param {number} _index
 * @param {import("../types.mjs").EffectivePrereg} prereg
 * @returns {import("../types.mjs").Measured<string[]>}
 */
export function measureDeadExports(snapshot, _history, _index, prereg) {
  const { byPack, reason } = analyzers(prereg);
  if (byPack.size === 0) return { value: null, reason };
  const files = snapshot.files ?? [];
  if (files.length === 0) return { value: null, reason: "no source files in this tree" };

  /** identifier -> how many blobs in this tree mention it. */
  const mentions = new Map();
  /** path -> that file's own analysis, so it can exclude itself. */
  const own = new Map();

  const add = (set) => {
    for (const id of set) mentions.set(id, (mentions.get(id) || 0) + 1);
  };
  /** The analyzer for one path, or null when no active pack can read it. */
  const analyzerFor = (path) => {
    const owner = packFor(path, prereg);
    return (owner && byPack.get(owner.name)) || null;
  };
  for (const f of files) {
    const analyzer = analyzerFor(f.path);
    if (!analyzer) continue;
    const a = analyzer.idents(f);
    own.set(f.path, a);
    add(a.identifiers);
  }
  if (own.size === 0) {
    return { value: null, reason: reason || "no file in this tree belongs to a pack that can parse it" };
  }
  // Tests and `scripts/e2e-*.mjs` count as users. A module reached only by a
  // test is under-used, not dead, and this metric does not have an opinion
  // about that — `untested.mjs` is where that question lives.
  //
  // A test in a language no active pack can parse contributes no uses. Said
  // out loud because it is the one place this module's caution runs the wrong
  // way: a missed user can only ever ADD a line to the list, and a wrongly
  // reported orphan is the error that sends somebody to delete live code. It
  // is left rather than patched because the alternative is handing a file to
  // another language's parser, and because a file written in one language
  // does not import another's exports — where the two really do meet, it is
  // through a path reference, which is `untested.mjs`'s question and not
  // this one's.
  for (const t of snapshot.tests ?? []) {
    const analyzer = analyzerFor(t.path);
    if (analyzer) add(analyzer.idents(t).identifiers);
  }

  const out = [];
  for (const f of files) {
    const mine = own.get(f.path);
    if (!mine) continue;
    for (const name of mine.exports) {
      const total = mentions.get(name) || 0;
      if (total - (mine.identifiers.has(name) ? 1 : 0) === 0) out.push(`${f.path}#${name}`);
    }
  }
  out.sort();
  return { value: out };
}
