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
 * The crossing's one Esc is OWED, not attempted once (`Session.budgetEscOwed`):
 * every judge while still over re-emits `budgetEscDue` until it goes out. The
 * one-shot version asked for a running turn at the crossing INSTANT and, finding
 * none there (the spend crossed between turns, after a limit resume, across a
 * daemon restart), left the next turn spending past the cap for good.
 *
 * A HARD budget (`cfg.hard`) owes the Esc again at every turn END while still
 * over (`turnEnded`), so each further turn gets one, not just the crossing's
 * turn. The one exception is a turn a person sent into by hand (on the phone
 * they were asked "send anyway?" first): `settleEsc` records a grant that runs
 * until that turn has ended (`Session.budgetGrantStop`), counted in `stopCount`
 * so a previous turn still closing out cannot spend it.
 *
 * What the crossing DOES — the notification, the one Esc — is
 * `server/sessionEvents.ts`'s, where the delivery facts are. This file decides
 * and types nothing.
 *
 * **Where the spend comes from** (P2, `budgetSparkOf` is the one reader on both
 * ends): a backend that keeps claude's log is judged off `contextSpark`, exactly
 * as before; any other backend off its OWN `TokenSource.session(s)`, read here on
 * every judge and published as `SessionInfo.sourceSpend` (with or without a
 * budget, so the phone's "spent so far" line has it before a cap is set). A
 * throw, a null or an answer `sourceSpendProblems` refuses is `{at}` with no
 * figure — `unstated`, never a zero — and a percent cap there is `notClaude`.
 * Both are `unknown`, so neither trips.
 */
import type { SessionBudget, SessionBudgetCal, SessionBudgetInfo, SessionInfo, SourceSessionSpend } from "@waterplane/shared";
import { budgetSparkOf, sessionBudgetVerdict, sourceSpendProblems } from "@waterplane/shared";
import { derive } from "../backends/index.js";
import { liveSourceFor } from "../livesources.js";
import type { Session, SessionCore } from "./core.js";

/** The figures of a reading, without its clock: a re-read that only moved `at`
 *  is not news (an `updated` fans the whole `SessionInfo` out). */
const figures = (r: SourceSessionSpend | undefined) => (r ? JSON.stringify({ ...r, at: 0 }) : "");

const isPctUnit = (b: SessionBudget) => b.unit === "sessionPct" || b.unit === "weeklyPct";

export class BudgetSlice {
  /** The latest calibration, or null when there is none yet (a percent budget
   *  then reads `unknown`/`noReading`, which never trips). */
  private cal: SessionBudgetCal | null = null;

  constructor(private readonly core: SessionCore) {}

  /** Re-read the source spend, then recompute one session's verdict. Returns
   *  whether `info.sourceSpend` or `info.budget` changed. */
  judge(s: Session, now = Date.now()): boolean {
    const spendMoved = this.readSourceSpend(s, now);
    const b = s.info.budget;
    if (!b) return spendMoved;
    const verdict = sessionBudgetVerdict(b.cfg, budgetSparkOf(s.info), this.cal, now, s.info.running);
    const next: SessionBudgetInfo = { cfg: b.cfg, verdict, ...(this.cal ? { cal: this.cal } : {}) };
    const changed = JSON.stringify(next) !== JSON.stringify(b);
    s.info.budget = next;
    if (verdict.state === "over" && !s.budgetTripped) {
      s.budgetTripped = true;
      s.budgetEscOwed = b.cfg.interrupt ? true : undefined;
      this.persist(s);
      this.core.emit("budgetTripped", s.info.id, s.info);
    } else if (verdict.state === "over" && s.budgetEscOwed) {
      this.core.emit("budgetEscDue", s.info.id, s.info);
    } else if (verdict.state === "ok" && s.budgetTripped) {
      s.budgetTripped = false;
      s.budgetEscOwed = undefined;
      this.persist(s);
    }
    return changed || spendMoved;
  }

  /**
   * `info.sourceSpend` off the backend's own `tokens.session` — only for a
   * backend that keeps no claude log (claude's three stay untouched: no field,
   * no call). No live source, no `session` slot, a throw, a null or a refused
   * answer ⇒ `{at: now}`: the host judges from the source, which stated
   * nothing. A re-read whose figures did not move keeps the old reading and
   * reports no change.
   */
  private readSourceSpend(s: Session, now: number): boolean {
    // No descriptor (a record from before backends) is claude's: today's path.
    if (!s.backend || derive(s.backend).keepsClaudeLog) return false;
    if (!s.backend.caps.turns) return false; // a shell has no source and spends nothing
    const live = liveSourceFor(s.info.id);
    const src = live?.sources.tokens;
    let r: SourceSessionSpend | null = null;
    if (live && typeof src?.session === "function") {
      try { r = src.session(live.session) ?? null; } catch { r = null; }
    }
    const next: SourceSessionSpend = r && !sourceSpendProblems(r).length ? r : { at: now };
    if (s.info.sourceSpend && figures(next) === figures(s.info.sourceSpend)) return false;
    s.info.sourceSpend = next;
    return true;
  }

  /** The owed Esc is settled — it went out, or a person sent to the session by
   *  hand and so chose to let it work past the cap. Re-armed only by a new
   *  crossing — or, under a HARD budget, a turn end (`turnEnded`). `byPerson`:
   *  a person's own send, which under a HARD budget also grants that one turn
   *  its run. */
  settleEsc(id: string, byPerson = false): void {
    const s = this.core.sessions.get(id);
    if (!s) return;
    // Hard: the person's turn runs, and only it. Its end is the next `stopCount`
    // — one later still if the previous turn's Stop is waiting to settle.
    if (byPerson && s.info.budget?.cfg.hard) s.budgetGrantStop = s.stopCount + (s.stopPending ? 2 : 1);
    if (!s.budgetEscOwed) return;
    s.budgetEscOwed = undefined;
    this.persist(s);
  }

  /** A turn ended (`turnEnded`, after `stopCount` moved). A HARD budget still
   *  over owes the next turn its Esc — unless a person's grant covers the turn
   *  that ends, which then expires here. Soft budgets: nothing, ever. */
  turnEnded(id: string): void {
    const s = this.core.sessions.get(id);
    const b = s?.info.budget;
    if (!s || !b?.cfg.hard) return;
    if (s.budgetGrantStop !== undefined) {
      if (s.stopCount < s.budgetGrantStop) return;
      s.budgetGrantStop = undefined;
      // The granted turn itself is over: the turn after it is owed, exactly as
      // any other — fall through.
    }
    if (b.verdict.state !== "over" || !s.budgetTripped || s.budgetEscOwed) return;
    s.budgetEscOwed = true;
    this.persist(s);
  }

  /**
   * Set, replace or (null) clear a session's budget — the facade's
   * `setSessionBudget`. Idempotent: the same cap again changes nothing and
   * keeps the latch. A different CAP — `unit` or `max` — starts a new account
   * (latch cleared), so raising one the session is still past is a new
   * crossing and says so. Flipping only `interrupt` or `hard` is not a new
   * cap: the crossing already happened and was already told, and clearing the latch
   * there would tell it twice — or send an Esc long after the crossing. Flipping
   * it OFF does drop an Esc still owed: that is exactly what the switch says.
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
      if (newCap || !cfg?.interrupt) s.budgetEscOwed = undefined;
      if (newCap || !cfg?.hard) s.budgetGrantStop = undefined;
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
