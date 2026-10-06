/**
 * Rung 2's two lifts: the before-reset pass (a row timed ahead of a reset
 * runs past THAT window's ceiling) and the person's waiver (`pastBudget`).
 * `budgetHold` is the rung's answer for one row; it is exported for
 * `verdict.ts` only, and the barrel does not re-export it.
 *
 * A slice of `../intent.ts`, which is the one door into the intent model —
 * import from there, never from here. Layout and import order:
 * docs/notes/shared-architecture.md.
 */

import type { ScheduleRule } from "../schedule.js";
import type { BudgetCeiling } from "../budget.js";
import { budgetHoldText, budgetOtherCapText, budgetPassPendingText } from "../budget.js";
import type { BudgetPass, BudgetWaiver } from "./types.js";
import type { Intent } from "./row.js";
import type { IntentFacts } from "./facts.js";

// ── The before-reset pass ────────────────────────────────────────────────────

/**
 * How far a ceiling's `resetAt` may sit from the reset a row was armed against
 * and still be THAT reset, inclusive.
 *
 * Measured, not guessed: `usagelog.jsonl` shows `sr`/`wr` flipping by EXACTLY
 * 60 000 ms between consecutive scrapes — the CLI's relative *resets in 1h 59m*
 * is read as now + that, truncated to the minute, so one reset lands on two
 * neighbouring minutes. `nextAt` is fixed from ONE reading at arm time and the
 * ceiling carries the LATEST, so a one-minute tolerance failed on alternate
 * ticks and the lift flickered. Five minutes absorbs that jitter with room to
 * spare, and cannot mistake one window for another: the nearest other reset is
 * hours (session) or days (weekly) away.
 */
export const RESET_MATCH_MS = 5 * 60_000;

/**
 * The pass an occurrence of this rule carries, or `null`. Only a `window` rule
 * on the `before` edge (absent = before, as `cleanRule` and `nextFireAt` read
 * it) with a NEGATIVE lead time: the occurrence is `reset + offset`, so the
 * reset it guards is `occurrence − offset`. `offsetMin` 0 fires AT the reset,
 * where the new window's ceiling is the one that applies; `after` fires into a
 * window that has just emptied.
 */
export function budgetPassAt(rule: ScheduleRule, occurrence: number): BudgetPass | null {
  if (rule.kind !== "window" || rule.edge === "after") return null;
  const off = (rule.offsetMin ?? 0) * 60_000;
  if (!(off < 0) || !Number.isFinite(occurrence)) return null;
  return { window: rule.window === "weekly" ? "weekly" : "session", from: occurrence, until: occurrence - off };
}

/** The pass this row carries: read off its own armed clock when it has one,
 *  else the stamp a recurring rule's child was minted with. */
export function budgetPassOf(i: Intent): BudgetPass | null {
  if (i.trigger.kind === "at") return typeof i.nextAt === "number" ? budgetPassAt(i.trigger.rule, i.nextAt) : null;
  return i.budgetPass ?? null;
}

/**
 * Rung 2's answer for one `auto` row while the budget is over: the sentence to
 * hold it with, or `null` for *every tripped ceiling is one this row is exempt
 * from right now*. `""` is "hold, nobody said which cap" — `wait` finishes it.
 */
export function budgetHold(i: Intent, facts: IntentFacts, now: number): string | null {
  // A person's waiver covers every cap, inside the window it was granted in.
  if (budgetWaived(i, now)) return null;
  // Nobody said which cap ⇒ hold exactly as before this existed.
  if (!facts.budgetOver?.length) return facts.budgetDetail ?? "";
  const pass = budgetPassOf(i);
  // The pass's own window, if its ceiling is tripped. Its reading must be the
  // reset the row was armed against — a reset that moved is another window, and
  // then nothing is lifted, not even the session cap a weekly pass covers.
  const own = pass ? facts.budgetOver.find((c) => c.which === pass.window) : undefined;
  const valid = pass != null && (!own || (own.resetAt != null && Math.abs(own.resetAt - pass.until) <= RESET_MATCH_MS));
  // Lifted from its time until the reset — whichever reading of the reset is
  // later, since the two may disagree by the scrape's minute of jitter.
  const end = valid ? Math.max(pass.until, own?.resetAt ?? pass.until) : 0;
  for (const c of facts.budgetOver) {
    // A WEEKLY pass covers the session ceiling too: the session cap saves
    // allowance for later in a week that ends at `until`, and within
    // [from, until) there is no later. A SESSION pass does not cover the weekly
    // cap — that one saves for the days after this session window resets.
    const covered = valid && (c.which === pass.window || (pass.window === "weekly" && c.which === "session"));
    if (covered && now >= pass.from && now < end) continue;
    if (covered && now < pass.from) return budgetPassPendingText(c, now, pass.window);
    // The other window's cap names the exemption it does NOT cover; the same
    // window past its reset (a new window, a new ceiling) is a plain hold.
    return pass && c.which !== pass.window && !covered ? budgetOtherCapText(c, pass.window, now) : budgetHoldText(c, now);
  }
  return null;
}

// ── The person's waiver ──────────────────────────────────────────────────────

/**
 * Is this row's waiver in force at `now`? The one reading of `pastBudget` —
 * rung 2, the `budget` trigger, the tick's expiry sweep, the smart pick's merge
 * rule and the phone's chip all ask this, so an expired waiver cannot read as
 * live in one of them.
 */
export function budgetWaived(i: { pastBudget?: BudgetWaiver }, now: number): boolean {
  return i.pastBudget != null && now < i.pastBudget.until;
}

/**
 * The `until` a waiver granted now gets: the LATEST known reset among the
 * ceilings tripped right now, so the waiver outlives every cap that holds the
 * row and no window after them. `null` when nothing is tripped or no tripped
 * ceiling says when it resets — there is then no window to scope it to, and
 * the host refuses the waiver in words rather than inventing one.
 */
export function budgetWaiverUntil(over: readonly BudgetCeiling[] | undefined, now: number): number | null {
  let until: number | null = null;
  for (const c of over ?? []) {
    if (c.resetAt != null && Number.isFinite(c.resetAt) && c.resetAt > now && (until == null || c.resetAt > until)) until = c.resetAt;
  }
  return until;
}

/** `Intent.pastBudget`, read strictly: one finite instant. Anything else —
 *  the legacy `true` of a waiver that had no window included — is DROPPED,
 *  never repaired: a waiver whose window nobody recorded cannot be scoped, and
 *  dropping it only makes the row wait for the budget again. */
export function cleanBudgetWaiver(v: unknown): BudgetWaiver | undefined {
  if (!v || typeof v !== "object") return undefined;
  const u = (v as Record<string, unknown>).until;
  return typeof u === "number" && Number.isFinite(u) ? { until: u } : undefined;
}
