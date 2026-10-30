/** Which repo the sheet shows: the cut's, then the session's, then the last
 *  used, then one that has items, then the first. `derived` is true only for
 *  the items-based pick — the one that moves when rows go, so the sheet pins
 *  it into the cut once instead of re-deriving it every render. */
export function scopedRepo(a: {
  repos: readonly { worktreePath: string }[];
  items: readonly { repoDir?: string | null; archived?: boolean }[];
  cutRepo: string | null | undefined;
  sessionRepo: string | null | undefined;
  saved: string | null | undefined;
}): { repoDir: string; derived: boolean } {
  const known = (d: string | null | undefined): d is string => !!d && a.repos.some((r) => r.worktreePath === d);
  if (known(a.cutRepo)) return { repoDir: a.cutRepo, derived: false };
  if (known(a.sessionRepo)) return { repoDir: a.sessionRepo, derived: false };
  if (known(a.saved)) return { repoDir: a.saved, derived: false };
  const withItems = a.items.find((it) => !it.archived && known(it.repoDir))?.repoDir;
  if (withItems) return { repoDir: withItems, derived: true };
  return { repoDir: a.repos[0]?.worktreePath ?? "", derived: false };
}
