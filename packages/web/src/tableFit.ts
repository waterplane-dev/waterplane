/**
 * How a reader table's columns behave when the table is wider than the screen
 * — pure, so the rule is node-tested (`tableFit.test.mjs`).
 *
 * Every cell used to be `nowrap`, so a table with one sentence-long column
 * scrolled sideways for screens. Wrapping EVERYTHING is wrong the other way: a
 * price, a round number or `2 (vault)` broken over two lines reads worse than
 * a scroll. So each column is judged by its BODY cells (a long header over a
 * column of short numbers wraps itself, never the numbers):
 *
 *  - `keep` — every cell is short: it stays on one line.
 *  - `wrap` — prose: it wraps, but never narrower than `minCh` (its longest
 *    word, clamped), so a squeezed column does not turn into a word per line.
 *
 * The browser's auto table layout only breaks a line when the table would not
 * fit otherwise, so a table that fits is drawn exactly as before.
 */

export type ColFit = { kind: "keep" } | { kind: "wrap"; minCh: number };

/** A body cell this long (visible characters) or shorter never forces a column to wrap. */
export const KEEP_MAX_CH = 16;
/** A wrapping column's floor, in `ch`: its longest word, clamped to this range. */
export const WRAP_MIN_CH = 10;
export const WRAP_MAX_CH = 22;

/** The cell as it will READ — markdown markers out, link targets dropped. */
export function visibleText(cell: string): string {
  // `](target)` is dropped by hand: a regex for it backtracks quadratically.
  let out = "";
  for (let i = 0; i < cell.length; i++) {
    const ch = cell[i];
    if (ch === "]" && cell[i + 1] === "(") {
      const close = cell.indexOf(")", i + 2);
      if (close !== -1) { i = close; continue; }
    }
    if ("`*_~[!".includes(ch) && !(ch === "!" && cell[i + 1] !== "[")) continue;
    out += ch;
  }
  return out.trim();
}

export function columnFits(body: readonly (readonly string[])[], cols: number): ColFit[] {
  const out: ColFit[] = [];
  for (let c = 0; c < cols; c++) {
    let longest = 0, word = 0;
    for (const row of body) {
      const t = visibleText(row[c] ?? "");
      longest = Math.max(longest, t.length);
      for (const w of t.split(/\s+/)) word = Math.max(word, w.length);
    }
    out.push(longest <= KEEP_MAX_CH
      ? { kind: "keep" }
      : { kind: "wrap", minCh: Math.min(WRAP_MAX_CH, Math.max(WRAP_MIN_CH, word)) });
  }
  return out;
}
