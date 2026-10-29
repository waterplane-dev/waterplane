/**
 * The BUCKETS a row is counted and cut by — age and kind. ONE function per axis (`ageBucket`,
 * `categoryBucket`) feeds both the chip's number (`cutCounts.ts`) and the cut its tap opens
 * (`rowFilter.ts`): two copies of an edge is how a chip saying 7 opens a list of nine.
 *
 * Part of `backlogFilter.ts`, the barrel every caller imports. Pure, and its
 * imports carry `.ts` because `node --test` loads it straight off the source.
 */
import type { BacklogItem, BacklogStatus, ItemCategory } from "@waterplane/shared";
import { ITEM_CATEGORIES, NO_CATEGORY_LABEL, categoryLabel } from "@waterplane/shared";

const H = 3600_000;

/** How old an entry is, coarsely. The edges a person actually thinks in. */
export type BacklogAge = "hour" | "day" | "week" | "older";
export const BACKLOG_AGES: BacklogAge[] = ["hour", "day", "week", "older"];
export const AGE_LABEL: Record<BacklogAge, string> = {
  hour: "past hour",
  day: "past 24h",
  week: "past week",
  older: "older",
};

/** The statuses, in the order a person scans them: what is live, then what is left. */
export const BACKLOG_STATUSES: BacklogStatus[] = ["running", "queued", "failed", "done"];
export * from "./calledOff.ts"; // the status axis's other edge: a call-off is not a failure

/**
 * The age of an entry. Buckets NEST (an item from ten minutes ago is in "past
 * hour" AND "past 24h"), which is what makes the chips read as time ranges
 * rather than as four disjoint bins nobody can hold in their head; `ageBucket`
 * returns the TIGHTEST one and `withinAge` is what the filter asks.
 *
 * A timestamp in the future (a desktop whose clock moved) is 0 old, not
 * "older" — bucketing it by raw distance would file the newest row last.
 */
export function ageBucket(createdAt: number, now: number): BacklogAge {
  const d = Math.max(0, now - createdAt);
  if (d <= H) return "hour";
  if (d <= 24 * H) return "day";
  if (d <= 7 * 24 * H) return "week";
  return "older";
}

/** Is this item inside (or tighter than) the named window? "older" is its own bin. */
export function withinAge(createdAt: number, age: BacklogAge, now: number): boolean {
  const b = ageBucket(createdAt, now);
  if (age === "older") return b === "older";
  const rank: Record<BacklogAge, number> = { hour: 0, day: 1, week: 2, older: 3 };
  return rank[b] <= rank[age];
}

/**
 * ── What KIND of thing a row is, as a bucket ─────────────────────────────────
 *
 * **One edge, one function.** `categoryBucket` is what the chip COUNTS and what
 * the cut KEEPS, for the reason `ageBucket` states one screen up: two readings
 * of "this row has no kind" is how a chip saying 7 opens a list of nine.
 *
 * The bucket has five values and not four. **Absent means NOBODY SAID**
 * (`naming.ts`'s rule, and the reason `cleanCategory` knows no synonyms), which
 * is a real answer and the one a person most often wants a cut of: the rows
 * nothing has looked at yet are exactly the rows the naming pass is for. It is
 * spelled `"none"` here and rendered with `NO_CATEGORY_LABEL`, never as a fifth
 * category and never as "chore".
 */
export type CategoryBucket = ItemCategory | "none";
export const CATEGORY_BUCKETS: readonly CategoryBucket[] = [...ITEM_CATEGORIES, "none"];
export function categoryBucket(it: Pick<BacklogItem, "category">): CategoryBucket {
  return it.category ?? "none";
}
/** The word on the chip. The four are `categoryLabel`'s — never re-worded here,
 *  for `describeRule`'s reason — and the fifth is the shared spelling of
 *  "nobody said". */
export const CATEGORY_CHIP_LABEL: Record<CategoryBucket, string> = {
  bug: categoryLabel("bug"),
  feature: categoryLabel("feature"),
  enhancement: categoryLabel("enhancement"),
  chore: categoryLabel("chore"),
  none: NO_CATEGORY_LABEL,
};
/**
 * …and what the chip promises before the tap, per state.
 *
 * `active` is the chip that is already on, where the tap CLEARS it: a filter
 * with no way out is a list that is simply wrong, and on a phone the bar is a
 * scroll away from the rows it is cutting. The `none` bucket says what it is
 * about rather than naming a kind, because "show only no kind items" reads as a
 * typo.
 */
export function categoryChipTitle(c: CategoryBucket, active: boolean): string {
  if (active) return "show every kind again";
  return c === "none"
    ? "show only the items nothing has said a kind for — the rows a naming pass is for"
    : `show only the ${c === "bug" ? "bugs" : `${c}s`}`;
}
