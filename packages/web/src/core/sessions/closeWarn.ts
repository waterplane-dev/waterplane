/**
 * What a close would lose, from the host's `session.closecheck` — the pure half
 * of `useSessionVerbs.onCloseCheck`, so the wording is pinned without a host.
 *
 * `unmergedUnknown` is the host saying it could not count (no base branch
 * found, or git failed): that is said, never read as "nothing unmerged".
 *
 * No React — `closeWarn.test.mjs` under `node --test`.
 */
export type CloseGitFacts = {
  isRepo: boolean;
  dirty: boolean;
  unmerged: number;
  unmergedUnknown?: boolean;
  isMain: boolean;
  mainBranch: string;
};

/** The "• …" lines for the repo part of a close confirm; empty = nothing to lose. */
export function closeGitWarnings(msg: CloseGitFacts): string[] {
  const warn: string[] = [];
  if (!msg.isRepo) return warn;
  if (msg.dirty) warn.push("• uncommitted changes (no commit done)");
  if (!msg.isMain && msg.unmerged > 0)
    warn.push(`• ${msg.unmerged} commit(s) not merged to ${msg.mainBranch || "main"}`);
  else if (!msg.isMain && msg.unmergedUnknown)
    warn.push("• could not check for unmerged commits (no base branch found to compare with)");
  return warn;
}
