/**
 * What to do about a SPEND wall (`limit.ts`'s `spend`): an API-key / cloud
 * account whose credits ran out or whose workspace / organisation / gateway
 * spend limit was reached.
 *
 * A plan window has a reset the CLI prints and a ladder of probes that is worth
 * walking. A balance has neither: typing "continue" into it earlier changes
 * nothing, and the only instants worth believing are (1) one the message itself
 * printed in full and (2) the reset of a dollar CALENDAR period the person
 * configured (`shared/period.ts`'s `periodBounds`, the one reading of an edge).
 * With neither, there is no time to wait for and none is invented - the session
 * is held and `noteGaveUp` tells the person it needs them.
 *
 * The period's reset is a guess about WHICH limit was hit (a monthly cap, a
 * daily one), so there is exactly one attempt at it; if that is refused too the
 * answer is the same sentence to the person, not a second guess.
 */
import { periodBounds, type BudgetPeriod } from "@waterplane/shared";

type Source = () => readonly BudgetPeriod[];
let source: Source = () => [];

/** Wired once at boot with the budget's dollar periods (`main.ts`). */
export function setSpendPeriodSource(fn: Source): void { source = fn; }

/** The earliest upcoming reset among ACTIVE dollar calendar periods, or null. */
export function spendRetry(now: number): { resetAt: number | null };
export function spendRetry(now: number, resetAt: number | null, attempts: number, bufferMs: number):
  { kind: "at"; at: number } | { kind: "giveup"; why: string };
export function spendRetry(now: number, resetAt?: number | null, attempts?: number, bufferMs = 0): unknown {
  if (attempts === undefined) {
    let best: number | null = null;
    try {
      for (const p of source()) {
        if (p.kind !== "calendar" || p.unit !== "usd") continue;
        const b = periodBounds(p, now);
        if (b.active && b.resetAt != null && b.resetAt > now && (best == null || b.resetAt < best)) best = b.resetAt;
      }
    } catch { best = null; }
    return { resetAt: best };
  }
  if (attempts > 0) return { kind: "giveup", why: "spend limit still in force after the attempt at its reset - needs you" };
  if (resetAt == null) return { kind: "giveup", why: "spend limit with no known reset - needs you" };
  return { kind: "at", at: Math.max(now, resetAt + bufferMs) };
}
