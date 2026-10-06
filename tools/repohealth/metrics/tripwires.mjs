/**
 * Tripwires — the facts that are events, and must never become a line on a
 * plot.
 *
 * ── Why these are not metrics ───────────────────────────────────────────────
 *
 * Everything else in this series is a value read against its own past: a
 * percentile within a trailing window and the sign of a slope. That reading is
 * the right one for "how big are the files" and the wrong one for "a file went
 * past two thousand lines". A threshold crossing happens once. Plotted, it is
 * a step that stays high forever and drags every subsequent percentile with
 * it; ranked, it is indistinguishable from the file sitting still. Said once,
 * on the day it happened, with the number it crossed, it is a sentence
 * somebody acts on.
 *
 * So a tripwire is a `{kind, subject, detail}` on the row of the commit where
 * it fired, `[]` on every other row, and nothing downstream is allowed to
 * average them.
 *
 * ── The one thing these two have in common ──────────────────────────────────
 *
 * Each is a TRANSITION, not a state, and telling the two apart is the whole
 * difficulty. A file that has been 2,400 lines for three months is not news
 * every day for three months. `@ts-ignore` appearing for the first time is
 * news exactly once; the seventh one is not. So each needs to know what was
 * true at the previous commit, and `Row`'s measured fields do not carry it:
 * `size` has a p95 and a max, not the per-file line counts, and `hatches` has
 * today's totals, not the first day each kind was non-zero.
 *
 * ── Why the carried state is IN THE ROW ─────────────────────────────────────
 *
 * It used to be a module-level `Map` keyed by sha, on the argument that a
 * backfill walks the chain in order and a cache miss degrades to baseline, and
 * that a later full backfill would correct anything a miss had cost. Both
 * halves of that are false in the one way that matters.
 *
 * A daily `update` is a FRESH PROCESS. The memo is empty, the previous commit
 * was measured yesterday by a process that has exited, so every daily run
 * looked up a sha it had never walked, took the baseline branch, and wrote
 * `[]`. And the store is append-only: `missingShas` never recomputes a sha
 * that already has a row, so that `[]` is what the series says about that
 * commit forever. The correcting backfill the header promised cannot happen.
 * Reproduced on this repo's own series: sha `7aaee35` (2026-08-16) recorded 8
 * tripwires during the in-order backfill, and recomputing it in a fresh
 * process returned 0. With the state in the row, the same sha recomputed in a
 * fresh process from a `prevRow` read off disk returns exactly what the
 * in-order walk recorded for it.
 *
 * So the state travels in the row, as `tripwireState`, and is read back off
 * `prevRow` — which the caller has in its hand whether it is replaying 157
 * commits or appending one. It is deliberately the SMALLEST thing that answers
 * "what changed": the paths already over the limit, the line counts of the
 * files big enough to cross it next, and which hatch kinds have ever been
 * non-zero. Every list is sorted, because a row is compared to a committed
 * fixture with `deepEqual` and `Set` iteration order is insertion order, not a
 * promise.
 *
 * A row with no `tripwireState` — the first commit, or a row written before
 * this field existed — is a baseline and fires nothing. That rule is the
 * repo's: **never a guess.** A tripwire that fires because the tool forgot
 * what yesterday looked like is worse than one that stays quiet, because the
 * quiet one is corrected by a re-cut history and the loud one is acted on.
 *
 * ── Why a rename reads as a new file ────────────────────────────────────────
 *
 * `git.mjs` asks for numstat with `diff.renames=false`, so a rename is a
 * delete and an add and the paths in `Commit.filesTouched` stay literal. That
 * is the right trade for every other metric in the series — a renamed file's
 * co-change and re-touch history should not silently follow it to a new name —
 * and it means this module cannot tell `workingLine.ts` → `working.ts`
 * (2026-09-14, in this history) from a file written from scratch. It is
 * accepted rather than fixed: inferring a rename from "a path vanished and a
 * path of about the same size appeared" is a guess, and this module does not
 * guess. What was fixed is the sentence. A crossing with no previous reading
 * no longer claims the file was "first seen at this size" — it says what is
 * actually known, which is that the path was not among the previous commit's
 * big files: new, renamed, or simply under half the limit a commit ago.
 *
 * ── Why the dead export is no longer here ───────────────────────────────────
 *
 * There was a third tripwire: a file's first export that no other blob in the
 * tree named. It was a state reported as an event, and what it actually
 * detected was a module being BORN before its caller landed — which on this
 * repo's shared working tree is most of a normal day. Measured over the same
 * 157 commits: it fired 126 times, which is 126 of the 137 tripwires the whole
 * series produced, naming 277 exports; 100 of those 277 were named by a blob
 * in the tree by the END OF THE SAME DAY, and 8 were never dead at all, just
 * invisible to a tokenizer that stopped reading at the first backtick. The
 * other two tripwires fired 11 times between them in the same history.
 *
 * The state now lives in the row as `deadExports` (`dups.mjs` owns it, because
 * it owns the identifier machinery), and the event is the one comparison the
 * old header claimed and the old code did not make: a name another blob named
 * on the PREVIOUS day-row, whose file still exists, that no blob names today.
 * That is an orphaning, it needs no threshold, and it cannot fire on a file's
 * first day.
 *
 * Nothing here reads a file, runs git, parses TypeScript, or calls a model.
 * Everything is in the snapshot and in the previous row.
 */

// ── formatting ──────────────────────────────────────────────────────────────

/**
 * Thousands separators, written out rather than `toLocaleString`: this string
 * goes into a committed fixture, and `toLocaleString` is a different string on
 * a machine with a different default locale.
 */
function n(x) {
  const s = String(x);
  let out = "";
  for (let i = 0; i < s.length; i++) {
    if (i > 0 && (s.length - i) % 3 === 0) out += ",";
    out += s[i];
  }
  return out;
}

// ── escape hatches ──────────────────────────────────────────────────────────

/** Pattern source -> compiled pair. The sources are the active packs', merged
 *  into `HATCH_KINDS` by `census.mjs`. */
const HATCH_RE = new Map();
function hatchRe(src) {
  let pair = HATCH_RE.get(src);
  if (!pair) {
    pair = { one: new RegExp(src), all: new RegExp(src, "g") };
    HATCH_RE.set(src, pair);
  }
  return pair;
}

/**
 * OCCURRENCES of one hatch kind across the tree's source files.
 *
 * Counted the way `constants.mjs` pins and every pack writes its patterns for
 * — `matchAll`, not matching lines, not substrings — because this number
 * appears in a sentence
 * next to the zero it replaced, and a number counted two ways in two modules
 * is how a report contradicts itself.
 */
function hatchCount(files, src) {
  const { all } = hatchRe(src);
  let total = 0;
  for (const f of files) for (const _ of f.text.matchAll(all)) total++;
  return total;
}

function hatchPresent(files, src) {
  const { one } = hatchRe(src);
  for (const f of files) if (one.test(f.text)) return true;
  return false;
}

// ── the metric ──────────────────────────────────────────────────────────────

/**
 * Everything that changed state at this commit and is worth one sentence, and
 * the state the NEXT commit needs in order to ask the same question.
 *
 * The caller writes both onto the row: `tripwires` and `tripwireState`. A
 * caller that keeps only the first has a series in which nothing can ever fire
 * again after the process that wrote it exits — which is the bug this shape
 * exists to make impossible to reintroduce quietly.
 *
 * @param {import("../types.mjs").Snapshot} snapshot
 * @param {import("../types.mjs").History} _history
 * @param {number} index                 Position in the first-parent walk.
 * @param {typeof import("../constants.mjs").PREREG} prereg
 * @param {import("../types.mjs").Row|null} prevRow
 * @returns {{value: {kind: string, subject: string, detail: string}[],
 *            state: {hatchSeen: string[], near: {loc: number, path: string}[], overLimit: string[]}}}
 */
export function measureTripwires(snapshot, _history, index, prereg, prevRow) {
  const limit = prereg.LINES_TRIPWIRE;
  const nearLimit = Math.floor(limit / 2);

  // ── what is true now ──
  const overLimit = [];
  const near = [];
  for (const f of snapshot.files) {
    if (f.loc >= limit) overLimit.push(f.path);
    // Only the big files' lengths are carried forward: the state exists to
    // print "up from 1,974", and nothing under half the limit can reach it in
    // one commit without that commit being the whole story anyway. It is also
    // what keeps the state small enough to sit in every row — the full set of
    // per-file line counts would be 325 entries a commit.
    if (f.loc >= nearLimit) near.push({ loc: f.loc, path: f.path });
  }
  const hatchNow = [];
  for (const [kind, src] of Object.entries(prereg.HATCH_KINDS)) {
    if (hatchPresent(snapshot.files, src)) hatchNow.push(kind);
  }

  // `snapshot.files` is sorted by path, so `overLimit` and `near` already are;
  // sorting again is cheap and says the ordering is a promise, not a habit.
  overLimit.sort();
  near.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  hatchNow.sort();

  // A state that is missing a list is a state this code cannot read — an older
  // row, or a truncated write. Same rule as no state at all: baseline, never a
  // guess reconstructed from the half that is there.
  const carried = prevRow ? prevRow.tripwireState : null;
  const prev =
    carried && Array.isArray(carried.overLimit) && Array.isArray(carried.near) && Array.isArray(carried.hatchSeen)
      ? carried
      : null;

  const state = {
    // Cumulative: once a kind has been non-zero it can never "appear" again.
    hatchSeen: prev ? [...new Set([...prev.hatchSeen, ...hatchNow])].sort() : hatchNow,
    near,
    overLimit,
  };

  // Baseline. See the header: no chain, no claim. At `index === 0` a
  // 2,400-line file is a state, not a crossing, and `@ts-ignore` present from
  // the start never "appeared".
  if (!prev || index === 0) return { state, value: [] };

  const wasOver = new Set(prev.overLimit);
  const wasNear = new Map(prev.near.map((e) => [e.path, e.loc]));
  const seen = new Set(prev.hatchSeen);
  const fired = [];

  // ── a file crossing the line limit, upward, once ──
  const nowLoc = new Map(near.map((e) => [e.path, e.loc]));
  for (const path of overLimit) {
    if (wasOver.has(path)) continue; // a state, not a crossing
    const now = nowLoc.get(path);
    const before = wasNear.get(path);
    const detail =
      before === undefined
        ? `${n(now)} lines, past the ${n(limit)}-line mark; the path carried no reading a commit ago — ` +
          `under ${n(nearLimit)} lines, or new, or renamed`
        : `${n(before)} → ${n(now)} lines, past the ${n(limit)}-line mark`;
    fired.push({ kind: "file-crossed-lines", subject: path, detail });
  }

  // ── a kind of escape hatch that had never been used ──
  for (const kind of hatchNow) {
    if (seen.has(kind)) continue;
    const count = hatchCount(snapshot.files, prereg.HATCH_KINDS[kind]);
    fired.push({
      kind: "hatch-kind-appeared",
      subject: kind,
      detail: `\`${prereg.HATCH_KINDS[kind]}\` went 0 → ${n(count)} occurrences; ${n(
        hatchNow.length,
      )} of ${n(Object.keys(prereg.HATCH_KINDS).length)} hatch kinds are now in use`,
    });
  }

  // Fixed order, because a row is compared to a committed fixture with
  // `deepEqual`.
  fired.sort((a, b) => (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : a.subject < b.subject ? -1 : a.subject > b.subject ? 1 : 0));
  return { state, value: fired };
}
