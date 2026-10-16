import { chipText } from "../kit/chips";
import { FilterChip } from "../kit/FilterChip";
import { track } from "../usage";
import { activityChips } from "./activityChips";
import type { ActivityModel } from "./useActivityModel";

/** The chip row, the line naming the empty buckets, and the triage toggles — the sheet's fixed head. */
export function ActivityHead({ m }: { m: ActivityModel }) {
  const { filter, focus, setFocus, setFilter, counts, selecting, setSelecting, setSelected, grouped, setGrouped, sort, setSort, debrisCount, hideDebris, setHideDebris } = m;
  const { chips, none } = activityChips(counts, filter, !!focus);
  return (
    <>
      {/* A chip is a statement about the whole list, so tapping one drops the caller's
          shortlist rather than intersecting with it — two filters at once is the state nobody
          can read off this header. Which chips are drawn, and the empty ones said as words:
          `activityChips`. */}
      {chips.length ? (
        <div className="fchips wrap act-fchips">
          {chips.map((c) => (
            <FilterChip key={c.id} on={c.on} clears={false}
              onClick={() => { track(`action:activity.filter.${c.id}`); setFocus(null); setFilter(c.id); }}>
              {c.text}
            </FilterChip>
          ))}
        </div>
      ) : null}
      {none ? <div className="act-none">{none}</div> : null}
      {/* The triage toggles. Every one of them HIDES or REORDERS rows, so each stays lit while
          it is on — a screen whose job is to prove nothing was lost may not hide rows quietly.
          The two with a catalog hint carry it on a wrapper: the chip's own button has no
          `data-hint`, and long press finds the nearest one. */}
      <div className="fchips wrap act-toggles">
        <FilterChip on={selecting} title={selecting ? "leave selection mode" : "select rows — deal with many at once"}
          onClick={() => { track("action:activity.select"); setSelecting((v) => !v); if (selecting) setSelected(new Set<string>()); }}>
          select
        </FilterChip>
        <span className="act-hint" data-hint="activity.group" title={grouped ? "show every copy separately" : "collapse rows that say the same thing"}>
          <FilterChip on={grouped} onClick={() => { track("action:activity.group"); setGrouped((v) => !v); }}>grouped</FilterChip>
        </span>
        <FilterChip on={sort === "oldest"}
          title={sort === "oldest" ? "back to attention order — what needs you first" : "oldest first — the ones that have been waiting longest"}
          onClick={() => { track("action:activity.sort"); setSort((v) => (v === "oldest" ? "ranked" : "oldest")); }}>
          oldest first
        </FilterChip>
        {/* Off by default, and it names its count: a filter that removes rows from the screen
            you opened to find a lost prompt has to be a deliberate tap, and it has to say how
            much it takes away. With nothing reading as chatter it is not drawn at all — never
            a greyed chip — unless it is on, where it stays so it can be turned off. */}
        {debrisCount > 0 || hideDebris ? (
          <span className="act-hint" data-hint="activity.debris"
            title="hide one-word replies — “continue please”, “done?”, a bare /cost. Nothing is deleted.">
            <FilterChip on={hideDebris} onClick={() => { track("action:activity.debris"); setHideDebris((v) => !v); }}>
              {debrisCount ? chipText("hide chatter", { count: debrisCount }) : "hide chatter"}
            </FilterChip>
          </span>
        ) : null}
      </div>
    </>
  );
}
