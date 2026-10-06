/**
 * The escape hatches, counted as occurrences.
 *
 * ── Why this is the cheap half of a question worth asking ───────────────────
 *
 * `: any`, `as any`, `as unknown as`, `eslint-disable`, `@ts-ignore`, `TODO`,
 * `FIXME` are the places where a rule was turned off on purpose. WHICH marks
 * exist to look for is a fact about a toolchain and belongs to the packs —
 * `packs/typescript.mjs` for the seven that name TypeScript or ESLint,
 * `packs/common.mjs` for `TODO` and `FIXME`, which are written by hand in
 * every language — and `census.mjs` merges the active ones into
 * `HATCH_KINDS`, refusing a kind name two packs claim. Whether any one of
 * them was right is a judgment; how many there are, and whether that number
 * is moving, is arithmetic. This module does the arithmetic and says nothing
 * about whether the number is high — there is no threshold anywhere in this
 * tool, for the reason `constants.mjs` gives at length.
 *
 * ── Three ways to count, three different numbers ────────────────────────────
 *
 * This is counted with `matchAll` — OCCURRENCES. The alternatives are not
 * rounding errors of each other:
 *
 *   - `grep -c` counts matching LINES, so two hatches on one line count once.
 *   - a substring match for `as any` counts "has any" and "was any" in prose:
 *     32 hits at HEAD against 8 real ones. The `\b` anchors the packs write
 *     into every pattern exist precisely to stop that, which is why those
 *     patterns are stored as regex SOURCE and compiled here rather than stored
 *     as plain strings and `includes`-ed.
 *
 * Any of the three is defensible; a series that silently switches between them
 * is not, because the switch looks exactly like the codebase changing. The
 * fixture pins this one.
 *
 * ── Why zeros are returned ──────────────────────────────────────────────────
 *
 * Every kind the active packs merged into `HATCH_KINDS` comes back, including
 * the ones sitting at 0 (`@ts-ignore`, `@ts-expect-error`, `@ts-nocheck` at
 * the time of writing). The "a new kind of escape hatch appeared" tripwire diffs this object against
 * the previous row; a kind that is simply missing from both objects can never
 * produce a diff, and a kind that appears out of nowhere is indistinguishable
 * from a kind whose count moved. A stable shape makes the diff mean one thing.
 *
 * Note the asymmetry with rule 1 (absent is null, never 0): a kind at 0 is not
 * absent. It was looked for across every source file and genuinely found zero
 * times. The `null` case here is "there were no files to look in at all" —
 * which is also what a repo no pack claims reports, since nothing in it is
 * source and there is nothing to count marks in.
 *
 * ── Purity ──────────────────────────────────────────────────────────────────
 *
 * Text comes from the snapshot; nothing is read, spawned or fetched.
 */

/**
 * @param {import("../types.mjs").Snapshot} snapshot
 * @param {import("../types.mjs").History} history
 * @param {number} index
 * @param {import("../types.mjs").EffectivePrereg} prereg
 * @returns {import("../types.mjs").Measured<Record<string, number>>}
 */
export function measureHatches(snapshot, history, index, prereg) {
  const files = snapshot.files ?? [];
  if (files.length === 0) return { value: null, reason: "no source files at this commit" };

  // Keys sorted rather than left in the merge order `census.mjs` produced:
  // the JSONL row is written by `JSON.stringify`, so key order is bytes on
  // disk, and reordering a pack's literal for readability — or activating a
  // second pack — would then rewrite every row in the file without changing a
  // single count.
  const kinds = Object.keys(prereg.HATCH_KINDS).sort();

  // Compiled fresh per call. `matchAll` refuses a non-global regex, and a
  // module-level global regex carries `lastIndex` between calls — the classic
  // way to get a count that depends on what was measured before it.
  const res = kinds.map((k) => new RegExp(prereg.HATCH_KINDS[k], "g"));

  /** @type {Record<string, number>} */
  const out = {};
  for (let i = 0; i < kinds.length; i++) {
    let n = 0;
    for (const f of files) {
      for (const _ of f.text.matchAll(res[i])) n++;
    }
    out[kinds[i]] = n;
  }
  return { value: out };
}
