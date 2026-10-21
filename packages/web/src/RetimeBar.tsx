/**
 * **Re-time many at once — the bar.** One new instant for the rows a person
 * TICKED, one tap, one receipt. Drawn by the backlog (one repo's rows) and by
 * the Schedules directory (every repo's clocks), so it is one component: two
 * copies of "which button, which sentence, which refusal" drift within a week.
 *
 * It owns the time only. Which rows are ticked, and which rows may be ticked at
 * all, belong to the list that draws the boxes — the counts arrive here already
 * cut, and the button acts on exactly the `picked` it is told about.
 *
 * With nothing ticked or a time already gone the button is ABSENT and a
 * sentence stands where it would be — never a dimmed one (`Unavailable.tsx`).
 */
import type { ReactNode } from "react";
import { CalendarClock, Square, SquareCheck, X } from "lucide-react";
import { RETIME_NONE_PICKED, retimeNote } from "./backlogFilter";
import { track } from "./usage";
import { Button } from "./kit/Button";
import { Hint } from "./kit/Hint";

/**
 * The When editor for the ticked rows, drawn by the CALLER (App owns the Send
 * sheet's inputs — sessions, intents, usage). `onSent` after a re-time went,
 * `onCancel` when the sheet was closed without one: the ticks survive a cancel.
 */
export type RenderRetime = (ids: string[], done: { onSent: () => void; onCancel: () => void }) => ReactNode;

export function RetimeBar({ picked, eligible, shown, onAll, onNone, onDone, onChoose, where }: {
  /** How many ticked rows the button will send — ticked AND eligible AND on screen. */
  picked: number;
  /** How many rows on screen could be ticked. */
  eligible: number;
  /** How many rows are on screen. */
  shown: number;
  onAll: () => void;
  onNone: () => void;
  /** Close the pick list; nothing is changed. */
  onDone: () => void;
  /** Open the When editor for the ticked rows. */
  onChoose: () => void;
  /** Telemetry suffix: which list the tap came from. */
  where: string;
}) {
  return (
    <div className="form"><Hint>
      {retimeNote(picked, eligible, shown)}
      <div className="annot-tools wrap" style={{ marginTop: 6 }}>
        {picked > 0 ? (
          <Button title="choose the new when — a time, a usage window, a condition, a repeat — for the ticked rows"
            onClick={() => { track(`action:${where}.retime.choose`); onChoose(); }}>
            <CalendarClock size={14} /> {picked === 1 ? "new when for it…" : `new when for these ${picked}…`}
          </Button>
        ) : <span>{RETIME_NONE_PICKED}</span>}
        {picked < eligible && (
          <Button title="tick every row on screen that can be re-timed" onClick={onAll}>
            <SquareCheck size={14} /> all {eligible}
          </Button>
        )}
        {picked > 0 && (
          <Button title="untick every row" onClick={onNone}>
            <Square size={14} /> none
          </Button>
        )}
        <Button title="close the pick list — nothing is changed" onClick={onDone}>
          <X size={14} /> done
        </Button>
      </div>
    </Hint></div>
  );
}

/** Where the When editor is drawn: over the list, so the ticks and the filter
 *  underneath are still there when it closes without a re-time. */
export function RetimeLayer({ children }: { children: ReactNode }) {
  return <div className="retime-layer">{children}</div>;
}

/** The tick on a row. A real button with a phone-sized target (`.bl-pick`). */
export function PickBox({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <button className="bl-pick" aria-pressed={on}
      aria-label={on ? "untick this row" : "tick this row to re-time it"}
      onClick={(e) => { e.stopPropagation(); onToggle(); }}>
      {on ? <SquareCheck size={18} /> : <Square size={18} />}
    </button>
  );
}

/** Toggle one id in a set, immutably. */
export function toggled(prev: Set<string>, id: string): Set<string> {
  const next = new Set(prev);
  if (next.has(id)) next.delete(id); else next.add(id);
  return next;
}
