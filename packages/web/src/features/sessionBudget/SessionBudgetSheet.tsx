/**
 * The budget sheet: set, change or clear ONE session's cap — tokens, dollars,
 * or a share of the 5-hour or weekly window — and read what it is doing now.
 *
 * Words come from `@waterplane/shared`; the field is `BudgetField` (the same
 * one the Send sheet and the launch ask draw), handed this session's spark so
 * it can say what has been spent and preview the typed cap against it.
 *
 * Layout is the Settings screen's: a scrolling body of `.set-group`s under a
 * fixed head, and the two verbs pinned in the footer. Nothing is greyed: with
 * no valid cap typed the set button is ABSENT and a sentence stands where it
 * would be; clear is a `ConfirmButton`. "Set" is said only when the desktop
 * answers with the cap (`budgetConfirmed`) — the send itself only ASKS.
 */
import { useEffect, useState } from "react";
import { Wallet } from "lucide-react";
import { budgetSparkOf, sessionBudgetLabel, type SessionBudget, type SessionInfo } from "@waterplane/shared";
import { Sheet } from "../../Sheet";
import { ConfirmButton } from "../../Confirm";
import { BudgetField } from "../../BudgetField";
import { useNow } from "../../useNow";
import { core } from "../../sdk";
import { closeSessionBudget, setSessionBudget } from "./actions";
import {
  BUDGET_CLEARED_TOAST, BUDGET_CONFIRM_MS, BUDGET_UNCONFIRMED, budgetConfirmed, budgetSetToast, budgetStateLine,
} from "./logic";
import { Button } from "../../kit";
import { SetNote } from "../../SettingsKit";

const CAL_LATER = "A percent is converted from dollars at the window's measured rate; the desktop sends that rate with a budget, so once one is set this line says what 1% is worth — until then nothing is held.";

export function SessionBudgetSheet({ subject, title, windowsOff, spendUnit }: {
  subject: SessionInfo;
  title: string;
  /** `budgetWindowsOff`'s sentence: this session's backend spends from no claude window. */
  windowsOff?: string | null;
  /** The backend's own spend unit (`caps.spendUnit`), offered as a unit. */
  spendUnit?: string;
}) {
  const now = useNow(30_000);
  const cur = subject.budget;
  const [draft, setDraft] = useState<SessionBudget | null>(cur?.cfg ?? null);
  // What was asked of the desktop and not yet seen back; `late` once it has
  // gone unanswered for `BUDGET_CONFIRM_MS`.
  const [asked, setAsked] = useState<{ cfg: SessionBudget | null } | null>(null);
  const [late, setLate] = useState(false);
  useEffect(() => {
    if (!asked) return;
    if (budgetConfirmed(asked.cfg, cur?.cfg)) {
      core().say.toast(asked.cfg ? budgetSetToast(sessionBudgetLabel(asked.cfg)) : BUDGET_CLEARED_TOAST);
      setAsked(null); setLate(false);
      return;
    }
    const t = window.setTimeout(() => setLate(true), BUDGET_CONFIRM_MS);
    return () => window.clearTimeout(t);
  }, [asked, cur]);
  const ask = (cfg: SessionBudget | null) => {
    if (setSessionBudget(subject.id, cfg)) { setAsked({ cfg }); setLate(false); }
  };
  // What is typed already equals what is set: saying "set" would do nothing.
  const same = !!draft && !!cur && budgetConfirmed(draft, cur.cfg);
  const footer = (
    <>
      {cur && (
        <ConfirmButton className="key budget-clear" confirm="clear it — sure?" onConfirm={() => ask(null)}>clear budget</ConfirmButton>
      )}
      {draft && !same ? (
        <Button variant="primary" className="budget-set" onClick={() => ask(draft)}>
          <Wallet size={14} /> {cur ? "change to" : "set budget"} {sessionBudgetLabel(draft)}
        </Button>
      ) : (
        <span className="budget-why">
          {same ? "This is the budget already set — change the cap above to replace it."
            : cur ? "Type a new cap above to change it." : "Type a cap or pick one above to set a budget."}
        </span>
      )}
    </>
  );
  return (
    <Sheet title="Session budget" icon={<Wallet size={18} />} onClose={closeSessionBudget} footer={footer}>
      <div className="sheet-scroll">
        <div className="set-group">
          <div className="budget-who">{title}</div>
          <div className="ctx-cost budget-now">
            <div className="ctx-cost-head"><Wallet size={14} /><span>{cur ? `budget ${sessionBudgetLabel(cur.cfg)}` : "no budget"}</span></div>
            {/* No budget: the head already says "no budget", and the line said it again. */}
            {cur && <div className="ctx-cost-note">{budgetStateLine(cur, now)}</div>}
          </div>
          {asked && late && <SetNote className="warn">{BUDGET_UNCONFIRMED}</SetNote>}
          <SetNote>
            What this one conversation may spend, its subagents included. At the cap its sends are held
            and you are told; raising or clearing the budget lets them go.
          </SetNote>
        </div>
        <div className="set-group">
          {/* Keyed by session: switching subject restarts the field on ITS cap. */}
          <BudgetField key={subject.id} initial={cur?.cfg ?? null} cal={cur ? cur.cal ?? null : undefined} onChange={setDraft}
            spark={budgetSparkOf(subject)} calFor={cur ? undefined : CAL_LATER} windowsOff={windowsOff} spendUnit={spendUnit} />
        </div>
      </div>
    </Sheet>
  );
}
