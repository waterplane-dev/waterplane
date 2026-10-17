/**
 * The build feature's sentences and its one lookup, pure so they can be pinned
 * without a DOM or a socket (`logic.test.mjs`).
 *
 * Every string here was an inline literal in `App.tsx`, some of them twice
 * (the sheet's Run and the Activity/Send sheet's `shell` intent both queued a
 * `build.run` and toasted it) — one copy now, so the two taps cannot drift.
 */
import type { BuildConfig, BuildRun, RepoTarget } from "@waterplane/shared";

/** A build's queue lane: one per repo, so two builds of one repo queue behind
 *  each other instead of interleaving over the same output dir. */
export const buildLane = (repoDir: string): string => `build:${repoDir}`;

/** What the queue row is CALLED — the name the outbox shows for an hour. */
export const buildQueueTitle = (name: string): string => `build “${name}”`;

/**
 * The receipt for a tapped build. Both halves, not just the offline one: a
 * slow link made a tapped build look like a dead button for as long as it took
 * the host's first `build.run` frame to come back.
 */
export function buildQueuedToast(offline: boolean, name: string): string {
  return offline ? "queued — the build starts when the link is back" : `starting “${name}”…`;
}

/** A `build.run` push's toast: only a run that SETTLED says anything, and
 *  `null` means stay quiet (a `running` frame is not news). */
export function buildRunToast(run: Pick<BuildRun, "status" | "name">): string | null {
  if (run.status === "done") return `build “${run.name}” done`;
  if (run.status === "failed") return `build “${run.name}” failed`;
  return null;
}

/** A build's display name by id in a repo's cached list; the id itself when
 *  the list does not have it (never an empty string). */
export function buildNameIn(lists: ReadonlyMap<string, readonly BuildConfig[]>, cwd: string, id: string): string {
  return (lists.get(cwd) ?? []).find((b) => b.id === id)?.name ?? id;
}

/**
 * The build a repo's hammer spins for, or null. The live `build.run` frames
 * (broadcast to every tab) win; the host's `RepoTarget.buildRunning` covers a
 * run that started before this tab was listening, and stops counting the
 * moment a frame for that same run has been seen — a settled frame beats a
 * repo list fetched before it.
 */
export function buildBusyIn(runs: readonly Pick<BuildRun, "runId" | "repoDir" | "status" | "name">[], repo: Pick<RepoTarget, "worktreePath" | "buildRunning">): { name: string } | null {
  const live = runs.find((r) => r.repoDir === repo.worktreePath && r.status === "running");
  if (live) return { name: live.name };
  const seed = repo.buildRunning;
  if (seed && !runs.some((r) => r.runId === seed.runId)) return { name: seed.name };
  return null;
}
