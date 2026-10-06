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
  DEFAULT_USAGE_BUDGET, budgetCeilings, budgetVerdict, cleanBudget,
  type BudgetCeiling, type BudgetVerdict, type UsageBudget, type UsageInfo } from "@waterplane/shared";
import { hostStateDir } from "./branddirs.js";
import { readJsonGuarded, writeJsonAtomic } from "./jsonstore.js";

export class BudgetStore {
  private path: string;
  private cfg: UsageBudget = { ...DEFAULT_USAGE_BUDGET };
  /** The last verdict we told clients about — so a tick only broadcasts on a
   *  real change, the same rule `backlog.waiting()` follows. */
  private lastKey = "";

  constructor(root: string, private readUsage: () => UsageInfo | null) {
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
    this.cfg = cleanBudget(next);
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
    return budgetVerdict(this.cfg, this.readUsage(), now);
  }

  /** Every ceiling over right now, session first — the per-window truth
   *  `verdict()` is the first line of, for the ladder's before-reset lift. */
  ceilings(now = Date.now()): BudgetCeiling[] {
    return budgetCeilings(this.cfg, this.readUsage(), now);
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
    const key = `${v.state}:${v.blocked}:${v.which ?? ""}:${v.pct ?? ""}:${v.max ?? ""}`;
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
