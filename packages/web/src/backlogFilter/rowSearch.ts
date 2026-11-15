/**
 * **The text search over a cut** (R-queue-010). The add field doubles as a
 * search over THIS repo's rows: the status/age/category filter has already cut
 * `cut`, and the text only narrows what is left — an intersection, so a text
 * match outside the filter stays hidden.
 *
 * The string searched is the string shown: `itemHeadline` (a typed label beats
 * a derived title), then the label, then the prose. Not in the barrel on
 * purpose (`tools/backlogpins.test.mjs` pins its export list); callers import
 * this file. Pure; imports carry `.ts` for `node --test`.
 */
import { itemHeadline, type BacklogItem } from "@waterplane/shared";

export function searchBacklog(cut: BacklogItem[], text: string): BacklogItem[] {
  const q = text.trim().toLowerCase();
  if (!q) return cut;
  return cut.filter((it) => `${itemHeadline(it) ?? ""} ${it.label ?? ""} ${it.text}`.toLowerCase().includes(q));
}
