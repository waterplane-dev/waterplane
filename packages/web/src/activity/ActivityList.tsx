import { ACTIVITY_FILTERS } from "../activityRows";
import { Group } from "./ActivityGroupCard";
import type { ActivityModel } from "./useActivityModel";
import type { ActivitySheetProps } from "./activitySheetTypes";

/** The rows themselves, grouped, or the sentence that says why there are none. */
export function ActivityList({ m, p }: { m: ActivityModel; p: ActivitySheetProps }) {
  const { shown, focus, rows, filter, counts, groups, now, selecting, selected, toggleRow, toggleGroup } = m;
  return (
      <div className="list act-list">
        {shown.length === 0 ? (
          <div className="form-hint">
            {focus
              ? `Nothing left of ${focus.label} — every one of them has moved on. They are under “all”.`
              : rows.length === 0
              ? "Nothing has been posted yet. Everything you send, queue, schedule, build or download shows up here and stays here until it is finished."
              : filter === "dismissed"
                ? "Nothing filed away yet. Rows you have read and dealt with land here — they keep their words and their buttons, and “bring back” returns them to the list."
                : `Nothing under “${ACTIVITY_FILTERS.find((f) => f.id === filter)?.label}”. ${counts.all} ${counts.all === 1 ? "row" : "rows"} under “all”${counts.dismissed ? `, ${counts.dismissed} filed away` : ""}.`}
          </div>
        ) : groups.map((g) => (
          <Group key={g.key} g={g} now={now} sessions={p.sessions} repos={p.repos}
            outbox={p.outbox} online={p.online} reviews={p.reviews} repoIdForCwd={p.repoIdForCwd}
            selecting={selecting} selected={selected} onToggleRow={toggleRow} onToggleGroup={toggleGroup}
            onAction={p.onAction} onRetarget={p.onRetarget} onOpenSession={p.onOpenSession} />
        ))}
      </div>
  );
}
