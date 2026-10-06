/**
 * A session's OWN budget on the demo desktop — the host's `sessions/budgetwatch.ts`
 * and `routes/session.ts`'s `onSessionBudgetSet`, answered the same way.
 *
 * The rule is `@waterplane/shared`'s `sessionbudget.ts` and nothing is re-decided
 * here: the cap is cleaned by `cleanSessionBudget`, the verdict is
 * `sessionBudgetVerdict` over the session's own `contextSpark`, and the hold is
 * the PHONE's (`sessionBudgetHeld` → the queue's `budgetHeldLanes`), exactly as
 * against the real host, which never refuses a send for its budget either.
 *
 * The demo has no `/usage` calibration of its own, so a percent budget reads
 * `unknown`/`noReading` here — the host's own answer before its first reading,
 * and an unknown never holds anything.
 */
import { cleanSessionBudget, sessionBudgetText, sessionBudgetVerdict } from "@waterplane/shared";
import type { SessionInfo } from "@waterplane/shared";
import { mint } from "./model.ts";
import type { Desk } from "./model.ts";

/** The host's two refusals, word for word (`onSessionBudgetSet`). */
export const BUDGET_GARBAGE = "budget not set: it needs a unit and an amount above zero (a percent at most 100)";
export const BUDGET_NO_SESSION = "budget not set: that session is not open";

/**
 * Re-judge one session's budget against its spark. Returns true when the
 * session crossed INTO `over` just now — the one event the host tells (a
 * notification), latched so a session still over is never told twice; `ok` or
 * a new cap clears the latch, an `unknown` in between does not.
 */
export function judgeBudget(d: Desk, s: SessionInfo): boolean {
  const b = s.budget;
  if (!b) return false;
  const verdict = sessionBudgetVerdict(b.cfg, s.contextSpark, b.cal ?? null, d.now(), s.running);
  s.budget = { cfg: b.cfg, verdict, ...(b.cal ? { cal: b.cal } : {}) };
  const tripped = (d.m.budgetTripped ??= {});
  if (verdict.state === "over" && !tripped[s.id]) {
    tripped[s.id] = true;
    tellCrossing(d, s);
    return true;
  }
  if (verdict.state === "ok") delete tripped[s.id];
  return false;
}

/** `session.budget.set`: set, replace or (null) clear. Answered by `session.updated`,
 *  never a receipt — the message is not durable on the real host either. */
export function setBudget(d: Desk, id: string, raw: unknown): string | null {
  const cfg = raw === null ? null : cleanSessionBudget(raw);
  if (raw !== null && !cfg) return BUDGET_GARBAGE;
  const s = (d.m.sessions ?? []).find((x) => x.id === id);
  if (!s) return BUDGET_NO_SESSION;
  const prev = s.budget?.cfg ?? null;
  if (JSON.stringify(prev) !== JSON.stringify(cfg)) {
    const newCap = !prev || !cfg || prev.unit !== cfg.unit || prev.max !== cfg.max;
    if (cfg) s.budget = { cfg, verdict: sessionBudgetVerdict(cfg, null, null, d.now()) };
    else delete s.budget;
    if (newCap && d.m.budgetTripped) delete d.m.budgetTripped[id];
  }
  judgeBudget(d, s);
  d.broadcast({ t: "session.updated", session: s });
  return null;
}

/** The crossing, told the way `server/sessionEvents.ts` tells it. The demo
 *  writes no Esc: there is no running `claude` here to interrupt. */
function tellCrossing(d: Desk, s: SessionInfo): void {
  const b = s.budget;
  if (!b) return;
  const esc = b.cfg.interrupt
    ? "No Esc was sent: the demo has no running claude to interrupt."
    : "No Esc was sent: this budget is set not to interrupt.";
  const items = (d.m.notifications ??= []);
  items.unshift({
    id: mint(d.m, "n"), ts: d.now(), kind: "limit",
    title: `Session budget hit · ${s.title}`,
    body: `${sessionBudgetText(b.verdict)}. Further sends to it are held until you raise or clear the budget. ${esc}`,
    sessionId: s.id,
  });
  d.broadcast({ t: "notification.list", items });
}
