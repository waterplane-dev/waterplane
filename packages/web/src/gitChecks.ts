/**
 * The outgoing list's pre-push verdicts: which verbs a commit gets, and the sentences. The host
 * judges nothing here and neither does this: the real push still runs the hook, so a verdict
 * decides what is OFFERED, never what is allowed.
 */
import type { GitCheck, GitLog } from "@waterplane/shared";

export interface CommitVerbs {
  /** Run the checks on this commit. */
  check: boolean;
  /** Push this commit and the older ones: how many that sends. Absent = not offered. */
  pushes?: number;
}

/**
 * `index` counts down the outgoing list, newest first. A hook that tests the working tree can
 * only speak for the newest commit, and judging an older one's push by it would test the commits
 * that push leaves out, so both verbs on an older commit need `testsCommit`.
 */
export function commitVerbs(log: Pick<GitLog, "prePush" | "outgoingTotal">, index: number, verdict?: GitCheck): CommitVerbs {
  const hook = log.prePush;
  if (!hook) return { check: false };
  const passed = verdict?.ok === true;
  return {
    check: !passed && (hook.testsCommit || index === 0),
    ...(passed && hook.testsCommit ? { pushes: log.outgoingTotal - index } : {}),
  };
}

export const verdictWords = (v: GitCheck, ago: string): string => `${v.ok ? "checks passed" : "checks failed"} ${ago}`;

/** Why an older commit has no verbs here, or null when it has them. */
export function checksHint(log: Pick<GitLog, "prePush" | "outgoingTotal">): string | null {
  if (!log.prePush || log.prePush.testsCommit || log.outgoingTotal < 2) return null;
  return "This repo's pre-push hook tests the working tree, not a chosen commit, so only the newest commit can be checked and the branch goes up whole.";
}
