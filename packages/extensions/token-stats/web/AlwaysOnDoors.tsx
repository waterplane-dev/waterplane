/**
 * The all-sessions screen's two doors to what every turn carries (always-on context, D3).
 * It READS and LINKS only — a door opens a sheet that shows the figures; nothing here
 * measures, estimates or changes anything. No per-desktop average: repos differ, so a
 * mean would be a number with no object.
 */
import { BarChart3, ListChecks } from "lucide-react";
import { Button, Hint, Unavailable } from "@waterplane/kit";

export function AlwaysOnDoors({ hasSession, onSession, onRepo }: {
  /** Whether a session is attached: the context door shows THAT session's view. */
  hasSession: boolean;
  onSession: () => void;
  onRepo: () => void;
}) {
  return (
    <div>
      <div className="sheet-actions">
        {hasSession && <Button onClick={onSession}><BarChart3 size={14} /> Session context</Button>}
        <Button onClick={onRepo}><ListChecks size={14} /> Repo readings</Button>
      </div>
      {!hasSession && <Unavailable cants={[{ label: "Session context", reason: "open a session to see what its turns carry" }]} />}
      <Hint>What every turn carries is read per session (its context view) and per repo (Repo readings › set-up › Agent context weight).</Hint>
    </div>
  );
}
