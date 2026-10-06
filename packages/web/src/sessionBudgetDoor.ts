/**
 * Whose budget sheet is open — and the one way to open it.
 *
 * Top-level because three callers that may not import a feature open this
 * sheet: the context sheet's panel (inside `features/context`, which may not
 * import `features/sessionBudget`), and the header chip and row chip (core,
 * which may). The sheet itself is `features/sessionBudget`'s; this is only the
 * subject and the door, written by nobody else.
 *
 * Null means "the attached session", like `ctxSid`; cleared on close, so the
 * sheet cannot re-open on a session you left.
 */
import { core, createStore } from "./sdk";
export const budgetSid = createStore<string | null>(null);

/** Open the budget sheet for a session id, or (null) the attached one. */
export function openSessionBudget(sid: string | null): void {
  const c = core();
  c.say.track("overlay:sessionBudget");
  budgetSid.set(sid);
  c.nav.open("sessionBudget");
}

export function closeSessionBudget(): void {
  budgetSid.set(null);
  core().nav.close("sessionBudget");
}
