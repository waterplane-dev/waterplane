/**
 * Which rows are on screen: the search text, the repo scope (remembered), the
 * archived toggle (remembered), and the status/age/kind/clock/ids cut — which
 * is the TAP, never a setting, and is cleared with the sheet. Holds the one
 * effect that applies a cut asked for from outside (`focusIds`).
 */
import { useEffect, useRef, useState } from "react";
import { NO_BACKLOG_FILTER, type BacklogFilter } from "../backlogFilter";
import { LS, lsDel, lsGet, lsSet } from "../storage";
import type { BacklogProps } from "./backlogTypes";

const ARCHIVED_KEY = LS.backlogShowArchived;
const REPO_KEY = LS.backlogRepo;

export function useBacklogFilters(p: BacklogProps) {
  /** The search box. It used to be one field doing two jobs — search THIS
   *  repo's items, and be the draft for a new one — which is why the words a
   *  person typed to add something also silently emptied the list underneath
   *  them. Now it only searches, and is not persisted: a query kept from three
   *  days ago is a list that comes up short with no explanation. */
  const [text, setText] = useState("");
  // Scope to one repo. Prefer the repo we opened from, then the last-used, then a
  // repo that actually has items, then the first repo.
  const initialRepo = (() => {
    if (p.defaultRepoDir && p.repos.some((r) => r.worktreePath === p.defaultRepoDir)) return p.defaultRepoDir;
    const saved = lsGet(REPO_KEY);
    if (saved && p.repos.some((r) => r.worktreePath === saved)) return saved;
    const withItems = p.items.find((it) => !it.archived && p.repos.some((r) => r.worktreePath === it.repoDir));
    return withItems?.repoDir ?? p.repos[0]?.worktreePath ?? "";
  })();
  const [repoDir, setRepoDirState] = useState(initialRepo);
  // Re-scope once per `defaultRepoDir` value (it changes, or the repo list lands
  // after mount) — never again, so a hand-picked repo is not fought.
  const defaultApplied = useRef(initialRepo === p.defaultRepoDir ? p.defaultRepoDir : undefined);
  useEffect(() => {
    const d = p.defaultRepoDir;
    if (!d || defaultApplied.current === d || !p.repos.some((r) => r.worktreePath === d)) return;
    defaultApplied.current = d;
    setRepoDirState(d);
    setFilter((f) => (f.ids ? { ...f, ids: null } : f));
    setIdsLabel(undefined);
  }, [p.defaultRepoDir, p.repos]);
  const [showArchived, setShowArchived] = useState<boolean>(() => lsGet(ARCHIVED_KEY) === "1");
  /**
   * Status + age cut, and NOT a setting: it is cleared when this sheet closes,
   * because a filter made three days ago and shown nowhere is how a list comes
   * up short with no explanation. Same rule the schedules chip follows.
   */
  const [filter, setFilter] = useState<BacklogFilter>(
    p.focusIds ? { ...NO_BACKLOG_FILTER, ids: p.focusIds.ids } : NO_BACKLOG_FILTER,
  );
  /**
   * What the ids cut IS, in the words of the tap that opened it.
   *
   * `backlogFilterSentence` takes it rather than inventing one, because only
   * this sheet knows which side of a merge was tapped: "merged into “x”" from
   * the merged row's own chip, "the row “y” was merged into" from an original's.
   * A label the filter module made up would be the same sentence for both, and
   * the bar would then describe a different cut than the one on screen.
   */
  const [idsLabel, setIdsLabel] = useState<string | undefined>(p.focusIds?.label);
  /** Open an ids cut and say what it is. One function, so the two chips cannot
   *  set the ids without also setting the words that explain them. */
  const showIds = (ids: string[], label: string) => { setIdsLabel(label); setFilter((f) => ({ ...f, ids })); };
  const clearFilter = () => { setIdsLabel(undefined); setFilter(NO_BACKLOG_FILTER); };
  /**
   * A cut asked for from OUTSIDE, applied whenever the ask changes.
   *
   * Not only at mount: this sheet stays mounted while a second notification
   * lands or a second schedule card is tapped behind it, and a tap that quietly
   * did nothing because the overlay was already open is the same lost count.
   * Compared by the object's IDENTITY — the caller mints a fresh one per tap,
   * so tapping the same cut twice re-applies it after a `clear`.
   */
  const focusSeen = useRef<unknown>(p.focusIds);
  useEffect(() => {
    if (focusSeen.current === p.focusIds) return;
    focusSeen.current = p.focusIds;
    if (!p.focusIds) return;
    setIdsLabel(p.focusIds.label);
    setFilter({ ...NO_BACKLOG_FILTER, ids: p.focusIds.ids });
  }, [p.focusIds]);

  function selectRepo(dir: string) {
    setRepoDirState(dir);
    if (dir) lsSet(REPO_KEY, dir);
    // An ids cut names specific rows of the repo it was opened from, so it can
    // only ever match nothing here. Status and age are dimensions that mean the
    // same thing in every repo and are deliberately left alone.
    setFilter((f) => (f.ids ? { ...f, ids: null } : f));
    setIdsLabel(undefined);
  }
  /** Tapping the chip that is already on clears it — a filter with no way out is
   *  a list that is simply wrong, and on a phone the bar is a scroll away. */
  const pickStatus = (v: BacklogFilter["status"]) => setFilter((f) => ({ ...f, status: f.status === v ? null : v }));
  const pickAge = (v: BacklogFilter["age"]) => setFilter((f) => ({ ...f, age: f.age === v ? null : v }));
  const pickCategory = (v: BacklogFilter["category"]) => setFilter((f) => ({ ...f, category: f.category === v ? null : v }));
  /** The fourth axis, and the only boolean one: on a clock, or no filter. */
  const pickClock = () => setFilter((f) => ({ ...f, clock: f.clock ? null : true }));

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
