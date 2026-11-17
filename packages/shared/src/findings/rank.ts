import type { Finding, FindingKind } from "./types.js";

const KIND_ORDER: Record<FindingKind, number> = { cost: 0, quality: 1, watch: 2, install: 3 };

const isWaived = (f: Finding): boolean => f.waive.waived !== undefined;

/**
 * The one order: unwaived first; `finding` before `consider`; priced saving by usd descending; then
 * token saving descending; then quality, watch, install; then id. No score is computed or printed.
 * (A cost finding with no saving sorts after one with a saving of the same weight.)
 */
export function rankFindings(list: readonly Finding[]): Finding[] {
  return [...list].sort((a, b) => {
    const w = Number(isWaived(a)) - Number(isWaived(b));
    if (w) return w;
    const wt = Number(a.weight === "consider") - Number(b.weight === "consider");
    if (wt) return wt;
    const au = a.saving?.usd ?? -1, bu = b.saving?.usd ?? -1;
    if (au !== bu) return bu - au;
    const at = a.saving?.tokens ?? -1, bt = b.saving?.tokens ?? -1;
    if (at !== bt) return bt - at;
    const k = KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
    if (k) return k;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}
