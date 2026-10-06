/**
 * Which mark a size gets. Pure, so the rule is testable in node: the spec's cut
 * (`brand/brand.json` `smallCutPx`, pinned by `Logo.test.mjs`) says every raster
 * below 64 px uses the simplified mark, because the full one's detail turns to
 * mud at that size.
 */
export const SMALL_CUT_PX = 64;

export function useSmallMark(size: number): boolean {
  return size < SMALL_CUT_PX;
}
