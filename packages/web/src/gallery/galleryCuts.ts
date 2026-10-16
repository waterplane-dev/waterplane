import { SINCE } from "./galleryTypes.ts";

/**
 * What the bar over the badge's cut says. The count the badge showed is the headline; the rows
 * actually listed are said only when they differ from it (a file deleted since, or a page cap),
 * and never while the listing is still on the wire, when "0 still here" would be a guess.
 */
export function newCutText(count: number, listed: number, loading: boolean, truncated: boolean): string {
  const head = `${count} new since you last looked`;
  if (loading || listed === count) return head;
  if (truncated) return `${head} · newest ${listed} shown`;
  return `${head} · ${listed} still here`;
}

/** The empty grid's sentence when only the time cut is hiding things. Null when it is not. */
export function emptyCutText(since: number | undefined): string | null {
  const s = SINCE.find((x) => x.secs === since);
  return s ? `Nothing from the last ${s.long}.` : null;
}
