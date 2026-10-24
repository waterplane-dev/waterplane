/**
 * An open backlog row's "Flag for follow up when done" (R-sessions-043) — the
 * tick under its close-when-done choice, sent as `backlog.update` (live-only,
 * like that choice). Off unless ticked; drawn only while online, where the
 * close choice beside it already says the link is down.
 */
import type { ReactNode } from "react";
import { Flag } from "lucide-react";
import { Button } from "../kit/Button";

export function RowFlagChoice({ on, onSet }: { on: boolean; onSet: (on: boolean) => void }): ReactNode {
  return (
    <div className="bl-close-chips">
      <Button className={on ? "active" : undefined} aria-pressed={on} data-hint="session.followup" onClick={() => onSet(!on)}>
        <Flag size={13} fill={on ? "currentColor" : "none"} /> Flag for follow up when done
      </Button>
    </div>
  );
}
