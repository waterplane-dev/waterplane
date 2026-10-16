import { useMemo, useState } from "react";
import {
  activityCounts, activityHeadlineCut, activityRows, dismissBlocker, groupActivity, isActivityDebris, matchesFilter,
  partitionBulk, refireBlocker, sortActivity,
  type ActivityFilter, type ActivityGroup, type ActivitySort,
} from "../activityRows";
import { isCreateOp, isEditableEntry } from "../outbox";
import { usePeerJobsSection } from "../peersSlot";
import { track } from "../usage";
import { useNow } from "../useNow";
import type { ActivitySheetProps } from "./activitySheetTypes";

/**
 * Every piece of state and every derived list the Activity sheet draws, in the
 * order the single component used to declare them (hook order is behaviour).
 * The region components below read this and hold no hooks of their own.
 */
export function useActivityModel(p: ActivitySheetProps) {
  const [filter, setFilter] = useState<ActivityFilter>("all");
  /** The caller's shortlist, until the person drops it. Seeded once — a prop
   *  that kept re-asserting itself would make "show everything" a button that
   *  undoes itself on the next render. */
  const [focus, setFocus] = useState<{ keys: ReadonlySet<string>; label: string } | null>(
    () => (p.focus && p.focus.keys.length ? { keys: new Set(p.focus.keys), label: p.focus.label } : null),
  );
  /**
   * Triage state — deliberately NOT persisted.
   *
   * Every one of these four hides or reorders rows, and this is the screen a
   * person opens to find a prompt they think they lost. A toggle silently still
   * on from last week, on the visit where something is actually missing, would
   * be indistinguishable from the failure this whole rework is about. They cost
   * one tap and they are visible while they are on.
   */
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set<string>());
  /** On by default: it only ever COLLAPSES identical words, says ×N while it
   *  does, and expands in place. Nothing leaves the screen. */
  const [grouped, setGrouped] = useState(true);
  /** Off by default: this one genuinely removes rows, and the argument above
   *  applies to it and not to grouping. The chip says how many it would hide. */
  const [hideDebris, setHideDebris] = useState(false);
  const [sort, setSort] = useState<ActivitySort>("ranked");
  /**
   * One clock for the whole sheet.
   *
   * Everything time-shaped here — "3m ago", "in 2h", a retry countdown, the
   * staleness label — is a function of NOW, and the rows only change when
   * something happens, which on a bad link is exactly what isn't happening.
   * Without a tick the screen freezes at the moment it matters most. Ten
   * seconds, not one: nothing on this sheet is a per-second readout, and a
   * whole list re-rendering at 1 Hz on a phone is the cost, not the feature.
   */
  const now = useNow(10_000);

  const rows = useMemo(() => activityRows({
    now,
    online: p.online,
    hostSeenAt: p.hostSeenAt,
    deps: {
      isEditableEntry, isCreateOp,
      laneLabel: p.laneLabel,
      repoName: p.repoName,
    },
    outbox: p.outbox,
    queueBlocked: p.queueBlocked,
    goneLanes: new Set(p.goneLanes),
    intents: p.intents,
    pulls: p.pulls,
    sessions: p.sessions,
    dismissed: p.dismissed,
    confirmedDone: p.confirmedDone,
  }), [now, p.online, p.hostSeenAt, p.laneLabel, p.repoName,
    p.outbox, p.queueBlocked, p.goneLanes, p.intents, p.pulls, p.sessions, p.dismissed, p.confirmedDone]);

  const counts = useMemo(() => activityCounts(rows), [rows]);
  const inFilter = useMemo(() => sortActivity(
    rows.filter((r) => (focus ? focus.keys.has(r.key) : matchesFilter(r, filter))), sort,
  ), [rows, filter, sort, focus]);
  /** How many of the caller's rows are actually still here. A row it named can
   *  have retired between the tap and the paint (a delivery settled, a retry
   *  landed), and "showing 2" over one row is the kind of small lie this screen
   *  exists to not tell. */
  const focusMissing = focus ? focus.keys.size - inFilter.length : 0;
  const debrisCount = useMemo(() => inFilter.filter(isActivityDebris).length, [inFilter]);
  const shown = useMemo(() => (hideDebris ? inFilter.filter((r) => !isActivityDebris(r)) : inFilter), [inFilter, hideDebris]);
  const groups = useMemo(() => groupActivity(shown, rows, { group: grouped }), [shown, rows, grouped]);
  // Under a shortlist the sentence counts the shortlist: "2 need you" over rows
  // that are not on screen is a number nobody can find. Off a shortlist it is a
  // tap onto exactly the rows it counted — unless that chip is already the view.
  const head = activityHeadlineCut(focus ? inFilter : rows, p.online);
  const headline = head?.text ?? null;
  const headlineCut = head && !focus && head.cut !== filter ? head.cut : null;
  const PeerJobs = usePeerJobsSection();

  // ── Selection ──
  //
  // Kept as row KEYS rather than rows, so a list that re-derives every ten
  // seconds (the clock ticks, a verdict changes, a row settles) does not lose
  // what was picked. A key that stops existing simply stops being counted; the
  // bulk buttons work off the rows that are on screen NOW.
  const pickedRows = useMemo(() => shown.filter((r) => selected.has(r.key)), [shown, selected]);
  const toggleRow = (key: string) => setSelected((s) => {
    const next = new Set(s);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });
  const toggleGroup = (g: ActivityGroup) => setSelected((s) => {
    const next = new Set(s);
    const all = g.rows.every((r) => next.has(r.key));
    for (const r of g.rows) { if (all) next.delete(r.key); else next.add(r.key); }
    return next;
  });
  const selectVisible = () => { track("action:activity.selectall"); setSelected(new Set(shown.map((r) => r.key))); };
  const clearSelection = () => { track("action:activity.selectnone"); setSelected(new Set<string>()); };

  // What each bulk button would actually cover — computed from the SAME pure
  // rules the per-row buttons publish, so the count on the button and the rows
  // it acts on can never disagree.
  const refire = partitionBulk(pickedRows, refireBlocker);
  const file = partitionBulk(pickedRows, dismissBlocker);
  const restorable = pickedRows.filter((r) => r.dismissedAt != null);

  return {
    filter, setFilter, focus, setFocus, selecting, setSelecting, selected, setSelected, grouped, setGrouped,
    hideDebris, setHideDebris, sort, setSort, now, rows, counts, shown, groups, headline, headlineCut, PeerJobs, debrisCount,
    focusMissing, pickedRows, toggleRow, toggleGroup, selectVisible, clearSelection, refire, file, restorable,
  };
}

export type ActivityModel = ReturnType<typeof useActivityModel>;
