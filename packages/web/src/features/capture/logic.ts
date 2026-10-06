/**
 * The capture feature's sentences, pure so they can be pinned without a DOM or
 * a socket (`logic.test.mjs`). Every one was an inline literal in `App.tsx`.
 */
import type { CaptureRun, CaptureTarget } from "@waterplane/shared";

/** A capture's queue lane: the repo's, because the lease a capture takes (a
 *  browser, a simulator, the desktop's screen) is one per repo, whether it is
 *  a one-shot or a watch. */
export const captureLane = (repoDir: string): string => `capture:${repoDir}`;

/** What the queue row is CALLED. A watch says it is one — it keeps going. */
export const captureQueueTitle = (name: string, watch: boolean): string =>
  watch ? `watch “${name}”` : `capture “${name}”`;

/**
 * The receipt for a tapped capture. Both halves, not just the offline one: on a
 * slow link a tapped capture looked like a dead button until the host's first
 * `capture.run` frame came back. A watch says what it will keep doing, because
 * the thing you have to remember is that it is still going and yours to stop.
 */
export function captureQueuedToast(offline: boolean, watch: boolean, name: string): string {
  if (offline) return watch ? "queued — the watch starts when the link is back" : "queued — the capture runs when the link is back";
  return watch ? `watching “${name}” — a frame is kept each time the screen changes` : `capturing “${name}”…`;
}

/**
 * A `capture.run` push's toast. The VERDICT is the point of a capture, so the
 * toast carries it — whole and verbatim, the host's one wording, never
 * re-derived or cut at its separator here. A finished run with no verdict yet
 * says only that it finished, rather than inventing one. `null`: stay quiet.
 */
export function captureRunToast(run: Pick<CaptureRun, "status" | "name" | "verdict">): string | null {
  if (run.status === "done") return run.verdict ? `“${run.name}” — ${run.verdict}` : `capture “${run.name}” done`;
  if (run.status === "failed") return run.verdict ? `“${run.name}” failed — ${run.verdict}` : `capture “${run.name}” failed`;
  return null;
}

/** A target's display name by id in a repo's cached list; the id when absent. */
export function captureNameIn(lists: ReadonlyMap<string, readonly CaptureTarget[]>, dir: string, id: string): string {
  return (lists.get(dir) ?? []).find((t) => t.id === id)?.name ?? id;
}
