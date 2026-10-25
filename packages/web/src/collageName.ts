/**
 * The combined image's file name, and what the upload path reads back off it.
 *
 * The upload width is a width for ONE screen. Applied to a whole collage, four
 * phone screenshots across at 1080 px left each panel ~260 px wide, too small
 * to read (2026-10-25). So the cap scales with the columns and each panel gets
 * the width a single picture would. The NAME carries the column count because
 * it is the one fact that survives the annotator (`<base>-marked.png`) into
 * every upload path. Pure and import-free so `node --test` pins writer and
 * reader together (`collageName.test.mjs`).
 */

/**
 * The name the combined file gets.
 *
 * It says what it is and how many screens went into it, because this name is
 * what the minted inbox path is built from (`plannedInboxPath`) and therefore
 * the only human-readable thing about the path the prompt ends up naming.
 */
export function collageFileName(count: number, cols: number): string {
  return `combined-${count}-screens-${cols}across.jpg`;
}

const ACROSS = /^combined-\d+-screens-(\d+)across\b/;

/** How many panels sit side by side in this file — 1 for anything not made by `collageFileName`. */
export function panelsAcross(name: string): number {
  const n = Number(ACROSS.exec(name)?.[1] ?? 1);
  return Number.isInteger(n) && n >= 1 && n <= 12 ? n : 1;
}

/** The width cap for THIS file: `width` per panel; 0 (full size) stays 0. */
export const uploadWidthFor = (name: string, width: number): number => (width ? width * panelsAcross(name) : 0);
