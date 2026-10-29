/**
 * **How the rows are drawn** — newest first, or in the order they will run.
 *
 * A VIEW, never a move: the host's order (`order ?? createdAt`) is the run
 * order and nothing here writes it. *Newest first* is the default because the
 * question a person opens the sheet with is usually "where is the thing I just
 * added" — in run order it sat at the bottom of a long list. The number down
 * the left stays the row's RUN position in either view (`runSeats`), so the
 * newest-first list never claims a row runs first because it is drawn first.
 *
 * The *on a clock* cut always draws in run order: its heads say "in this
 * order", and that cut exists to show it.
 *
 * Part of `backlogFilter.ts`, the barrel every caller imports. Pure, and its
 * imports carry `.ts` because `node --test` loads it straight off the source.
 */
import type { BacklogItem } from "@waterplane/shared";

export type BacklogSort = "newest" | "run";

export const SORT_LABEL: Record<BacklogSort, string> = {
  newest: "newest first",
  run: "run order",
};

/** What the switch says while the list is NOT in run order: why the move verbs are absent. */
export const SORT_NEWEST_NOTE = "the number is each row's place in the run order — switch to run order to move rows";

/** What the switch says while the clock cut overrides it. */
export const SORT_CLOCK_NOTE = "the on-a-clock cut is always in run order";

/** The sort that applies to this cut: the clock cut is run order whatever was picked. */
export function effectiveSort(sort: BacklogSort, clockCut: boolean): BacklogSort {
  return clockCut ? "run" : sort;
}

/**
 * The rows of one group as drawn. `items` arrive in run order; *newest* draws
 * them by `createdAt` descending, ties kept in run order (stable sort).
 */
export function sortRows(items: BacklogItem[], sort: BacklogSort): BacklogItem[] {
  if (sort === "run") return items;
  return [...items].sort((a, b) => b.createdAt - a.createdAt);
}

/** Each row's 1-based seat in its group's RUN order — the number drawn on it in either view. */
export function runSeats(items: BacklogItem[]): Map<string, number> {
  return new Map(items.map((it, i) => [it.id, i + 1]));
}
