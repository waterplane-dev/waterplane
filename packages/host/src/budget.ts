/**
 * The usage budget, host-side: the stored ceiling plus the one place that asks
 * the rule.
 *
 * The rule itself is `@waterplane/shared`'s `budgetVerdict` — pure, unit-pinned, and
 * shared with the phone so the sentence on a queue row and the decision the
 * daemon made can never disagree. This half owns three things the rule cannot:
 * the file it is persisted in, the `UsageInfo` it is asked about, and the
 * broadcast that tells every client the verdict changed.
 *
 * Why the HOST owns it rather than the client's synced settings:
 *
 *   • The backlog auto-fires with no client attached at all. A gate that lived
 *     on the phone would be off precisely when it matters — overnight, with the
 *     tab closed, which is exactly when a backlog drains a whole session window
 *     into work nobody is reading.
 *   • The usage reading is scraped here (`usage.ts`) and nowhere else.
 *   • `settings.ts` deliberately stores opaque strings the daemon never parses;
 *     this is a number the daemon has to act on. Same reasoning as
 *     `notifyprefs.ts`, and the same shape of store.
 *
 * The client is still TOLD the verdict (`budget.state`), because a send queue
 * that silently declines to drain is the failure this app spent a lot of code
 * eliminating — see `SendBlockReason`. Knowing is not deciding: the phone holds
 * its own queue rows against the same verdict, and the host refuses anything
 * that gets past that anyway.
 */
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  BUILTIN_PERIODS, DEFAULT_USAGE_BUDGET, budgetCeilings, budgetLimits, budgetVerdict, cleanBudget, leftoverCeiling, periodStates, withLimit,
  type BudgetCeiling, type BudgetSpend, type BudgetVerdict, type KnownReset, type PeriodId, type PeriodState, type UsageBudget, type UsageInfo } from "@waterplane/shared";
import { hostStateDir } from "./branddirs.js";
import { readJsonGuarded, writeJsonAtomic } from "./jsonstore.js";

export class BudgetStore {
  private path: string;
  private cfg: UsageBudget = { ...DEFAULT_USAGE_BUDGET };
  /** The last verdict we told clients about — so a tick only broadcasts on a
   *  real change, the same rule `backlog.waiting()` follows. */
  private lastKey = "";

  /**
   * `spend` is the local ledger's period-to-date dollars (`periodspend.ts`) and
   * `scraped` says whether the `session`/`weekly` periods mean anything on this
   * account (`hasScrapedWindows`); both default to "nothing", which is exactly
   * the subscription-only behaviour that predates periods.
   */
  constructor(root: string, private readUsage: () => UsageInfo | null, private spend: () => BudgetSpend = () => ({}), private scraped: () => boolean = () => true) {
    const dir = hostStateDir(root);
    mkdirSync(dir, { recursive: true });
    this.path = join(dir, "budget.json");
    try {
      if (existsSync(this.path)) this.cfg = cleanBudget(readJsonGuarded<any>(this.path, null));
    } catch { /* corrupt or unreadable → defaults, never throw on boot */ }
  }

  get(): UsageBudget {
    return { ...this.cfg };
  }

  set(next: UsageBudget): UsageBudget {
    // A phone bundle from before `leftoverMax` sends a budget without it; that
    // is silence about the field, never a request to reset it to the default.
    const inc = next as Partial<UsageBudget>;
    let cfg = cleanBudget({ leftoverMax: this.cfg.leftoverMax, ...(inc.periods === undefined ? { periods: this.cfg.periods } : {}), ...inc });
    // The same silence rule for the dollar ceilings: a phone that predates periods
    // sends the two percents and no list, and that is not a request to drop a cap.
    if (inc.ceilings === undefined) {
      for (const l of budgetLimits(this.cfg)) if (l.unit === "usd" && cfg.periods?.some((p) => p.id === l.periodId)) cfg = withLimit(cfg, l);
    }
    this.cfg = cfg;
    this.save();
    return this.get();
  }

  /**
   * Should automatic work start right now?
   *
   * Asked fresh on every pass that would fire something — nothing is cached
   * beyond the usage reading itself, and nothing is armed with a timer. That is
   * what makes the reset resolve itself: the same call that blocked at 14:59
   * returns `blocked: false` at 15:01 because the clock moved, with no event
   * delivered and nobody awake to receive it.
   */
  verdict(now = Date.now()): BudgetVerdict {
    return budgetVerdict(this.cfg, this.readUsage(), now, this.spend());
  }

  /** Every ceiling over right now, session first — the per-window truth
   *  `verdict()` is the first line of, for the ladder's before-reset lift. */
  ceilings(now = Date.now()): BudgetCeiling[] {
    return budgetCeilings(this.cfg, this.readUsage(), now, this.spend());
  }

  /**
   * Each configured period and where it stands (`periodBounds`), with the
   * measured dollars where there are any. The built-in `session`/`weekly` ride
   * only on an account that has scraped windows. Empty on a subscription with
   * nothing configured, so the wire field is omitted and the phone is unchanged.
   */
  periods(now = Date.now()): PeriodState[] {
    const u = this.readUsage();
    const known: Record<PeriodId, KnownReset> = { session: { resetAt: u?.sessionResetAt }, weekly: { resetAt: u?.weeklyResetAt } };
    const list = [...(this.scraped() && this.cfg.periods?.length ? BUILTIN_PERIODS : []), ...(this.cfg.periods ?? [])];
    const spend = this.spend();
    return periodStates(list, now, known).map((s) => {
      const usd = spend[s.period.id];
      return typeof usd === "number" ? { ...s, spentUsd: usd } : s;
    });
  }

  /** Reset instants of every period that has an edge, for `window` schedule rules. */
  periodResets(now = Date.now()): Record<PeriodId, number | null> {
    const out: Record<PeriodId, number | null> = {};
    for (const s of this.periods(now)) out[s.period.id] = s.resetAt;
    return out;
  }

  /** The dollar periods worth measuring: every configured one that is in dollars. */
  usdPeriods() {
    return (this.cfg.periods ?? []).filter((p) => p.unit === "usd");
  }

  /** The leftover ceiling when it is tripped — what holds a row let past LAST
   *  week's budget that did not start before the reset (`leftoverCeiling`). */
  leftover(now = Date.now()): BudgetCeiling | null {
    return leftoverCeiling(this.cfg, this.readUsage(), now);
  }

  /**
   * Has the verdict changed since the last time this was asked?
   *
   * The gate is polled by the backlog tick and by every flush, and the state it
   * reports is a fact about right now — but re-broadcasting an unchanged verdict
   * several times a second would put a message on every socket for nothing. The
   * caller pushes only when this returns true.
   */
  changed(v: BudgetVerdict): boolean {
    const spend = this.spend();
    const usd = this.usdPeriods().map((p) => `${p.id}=${typeof spend[p.id] === "number" ? Math.round(spend[p.id]! * 100) : "-"}`).join(",");
    const key = `${v.state}:${v.blocked}:${v.which ?? ""}:${v.pct ?? ""}:${v.max ?? ""}:${usd}`;
    if (key === this.lastKey) return false;
    this.lastKey = key;
    return true;
  }

  private save(): void {
    try {
      writeJsonAtomic(this.path, this.cfg, { space: 2 });
    } catch { /* a lost preference is not worth taking the daemon down for */ }
  }
}
