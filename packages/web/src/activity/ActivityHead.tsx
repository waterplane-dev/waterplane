import { ArrowDownWideNarrow, Copy, EyeOff, SquareCheck } from "lucide-react";
import { ACTIVITY_FILTERS } from "../activityRows";
import { track } from "../usage";
import type { ActivityModel } from "./useActivityModel";

/** The chip row and the triage strip, drawn in the sheet's fixed head. */
export function ActivityHead({ m }: { m: ActivityModel }) {
  const { filter, setFocus, setFilter, counts, selecting, setSelecting, setSelected, grouped, setGrouped, sort, setSort, debrisCount, hideDebris, setHideDebris } = m;
  return (
    <>
        <div className="act-filters">
          {ACTIVITY_FILTERS.map((f) => (
            <button key={f.id} className={`key${filter === f.id ? " active" : ""}`}
              // A chip reading 0 is still drawn. On this screen the absence of
              // failures is a fact worth stating, and a chip that disappears
              // when its count empties makes the list look like it lost rows.
              // A chip is a statement about the whole list, so tapping one drops
              // the caller's shortlist rather than intersecting with it — two
              // filters at once is the state nobody can read off this header.
              onClick={() => { track(`action:activity.filter.${f.id}`); setFocus(null); setFilter(f.id); }}>
              {f.label} <span className="act-count">{counts[f.id]}</span>
            </button>
          ))}
        </div>
        {/* The triage strip. Four controls, and every one of them says what it
            is doing to the list while it is on — a screen whose job is to prove
            nothing was lost may not hide rows quietly. */}
        <div className="act-triage">
          <button className={`key${selecting ? " active" : ""}`}
            title={selecting ? "leave selection mode" : "select rows — deal with many at once"}
            onClick={() => { track("action:activity.select"); setSelecting((v) => !v); if (selecting) setSelected(new Set<string>()); }}>
            <SquareCheck size={14} /> select
          </button>
          <button className={`key${grouped ? " active" : ""}`} data-hint="activity.group"
            title={grouped ? "show every copy separately" : "collapse rows that say the same thing"}
            onClick={() => { track("action:activity.group"); setGrouped((v) => !v); }}>
            <Copy size={14} /> grouped
          </button>
          <button className={`key${sort === "oldest" ? " active" : ""}`}
            title={sort === "oldest" ? "back to attention order — what needs you first" : "oldest first — the ones that have been waiting longest"}
            onClick={() => { track("action:activity.sort"); setSort((v) => (v === "oldest" ? "ranked" : "oldest")); }}>
            <ArrowDownWideNarrow size={14} /> oldest
          </button>
          {/* Off by default, and it names its own count: a filter that removes
              rows from the screen you opened to find a lost prompt has to be a
              deliberate tap, and it has to say how much it took away. */}
          <button className={`key${hideDebris ? " active" : ""}`} data-hint="activity.debris"
            disabled={!debrisCount && !hideDebris}
            title={debrisCount
              ? "hide one-word replies — “continue please”, “done?”, a bare /cost. They are still under this button, and nothing is deleted."
              : "nothing here reads as a one-word reply"}
            onClick={() => { track("action:activity.debris"); setHideDebris((v) => !v); }}>
            <EyeOff size={14} /> chatter {debrisCount ? <span className="act-count">{debrisCount}</span> : null}
          </button>
        </div>
    </>
  );
}
