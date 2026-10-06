/**
 * The pure half of the CLI-health feature: the "did it get worse?" ordering,
 * and what the topbar chip's count filters to. Type-only imports, so
 * `logic.test.mjs` runs it under plain node.
 */
import type { HealthRollup, HealthVerdict } from "@waterplane/shared";

/**
 * How bad a CLI-health rollup is, for the "did it get worse?" comparison only.
 *
 * `unknown` ranks with `healthy` and that is the rule the rollup already
 * encodes: several signals are exercised rarely, so treating "not observed
 * today" as a step down would fire an alarm every quiet morning. This is an
 * ORDERING, not a verdict — the verdict is `signalVerdict`'s, in `@waterplane/shared`,
 * and nothing here re-derives it.
 */
export const CLI_RANK: Record<HealthVerdict, number> = { healthy: 0, unknown: 0, degraded: 1, broken: 2 };
export const cliRank = (v: HealthVerdict): number => CLI_RANK[v] ?? 0;

/**
 * Is `next` a WORSENING of the last verdict this page saw? The first frame of a
 * page (`prev == null`) sets the baseline silently: a cold start onto an
 * already-degraded CLI is exactly what the chip is for. `unknown` never counts
 * as a worsening — a badge that goes grey whenever a rarely-exercised signal
 * has not fired today is a badge that is always grey.
 */
export function worsened(prev: HealthVerdict | null, next: HealthVerdict): boolean {
  return prev != null && cliRank(next) > cliRank(prev);
}

/** Does the topbar chip draw at all? `unknown` and `healthy` render NOTHING. */
export function chipShown(r: HealthRollup | null): r is HealthRollup {
  return !!r && (r.verdict === "degraded" || r.verdict === "broken");
}

/** The chip's count is a FILTER: the verdicts its tap opens, never the whole board. */
export function chipVerdicts(r: Pick<HealthRollup, "broken" | "degraded">): HealthVerdict[] {
  const verdicts: HealthVerdict[] = [];
  if (r.broken.length > 0) verdicts.push("broken");
  if (r.degraded.length > 0) verdicts.push("degraded");
  return verdicts;
}

/** "2 broken · 1 degraded" — the split the chip's `title`/`aria-label` carry. */
export function chipSplit(r: Pick<HealthRollup, "broken" | "degraded">): string {
  return [
    r.broken.length > 0 ? `${r.broken.length} broken` : "",
    r.degraded.length > 0 ? `${r.degraded.length} degraded` : "",
  ].filter(Boolean).join(" · ");
}
