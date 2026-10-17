/**
 * The tiles grid's own words: the tile's fold verb and toggle name, and the
 * per-area absences the weight card prints in the open. Pure, node-tested
 * (`repoHealthTileGeom.test.mjs`), and under the same verdict-word ban as
 * `repoHealthWords.ts` (registered in `repoHealthWords.test.mjs`).
 */

/** The verb that folds an open tile back into the grid. */
export const TILE_FOLD_LABEL = "fold";

/** The tile head's name for long press and the screen reader. */
export function tileToggleTitle(label: string, open: boolean): string {
  return open ? `${label}: fold back into the grid` : `${label}: open the chart, its readout and what the tool reads into it`;
}

/** The summary of a card's folded method notes. */
export const TILES_MORE_SUMMARY = "how these are drawn";

/** The summary of the repo's own readings' folded note. */
export const OWN_MORE_SUMMARY = "how these are taken";

/**
 * Why there is no per-area spread, in the open — three states, and two of them
 * used to draw nothing at all. Null when there are areas to draw.
 */
export function areaAbsentWords(context: {
  areas: Record<string, unknown>;
  absent?: string;
  areasAbsent?: string;
}): string | null {
  if (context.absent) return `The per-area reading was not taken on the latest day — ${context.absent}`;
  if (Object.keys(context.areas).length) return null;
  return (
    `No per-area reading here${context.areasAbsent ? ` — ${context.areasAbsent}` : ""}. ` +
    "The always-on weight above is the whole tree's and is unaffected."
  );
}
