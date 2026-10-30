/**
 * Which rows are on screen: the search text, the repo scope, the archived
 * toggle (remembered), and the status/age/kind/clock/ids cut — which is the
 * TAP, never a setting, and is cleared with the sheet. The cut is NOT state
 * here: it is `p.cut`, one store outside this sheet, read every render and
 * written through `p.setCut`, so Back and the doors move the same value.
 */
import { useEffect, useState } from "react";
import { scopedRepo } from "./scopedRepo.ts";
import { NO_BACKLOG_FILTER, type BacklogFilter } from "../backlogFilter.ts";
import { LS, lsDel, lsGet, lsSet } from "../storage.ts";
import type { BacklogProps } from "./backlogTypes";

const ARCHIVED_KEY = LS.backlogShowArchived;
const REPO_KEY = LS.backlogRepo;

export function useBacklogFilters(p: BacklogProps) {
  /** The search box. It used to be one field doing two jobs — search THIS
   *  repo's items, and be the draft for a new one — which is why the words a
   *  person typed to add something also silently emptied the list underneath
   *  them. Now it only searches, and is not persisted: a query kept from three
   *  days ago is a list that comes up short with no explanation. */
  const { cut, setCut } = p;
  const { text, filter, idsLabel } = cut;
  const setText = (t: string) => setCut((c) => ({ ...c, text: t }));
  // Scope to one repo: the one the cut names, then the session we came from,
  // then the last-used, then a repo that actually has items, then the first.
  // A repo derived from the items is PINNED into the cut (effect below), so
  // deleting its last row does not move the sheet to another repo.
  const { repoDir, derived } = scopedRepo({
    repos: p.repos, items: p.items, cutRepo: cut.repoDir, sessionRepo: p.defaultRepoDir, saved: lsGet(REPO_KEY),
  });
  useEffect(() => {
    if (derived) setCut((c) => (c.repoDir === repoDir ? c : { ...c, repoDir }));
  }, [derived, repoDir, setCut]);
  const [showArchived, setShowArchived] = useState<boolean>(() => lsGet(ARCHIVED_KEY) === "1");
  /**
   * `idsLabel` is what the ids cut IS, in the words of the tap that opened it.
   *
   * `backlogFilterSentence` takes it rather than inventing one, because only
   * this sheet knows which side of a merge was tapped: "merged into “x”" from
   * the merged row's own chip, "the row “y” was merged into" from an original's.
   * A label the filter module made up would be the same sentence for both, and
   * the bar would then describe a different cut than the one on screen.
   *
   * Open an ids cut and say what it is. One function, so the two chips cannot
   * set the ids without also setting the words that explain them.
   */
  const showIds = (ids: string[], label: string) => setCut((c) => ({ ...c, idsLabel: label, filter: { ...c.filter, ids } }));
  const clearFilter = () => setCut((c) => ({ ...c, idsLabel: undefined, filter: NO_BACKLOG_FILTER }));

  function selectRepo(dir: string) {
    if (dir) lsSet(REPO_KEY, dir);
    // An ids cut names specific rows of the repo it was opened from, so it can
    // only ever match nothing here. Status and age are dimensions that mean the
    // same thing in every repo and are deliberately left alone (`cutForRepo`).
    setCut((c) => ({ ...c, repoDir: dir, filter: c.filter.ids ? { ...c.filter, ids: null } : c.filter, idsLabel: undefined }));
  }
  /** Tapping the chip that is already on clears it — a filter with no way out is
   *  a list that is simply wrong, and on a phone the bar is a scroll away. */
  const pick = (f: (prev: BacklogFilter) => BacklogFilter) => setCut((c) => ({ ...c, filter: f(c.filter) }));
  const pickStatus = (v: BacklogFilter["status"]) => pick((f) => ({ ...f, status: f.status === v ? null : v }));
  const pickAge = (v: BacklogFilter["age"]) => pick((f) => ({ ...f, age: f.age === v ? null : v }));
  const pickCategory = (v: BacklogFilter["category"]) => pick((f) => ({ ...f, category: f.category === v ? null : v }));
  /** The fourth axis, and the only boolean one: on a clock, or no filter. */
  const pickClock = () => pick((f) => ({ ...f, clock: f.clock ? null : true }));

  function toggleArchived() {
    const next = !showArchived;
    setShowArchived(next);
    if (next) lsSet(ARCHIVED_KEY, "1");
    else lsDel(ARCHIVED_KEY);
  }
  return {
    text,
    setText,
    repoDir,
    showArchived,
    filter,
    idsLabel,
    showIds,
    clearFilter,
    selectRepo,
    pickStatus,
    pickAge,
    pickCategory,
    pickClock,
    toggleArchived,
  };
}
