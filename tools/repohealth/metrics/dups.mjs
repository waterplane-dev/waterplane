/**
 * Duplicate blocks: near-exact clones carried by one tree at one commit.
 *
 * The orphaned exports that are the other half of the same failure live in
 * `deadexports.mjs`. Both read the tree through the ANALYZER of the pack that
 * owns each file's extension rather than each parsing it themselves, because
 * a second parse is a second definition of "what names does this file use".
 *
 * ── Why the parser arrives from a pack and is never imported ───────────────
 *
 * This module used to `import` the TypeScript walker directly, which is the
 * same thing as declaring that every repo is written in TypeScript. A Kotlin
 * tree has no analyzer here at all, and the only honest reading over one is
 * `{value: null, reason}` — a metric that imports its parser cannot express
 * that, because there is always a parser and it always returns nothing. So
 * the parser comes from `pack.analyzer()`, each file is routed to the pack
 * that owns its extension (`metrics/route.mjs`), and a file no active pack
 * can read is skipped rather than counted as a file with no duplicates in
 * it. Where nothing in the tree can be read, the row says which packs
 * declined and reports no number at all.
 *
 * ── The failure this exists to catch ────────────────────────────────────────
 *
 * An agent that cannot see an existing module writes a second one. Nothing in
 * review looks wrong: the new function is correct, tested and well named, and
 * the old one is in a file nobody opened this session. The repo grows a second
 * `formatBytes`, a second settle loop, a second "type into a live session and
 * confirm" — which is exactly why CLAUDE.md has to say "never fork
 * `deliver.ts`" out loud. Every other metric here (size, hatches, re-touch,
 * co-change) would move the same way for a human author working too fast. This
 * one moves for a cause that is structural to how this repo is written, so it
 * is the one worth paying a compiler parse for.
 *
 * The fork leaves two marks, not one. The copy is a PAIR of blocks that look
 * alike (`measureDups`); the original is an exported name that nothing else in
 * the tree writes any more (`measureDeadExports`). Neither is a judgment and
 * neither applies itself: a pair is two block ids, a dead export is a sorted
 * list of `path#name`, and what the narrative is allowed to say about either
 * lives in `narrate.mjs`.
 *
 * ── Why whole-file granularity is banned ────────────────────────────────────
 *
 * Verified at HEAD: `packages/web/src/activityRows.ts` (95k) and
 * `packages/web/src/assessRows.ts` (88k) look like an obvious pair by name and
 * by size, and share 23 unique lines out of roughly 1,400 each. They are not
 * duplicates. Meanwhile every `*Sheet.tsx` shares its imports, its props
 * interface shape and its close button, and every `scripts/e2e-*.mjs` shares a
 * whole harness preamble. A file-level comparator reports the boilerplate and
 * misses the fork — the two errors at once. So the unit is a BLOCK: a
 * declaration with a body or an initializer, floored at `PREREG.DUP_MIN_LINES`
 * lines.
 *
 * ── Why identifiers are NOT normalised ──────────────────────────────────────
 *
 * `PREREG.DUP_NORMALISE === "literals-only"`: string and numeric literals
 * become placeholders, identifiers stay literal. A renamed copy therefore does
 * not pair. That is deliberate and it is the line between this module and the
 * `judge` command. "Are these two blocks the same behaviour under different
 * names" is a judgment; it costs tokens, it is wrong sometimes, and it must
 * never be reachable from a metric that runs on every commit of a backfill.
 * This module answers the cheap, checkable question — near-exact clones only —
 * and leaves the expensive one alone. Nothing here may call a model, touch the
 * network, or read a file.
 */

import { analyzers, packFor } from "./route.mjs";

/** Estimated Jaccard: the fraction of hash slots that agree. */
function estimateSimilarity(x, y) {
  let m = 0;
  for (let i = 0; i < x.length; i++) if (x[i] === y[i]) m++;
  return m / x.length;
}

/**
 * How many pairs a row carries.
 *
 * Not a threshold — `pairsPerKloc` is always computed from the FULL pair count,
 * so the number that gets plotted never notices this cap. It exists because a
 * row is serialised into a fixture and read by a person, and a run with 900
 * pairs in one row is a run whose 50 most similar pairs are the whole story.
 * 50 is roughly one screen.
 */
const MAX_PAIRS = 50;

/**
 * The memos a cold run has to clear live with the parser that fills them —
 * `clearTsCaches()` in `../lang/typescript-ast.mjs` — and there is no wrapper
 * here any more. A wrapper would have to import one language's module into a
 * metric that must not know which language it is reading, and it would be a
 * name that goes stale the moment a second pack has caches of its own.
 */

/** How a pair names its halves. Stable and greppable. */
function blockId(path, b) {
  return `${path}#${b.name}@${b.line}`;
}

// ── duplicate pairs ─────────────────────────────────────────────────────────

/**
 * Near-exact duplicate blocks in one tree.
 *
 * `history` and `index` are unused and stay in the signature because every
 * `measure*` in this series takes the same four arguments — a metric that
 * needed the past tomorrow would otherwise change every call site.
 *
 * ── What the rate is per ────────────────────────────────────────────────────
 *
 * The denominator is the LOC of the files an analyzer actually READ, not of
 * every source file in the tree. In a single-language repo those are the same
 * number and this is the total `size` sums. In a mixed one they are not, and
 * dividing pairs found in the readable half by the size of the whole tree
 * reports a rate that falls whenever unreadable code is added — a number that
 * moves for a reason that has nothing to do with duplication.
 *
 * ── What `pairsPerKloc` is, and what it is not ──────────────────────────────
 *
 * It is in the row because the row is a series and a rate is the only form in
 * which two days of different sizes can be compared at all. But read it with
 * its numerator in view: this repo carries 0 to 2 pairs at any commit, so the
 * rate is essentially `1/LOC` and it "falls" every week for the single reason
 * that the repo grew. Ranking it produces a confident sentence about nothing.
 * The narrative therefore reports NAMED pair events — this block and that one,
 * by id — and leaves the rate unranked.
 *
 * @param {import("../types.mjs").Snapshot} snapshot
 * @param {import("../types.mjs").History} _history
 * @param {number} _index
 * @param {import("../types.mjs").EffectivePrereg} prereg
 * @returns {import("../types.mjs").Measured<{degenerateBuckets: number, pairs: {a: string, b: string, sim: number}[], pairsPerKloc: number}>}
 */
export function measureDups(snapshot, _history, _index, prereg) {
  const { byPack, reason } = analyzers(prereg);
  if (byPack.size === 0) return { value: null, reason };

  const params = {
    minLines: prereg.DUP_MIN_LINES,
    shingle: prereg.DUP_SHINGLE,
    hashes: prereg.DUP_HASHES,
    nested: prereg.DUP_NESTED_BLOCKS,
  };
  const hashes = params.hashes;
  const bands = prereg.DUP_BANDS;
  const rows = Math.floor(hashes / bands);
  const threshold = prereg.DUP_SIMILARITY;

  // The denominator is the LOC of the files that were read — in a
  // single-language tree the same total the size metric sums, so "per kloc"
  // here and "lines" there are the same lines. Two near-identical
  // denominators is how two rows of one plot end up disagreeing forever.
  let readLoc = 0;
  /** @type {{id: string, path: string, start: number, end: number, sig: Int32Array}[]} */
  const blocks = [];
  for (const f of snapshot.files) {
    const owner = packFor(f.path, prereg);
    const analyzer = owner && byPack.get(owner.name);
    // A file whose language has no parser here is not a file with no clones
    // in it. It is a file nothing opened, so it is out of the numerator and
    // out of the denominator both.
    if (!analyzer) continue;
    readLoc += f.loc;
    for (const b of analyzer.blocks(f, params)) {
      blocks.push({ id: blockId(f.path, b), path: f.path, start: b.start, end: b.end, sig: b.sig });
    }
  }
  if (readLoc === 0) {
    if ((snapshot.files ?? []).length === 0) return { value: null, reason: "no source files in this tree" };
    return { value: null, reason: reason || "no file in this tree belongs to a pack that can parse it" };
  }

  // LSH. Two blocks are candidates when a whole band of their signatures is
  // identical; at 64 hashes in 8 bands that is the standard s-curve knee near
  // 0.8, which is why those three constants are pre-registered together.
  const candidates = new Set();
  let degenerateBuckets = 0;
  for (let band = 0; band < bands; band++) {
    const buckets = new Map();
    const from = band * rows;
    for (let i = 0; i < blocks.length; i++) {
      const sig = blocks[i].sig;
      let k = `${band}`;
      for (let r = from; r < from + rows; r++) k += `,${sig[r]}`;
      const cell = buckets.get(k);
      if (cell) cell.push(i);
      else buckets.set(k, [i]);
    }
    for (const cell of buckets.values()) {
      if (cell.length < 2) continue;
      // A bucket of 300 identical-band blocks is 45k pairs of noise; a band
      // that wide is degenerate (an empty or near-empty signature), not a
      // finding, and re-checking it would dominate the run. The count travels
      // in the row so that a pair dropped here is never invisible.
      if (cell.length > prereg.DUP_MAX_BUCKET) {
        degenerateBuckets++;
        continue;
      }
      for (let x = 0; x < cell.length; x++) {
        for (let y = x + 1; y < cell.length; y++) candidates.add(cell[x] * blocks.length + cell[y]);
      }
    }
  }

  const found = [];
  for (const enc of candidates) {
    const i = Math.floor(enc / blocks.length);
    const j = enc % blocks.length;
    const x = blocks[i];
    const y = blocks[j];
    if (x.id === y.id) continue;
    // Nested extraction means a block and the block it sits inside are both
    // in the list. A part is not a duplicate of its whole.
    if (x.path === y.path && x.start < y.end && y.start < x.end) continue;
    const sim = estimateSimilarity(x.sig, y.sig);
    if (sim < threshold) continue;
    const flip = x.id > y.id;
    found.push({
      a: flip ? y.id : x.id,
      b: flip ? x.id : y.id,
      sim: Math.round(sim * 1000) / 1000,
      ax: flip ? y : x,
      bx: flip ? x : y,
    });
  }

  // ── a fork reported once, at the level it happened ──
  //
  // A whole component copied into a second file pairs at the top AND at every
  // nested block inside it, and in both cross directions: four pairs for one
  // fork in the smallest case, and a screenful when the component is large.
  // They are all the same finding, and the outermost one is the one somebody
  // can act on. So a pair is dropped when another pair's two halves each
  // CONTAIN its own — plain span containment in the same file, no threshold —
  // and the containing pair is the one reported. A parent and a child that
  // are forked independently, into different places, contain nothing of each
  // other and both survive.
  const bySpan = (p) => p.ax.end - p.ax.start + (p.bx.end - p.bx.start);
  const byReport = (p, q) => q.sim - p.sim || (p.a < q.a ? -1 : p.a > q.a ? 1 : 0) || (p.b < q.b ? -1 : p.b > q.b ? 1 : 0);
  found.sort((p, q) => bySpan(q) - bySpan(p) || byReport(p, q));
  const inside = (u, v) => u.path === v.path && v.start <= u.start && u.end <= v.end;
  const kept = [];
  for (const p of found) {
    const subsumed = kept.some(
      (q) => (inside(p.ax, q.ax) && inside(p.bx, q.bx)) || (inside(p.ax, q.bx) && inside(p.bx, q.ax)),
    );
    if (!subsumed) kept.push(p);
  }

  // Deterministic order before the cap, so the 50 that survive are the same 50
  // on every machine: most similar first, then by name.
  kept.sort(byReport);

  const pairsPerKloc = Math.round((kept.length / (readLoc / 1000)) * 10000) / 10000;
  return {
    value: {
      degenerateBuckets,
      pairs: kept.slice(0, MAX_PAIRS).map((p) => ({ a: p.a, b: p.b, sim: p.sim })),
      pairsPerKloc,
    },
  };
}
