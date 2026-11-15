/**
 * The draw order the sheet remembers: newest first unless run order was
 * picked, and only that answer is stored. A view, never a move (`rowSort.ts`).
 */
import { useState } from "react";
import type { BacklogSort } from "../backlogFilter";
import { sortFromStored } from "../backlogFilter/sortDefault";
import { LS, lsDel, lsGet, lsSet } from "../storage";

const SORT_KEY = LS.backlogSortRun;

export function useBacklogSort() {
  const [sort, setSortState] = useState<BacklogSort>(() => sortFromStored(lsGet(SORT_KEY)));
  const setSort = (next: BacklogSort) => {
    setSortState(next);
    if (next === "run") lsSet(SORT_KEY, "1");
    else lsDel(SORT_KEY);
  };
  return { sort, setSort };
}
