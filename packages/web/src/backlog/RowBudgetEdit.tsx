/**
 * A still-queued row's session budget (R-automation-044): the cap its session
 * will be born with, set, changed or cleared from the row. `BudgetField` is the
 * one budget input (the Send sheet's `budget…` row uses it too); this wraps it
 * with two explicit taps: a half-typed cap must never reach the desktop.
 *
 * Live-only like every backlog mutation: offline it is a sentence, not a
 * dimmed button. The draft is this component's own.
 */
import { useState, type ReactNode } from "react";
import { Wallet } from "lucide-react";
import type { SessionBudget } from "@waterplane/shared";
import { BudgetField } from "../BudgetField";
import { Button } from "../kit/Button";

const CAL_FOR = "A percent is converted from dollars at the window's measured rate once the session is running — until there is a fresh usage reading, nothing is held.";

export function RowBudgetEdit({ current, online, onSet, windowsOff }: {
  current: SessionBudget | undefined;
  windowsOff?: string | null; // `launchWindowsOff`
  online: boolean;
  onSet: (b: SessionBudget | null) => void;
}): ReactNode {
  const [draft, setDraft] = useState<SessionBudget | null>(current ?? null);
  if (!online) return <span className="bl-waiting">Changing the budget needs the desktop — the link is down.</span>;
  const same = !!draft && !!current && draft.unit === current.unit && draft.max === current.max && draft.interrupt === current.interrupt;
  return (
    <div className="bl-budget-edit">
      <BudgetField initial={current ?? null} onChange={setDraft} calFor={CAL_FOR} windowsOff={windowsOff} />
      <div className="bl-close-chips">
        {draft && !same && (
          <Button className="active" onClick={() => onSet(draft)}><Wallet size={13} /> {current ? "change budget" : "set budget"}</Button>
        )}
        {current && (
          <Button onClick={() => onSet(null)}><Wallet size={13} /> clear budget</Button>
        )}
      </div>
    </div>
  );
}
