/** Which repos the keyboard repo question lists for a filter (`AskRepo.tsx`). Pure. */
import type { RepoTarget } from "@waterplane/shared";

/**
 * The rows `AskRepo.tsx` lists for a filter. An empty filter lists the primaries — thirty
 * worktrees under eleven repos is a list nobody arrows through — and a typed
 * one searches everything, worktrees included, so a parallel checkout is still
 * one word away. Name prefix, then name substring, then branch; primaries
 * before worktrees within each; otherwise the order the host listed them in.
 */
export function askRepoRows(repos: readonly RepoTarget[], query: string): RepoTarget[] {
  const q = query.trim().toLowerCase();
  if (!q) return repos.filter((r) => r.isPrimary);
  const score = (r: RepoTarget): number => {
    const name = r.repoName.toLowerCase();
    const branch = (r.branch ?? "").toLowerCase();
    const rank = name.startsWith(q) ? 0 : name.includes(q) ? 1 : branch.includes(q) ? 2 : -1;
    return rank < 0 ? -1 : rank * 2 + (r.isPrimary ? 0 : 1);
  };
  return repos
    .map((r, i) => ({ r, i, s: score(r) }))
    .filter((x) => x.s >= 0)
    .sort((a, b) => a.s - b.s || a.i - b.i)
    .map((x) => x.r);
}
