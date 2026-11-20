/**
 * The value and cost BUCKETS — `rowBuckets.ts`' rule for two more axes: one
 * function per axis feeds the chip's count (`cutCounts.ts`) and the cut
 * (`rowFilter.ts`).
 *
 * Part of `backlogFilter.ts`, the barrel every caller imports. Pure, and its
 * imports carry `.ts` because `node --test` loads it straight off the source.
 */
import type { BacklogItem, ItemValue } from "@waterplane/shared";
import { ITEM_VALUES, estimateDollars } from "@waterplane/shared";

/**
 * ── What a row is WORTH and what it COSTS, as buckets ────────────────────────
 *
 * Same rule as the kind: one function is what the chip counts and the cut keeps,
 * and `none` is "nobody said" (`shared/estimate.ts`), a cut of its own.
 */
export type ValueBucket = ItemValue | "none";
export const VALUE_BUCKETS: readonly ValueBucket[] = [...ITEM_VALUES, "none"];
export function valueBucket(it: Pick<BacklogItem, "value">): ValueBucket {
  return it.value ?? "none";
}
export const VALUE_CHIP_LABEL: Record<ValueBucket, string> = {
  high: "high", medium: "medium", low: "low", none: "no value",
};

/** Cost from the estimate's dollars (`estimateDollars`, a range's middle). An
 *  estimate naming no dollar figure is `none`, never "cheap". */
export type CostBucket = "small" | "mid" | "big" | "none";
export const COST_BUCKETS: readonly CostBucket[] = ["small", "mid", "big", "none"];
export function costBucket(it: Pick<BacklogItem, "estimate">): CostBucket {
  const d = estimateDollars(it.estimate);
  return d === null ? "none" : d <= 5 ? "small" : d <= 20 ? "mid" : "big";
}
export const COST_CHIP_LABEL: Record<CostBucket, string> = {
  small: "≤ $5", mid: "$5–20", big: "> $20", none: "no estimate",
};
