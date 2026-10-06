/**
 * The one thing this feature sends: `session.budget.set`, and the toast that
 * is its receipt. Live-only — the frame is idempotent and not durable (the host
 * answers with the ordinary `session.updated`, and the sheet says "set" only
 * when that comes back carrying the cap — see `budgetConfirmed`), so a budget set offline is
 * refused in words rather than queued: a cap that reached the desktop an hour
 * late would hold or release a session on a decision nobody is looking at.
 */
import { sessionBudgetLabel, type SessionBudget } from "@waterplane/shared";
import { core } from "../../sdk";
import { BUDGET_ASKED_CLEAR_TOAST, BUDGET_OFFLINE_TOAST, budgetAskedToast } from "./logic";

export { openSessionBudget, closeSessionBudget } from "../../sessionBudgetDoor";

/** Set (or, with null, clear) a session's own budget. */
export function setSessionBudget(sid: string, budget: SessionBudget | null): boolean {
  const c = core();
  c.say.track(budget ? "action:sessionBudget.set" : "action:sessionBudget.clear");
  return c.conn.liveSend(
    { t: "session.budget.set", id: sid, budget },
    budget ? budgetAskedToast(sessionBudgetLabel(budget)) : BUDGET_ASKED_CLEAR_TOAST,
    BUDGET_OFFLINE_TOAST,
  );
}
