/**
 * The fan-out sheet's pure half — no React, no DOM — so `logic.test.mjs` runs
 * it under `node --test`.
 */

import { fanoutHintText, fanoutTextKey, foldLaunches } from "@waterplane/shared";
import type { CostWindowDoc, FanoutRun } from "@waterplane/shared";

/** ONE fan-out lane, deliberately: two sweeps queued while offline must go
 *  out in the order they were fired, and a sweep spawns N real claude
 *  processes — running them concurrently on reconnect is a thundering herd. */
export const FANOUT_LANE = "fanout";

/** Per-run lane: a follow-up must land after the run it follows, and after
 *  any earlier follow-up in the same run. */
export function followUpLane(runId: string): string {
  return `fu:${runId}`;
}

export function fanoutToast(offline: boolean, repos: number): string {
  return offline ? "queued — the sweep runs when the link is back" : `fanning out to ${repos} repo${repos === 1 ? "" : "s"}`;
}

export function followUpToast(offline: boolean, sessions: number): string {
  return offline ? "queued — the follow-up goes out when the link is back" : `following up in ${sessions} session${sessions === 1 ? "" : "s"}`;
}

/** The sentence for one run, or null when its sessions are not in the doc or cost nothing. Pure.
 *  The doc's `rest` goes in too: a sweep's cheap targets are what the host's cap folds first, and
 *  a run total without them under-counts exactly the wide, cheap fan-out this hint is about. */
export function fanoutCostWords(doc: CostWindowDoc, run: FanoutRun, text: string): string | null {
  const row = foldLaunches(doc.convos, doc.rest).find((l) => l.key === run.id);
  if (!row || !(row.cost.total > 0)) return null;
  return fanoutHintText({
    same: fanoutTextKey(run.text) === fanoutTextKey(text),
    usd: row.cost.total,
    weekPct: null,
    agentPct: (row.agentCost.total / row.cost.total) * 100,
    repos: row.repos,
  });
}
