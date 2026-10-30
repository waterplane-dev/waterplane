/**
 * The billing profile and the dollar periods, wired - `main.ts`'s pieces of the
 * account model (`billing.ts`, `periodspend.ts`, `burnwatch.ts`'s pace push).
 *
 * `createBillingWire(ctx)`: the profile store (probed once at boot, override on
 * disk), the period-to-date dollars the budget judges `usd` ceilings against, and
 * the "$ vs pace" push for an account with no weekly window. A factory over
 * `ServerCtx`: every `ctx.<x>` is read at CALL time (the budget, the usage
 * poll switch and `publishBudget` are assigned after this runs), and nothing
 * starts at import - the fold's timer runs only while a dollar period exists.
 */
import { hasScrapedWindows, type BudgetPeriod, type BudgetSpend, type BudgetSpendWhy } from "@waterplane/shared";
import { BillingStore, runAuthStatus } from "../billing.js";
import { createPaceWatch } from "../burnwatch.js";
import { hostStateDir } from "../branddirs.js";
import { claudeBackend } from "../backends/index.js";
import { costMeta } from "../costwindow.js";
import { PeriodSpend, SPEND_REFRESH_MS, foldAnswer } from "../periodspend.js";
import type { ServerCtx } from "./ctx.js";

export function createBillingWire(ctx: ServerCtx) {
  /** A change of answer re-syncs the `/usage` poll and tells every phone, budget included. */
  const billing = new BillingStore(ctx.ROOT, {
    authStatus: () => runAuthStatus(claudeBackend.bin()),
    onChange: (s) => { ctx.broadcast({ t: "billing.status", ...s }); ctx.syncUsagePolling(); ctx.publishBudget(true); },
  });
  /** List price, this desktop: the local ledger folded over each dollar period (`periodspend.ts`). */
  const periodSpend = new PeriodSpend({
    periods: (): BudgetPeriod[] => ctx.budget.usdPeriods(),
    fold: async (from, to) => {
      const doc = await ctx.tokenStats.costWindow(from, to, costMeta(ctx.sessions, ctx.intents), SPEND_REFRESH_MS);
      // A ledger never scanned folds to an empty (zero) document, and a stalled scan to an old one: "nobody measured", not $0.
      return foldAnswer(doc);
    },
  });
  const scraped = (): boolean => hasScrapedWindows(billing.status().profile);
  const paceWatch = createPaceWatch({
    stateDir: hostStateDir(ctx.ROOT), notify: (k, p) => ctx.notify(k, p),
    paces: (now) => scraped() ? [] : ctx.budget.periods(now).flatMap((s) => {
      const cap = ctx.budget.get().ceilings?.find((l) => l.periodId === s.period.id && l.unit === "usd");
      return cap && s.active ? [{ id: s.period.id, label: s.period.id, start: s.start, resetAt: s.resetAt, max: cap.max, spentUsd: s.spentUsd ?? null }] : [];
    }),
  });
  let timer: NodeJS.Timeout | null = null;
  return {
    billing,
    /** Tell clients the verdict (and the periods, when any), but only when it actually moved. */
    publishBudget(force = false): void {
      const v = ctx.budget.verdict();
      if (!ctx.budget.changed(v) && !force) return;
      const periods = ctx.budget.periods();
      ctx.broadcast({ t: "budget.state", budget: ctx.budget.get(), verdict: v, ...(periods.length ? { periods } : {}) });
    },
    /** Whether `session`/`weekly` mean anything here; `unknown` counts as yes (today's behaviour). */
    scraped,
    spend: (): BudgetSpend => periodSpend.get(),
    /** Why a dollar period has no figure, where the ledger said (`foldAnswer`). */
    spendWhy: (): BudgetSpendWhy => periodSpend.why(),
    /** Run the ledger fold only while a dollar period exists: once now, then every minute. */
    syncSpendFold(): void {
      if (ctx.DOCTOR || !ctx.budget.usdPeriods().length) {
        if (timer) clearInterval(timer);
        timer = null;
        return;
      }
      const tick = () => void periodSpend.refresh().then((moved) => { ctx.publishBudget(moved); paceWatch.check(); }, () => {});
      if (!timer) { timer = setInterval(tick, SPEND_REFRESH_MS); timer.unref?.(); }
      tick();
    },
  };
}
