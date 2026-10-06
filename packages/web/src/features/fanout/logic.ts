/**
 * The fan-out sheet's pure half — no React, no DOM — so `logic.test.mjs` runs
 * it under `node --test`.
 */

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
