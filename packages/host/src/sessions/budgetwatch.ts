/**
 * A session's OWN budget, judged (`shared/sessionbudget.ts` is the rule; this
 * is where the host applies it to a live session).
 *
 * A CLASS because it owns one piece of state: the latest calibration
 * (`host/src/sessionbudget.ts` computes it off a `/usage` reading and hands it
 * in through `setCal`). Everything else is on the session record: the cap and
 * its verdict on `info.budget` (the one copy, which is what reaches the phone),
 * the interrupt-once latch on `Session.budgetTripped`.
 *
 * Three callers judge: the end of `refreshSpark` (the spend moved, or the clock
 * did — a reading going stale is a change of verdict), `set` (a person changed
 * the cap), and `setCal` (a fresh calibration). **Only the crossing into `over`
 * is an event** (`budgetTripped`): re-judging a session that is still over
 * emits nothing, and the latch clears only on `ok` or a new cap — an `unknown`
 * in between (a reading gone stale for a while) is not a second crossing, so a
 * session is never told twice, or interrupted twice, for one overspend.
 *
 * What the crossing DOES — the notification, the one Esc — is
 * `server/sessionEvents.ts`'s, where the delivery facts are. This file decides
 * and types nothing.
 */
import type { SessionBudget, SessionBudgetCal, SessionBudgetInfo, SessionInfo } from "@waterplane/shared";
import { sessionBudgetVerdict } from "@waterplane/shared";
import type { Session, SessionCore } from "./core.js";

const isPctUnit = (b: SessionBudget) => b.unit === "sessionPct" || b.unit === "weeklyPct";

export class BudgetSlice {
  /** The latest calibration, or null when there is none yet (a percent budget
   *  then reads `unknown`/`noReading`, which never trips). */
  private cal: SessionBudgetCal | null = null;

  constructor(private readonly core: SessionCore) {}

  /** Recompute one session's verdict. Returns whether `info.budget` changed. */
  judge(s: Session, now = Date.now()): boolean {
    const b = s.info.budget;
    if (!b) return false;
    const verdict = sessionBudgetVerdict(b.cfg, s.info.contextSpark, this.cal, now, s.info.running);
    const next: SessionBudgetInfo = { cfg: b.cfg, verdict, ...(this.cal ? { cal: this.cal } : {}) };
    const changed = JSON.stringify(next) !== JSON.stringify(b);
    s.info.budget = next;
    if (verdict.state === "over" && !s.budgetTripped) {
      s.budgetTripped = true;
      this.persist(s);
      this.core.emit("budgetTripped", s.info.id, s.info);
    } else if (verdict.state === "ok" && s.budgetTripped) {
      s.budgetTripped = false;
      this.persist(s);
    }
    return changed;
  }

  /**
   * Set, replace or (null) clear a session's budget — the facade's
   * `setSessionBudget`. Idempotent: the same cap again changes nothing and
   * keeps the latch. A different CAP — `unit` or `max` — starts a new account
   * (latch cleared), so raising one the session is still past is a new
   * crossing and says so. Flipping only `interrupt` is not a new cap: the
   * crossing already happened and was already told, and clearing the latch
   * there would tell it twice — or send an Esc long after the crossing.
   * Always answers with the session as it now stands (`updated` is emitted).
   */
  set(id: string, cfg: SessionBudget | null): SessionInfo | null {
    const s = this.core.sessions.get(id);
    if (!s) return null;
    const prev = s.info.budget?.cfg ?? null;
    const same = JSON.stringify(prev) === JSON.stringify(cfg);
    if (!same) {
      const newCap = !prev || !cfg || prev.unit !== cfg.unit || prev.max !== cfg.max;
      if (cfg) s.info.budget = { cfg, verdict: sessionBudgetVerdict(cfg, null, null, Date.now()) };
      else delete s.info.budget;
      if (newCap) s.budgetTripped = undefined;
      this.persist(s);
    }
    this.judge(s);
    this.core.emit("updated", s.info);
    return s.info;
  }

  /** A fresh calibration: keep it and re-judge every budgeted session. */
  setCal(cal: SessionBudgetCal | null): void {
    this.cal = cal;
    for (const s of this.core.sessions.values()) {
      if (s.info.budget && this.judge(s)) this.core.emit("updated", s.info);
    }
  }

  /** Whether any running session has a budget in window percent — the usage
   *  poll's third reason to run, or the calibration would go stale under it. */
  wantsUsage(): boolean {
    for (const s of this.core.sessions.values()) if (s.info.running && s.info.budget && isPctUnit(s.info.budget.cfg)) return true;
    return false;
  }

  /** Rewrite the `live/` record; `persistLive` takes the budget off the
   *  session itself, so passing the record back is enough. */
  private persist(s: Session): void {
    const m = this.core.loadLive(s.info.id);
    if (m) this.core.persistLive(m);
  }
}
