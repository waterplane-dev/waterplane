/** The re-time banner and the past-the-budget verb. Split from `SendSheet.tsx` (docs/notes/send-architecture.md). */
import { Play } from "lucide-react";
import { ConfirmButton } from "../Confirm";
import { track } from "../usage";
import { pastBudgetConfirm, pastBudgetLabel, pastBudgetNote, retimeHeldWords } from "../sendIntent";
import type { SendSheetModel } from "./useSendSheet";

export function RetimeHint({ m }: { m: SendSheetModel }) {
  const {
    budgetHeld, onPastBudget,
  } = m;
  const retime = m.retime as NonNullable<typeof m.retime>;
  return (
    <div className="form-hint">
      A new <b>when</b> for the {retime.ids.length === 1 ? "row" : `${retime.ids.length} rows`} you ticked — each keeps its own words,
      where it goes and its place in its list. Only the when changes.
      {budgetHeld && budgetHeld.ids.length > 0 && (<>
        <div style={{ marginTop: 6 }}>{retimeHeldWords(budgetHeld.note, budgetHeld.resumeAt, budgetHeld.ids.length)}</div>
        {onPastBudget && (
          <div style={{ marginTop: 6 }}>
            {pastBudgetNote(budgetHeld.ids.length, retime.ids.length)}
            <div className="annot-tools wrap" style={{ marginTop: 6 }}>
              <ConfirmButton confirm={pastBudgetConfirm(budgetHeld.ids.length)} title={pastBudgetNote(budgetHeld.ids.length, retime.ids.length)}
                onConfirm={() => { track("action:send.retime.pastbudget"); onPastBudget(budgetHeld.ids); }}>
                <Play size={14} /> {pastBudgetLabel(budgetHeld.ids.length)}
              </ConfirmButton>
            </div>
          </div>
        )}
      </>)}
    </div>
  );
}
