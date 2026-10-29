/**
 * Where the git screen opens when something other than its own button opened
 * it — today only the "Explained · repo" notification, which lands on the
 * Explain view's answer rather than the Review sheet above it.
 *
 * A ONE-SHOT handed from the opener to `GitView`'s first render, so the nav
 * API (`openGit(repoId)`) needs no second argument: set right before the
 * open, taken (and cleared) by the view of that repo, ignored by any other.
 */
let pending: string | null = null;

/** The next git screen opened for `repoId` starts on its Explain view. */
export function landOnExplain(repoId: string): void { pending = repoId; }

/** True once, for the repo `landOnExplain` named. */
export function takeExplainLanding(repoId: string): boolean {
  const hit = pending === repoId;
  pending = null;
  return hit;
}
