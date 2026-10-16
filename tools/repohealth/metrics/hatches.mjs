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
 * ── Explained, unexplained, to-do (since `2026-10-16a`) ─────────────────────
 *
 * The total says how many rules are off; it cannot say whether anybody knows
 * why. An `eslint-disable-next-line x -- the ref is stable` and a bare one are
 * the same count and opposite states of a codebase, so every occurrence is now
 * also CLASSIFIED, off the claiming pack's `hatchExplain` (merged by
 * `census.mjs` into `HATCH_EXPLAIN`):
 *
 *   - **to-do** — `TODO`, `FIXME`, Kotlin's throwing `TODO(` stub. Unfinished
 *     work, not a rule turned off; reported, never in the index.
 *   - **explained** — the reason sits on the same line after the mark (the
 *     pack's `after[kind]`: ESLint's ` -- why`, words after `@ts-expect-error`,
 *     a trailing comment after `as any`), or on the line DIRECTLY above, as a
 *     comment line with words in it that is not itself an escape (a directive
 *     stacked on a directive explains nothing).
 *   - **unexplained** — everything else. This is the number the health index
 *     reads, per kLOC.
 *
 * The line an occurrence sits on is the line holding the END of its match —
 * Python's bare-`except` pattern starts on the newline before it. `value`
 * keeps its shape (every kind, its TOTAL count) so the new-kind tripwire and
 * every older reader mean what they meant; the split rides beside it as
 * `split`. Cost: per occurrence, two short regex tests on one or two lines.
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
 * @returns {import("../types.mjs").Measured<Record<string, number>> & {split?: {explained: number, unexplained: number, todo: number, byKind: Record<string, {explained: number, unexplained: number}>}}}
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
  const explain = prereg.HATCH_EXPLAIN ?? {};
  const cls = kinds.map((k) => {
    const e = explain[k] ?? {};
    return {
      todo: e.todo === true,
      after: e.after ? new RegExp(e.after) : null,
      commentLine: e.commentLine ? new RegExp(e.commentLine) : null,
    };
  });
  // "Is this line itself an escape?" — any non-to-do kind, non-global so a
  // `.test` carries no `lastIndex`.
  const escapeRes = kinds.filter((_, i) => !cls[i].todo).map((k) => new RegExp(prereg.HATCH_KINDS[k]));
  const isEscapeLine = (line) => escapeRes.some((re) => re.test(line));

  /** @type {Record<string, number>} */
  const out = {};
  /** @type {Record<string, {explained: number, unexplained: number}>} */
  const byKind = {};
  let explained = 0;
  let unexplained = 0;
  // To-do kinds can overlap by construction — Kotlin's `TODO(` stub is also
  // `common`'s `TODO` — so the to-do bucket counts each START position once.
  // (The per-kind totals in `value` are left as they always were.)
  const todoAt = new Set();
  for (let i = 0; i < kinds.length; i++) {
    let n = 0;
    const c = cls[i];
    let ex = 0;
    let un = 0;
    for (const f of files) {
      for (const m of f.text.matchAll(res[i])) {
        n++;
        if (c.todo) {
          todoAt.add(`${f.path}\0${m.index}`);
          continue;
        }
        if (explainedAt(f.text, m, c, isEscapeLine)) ex++;
        else un++;
      }
    }
    out[kinds[i]] = n;
    if (!c.todo) {
      byKind[kinds[i]] = { explained: ex, unexplained: un };
      explained += ex;
      unexplained += un;
    }
  }
  return { value: out, split: { explained, unexplained, todo: todoAt.size, byKind } };
}

/**
 * Whether one occurrence carries its reason — see the header. `m` is the
 * match; its line is the one holding the match's last character.
 */
export function explainedAt(text, m, c, isEscapeLine) {
  const end = m.index + Math.max(1, m[0].length);
  const lineStart = text.lastIndexOf("\n", end - 1) + 1;
  let lineEnd = text.indexOf("\n", end);
  if (lineEnd < 0) lineEnd = text.length;
  if (c.after && c.after.test(text.slice(m.index + m[0].length, lineEnd))) return true;
  if (!c.commentLine || lineStart === 0) return false;
  const prevStart = text.lastIndexOf("\n", lineStart - 2) + 1;
  const above = text.slice(prevStart, lineStart - 1);
  return c.commentLine.test(above) && /[A-Za-z]{2}/.test(above) && !isEscapeLine(above);
}
