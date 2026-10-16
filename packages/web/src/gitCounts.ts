import type { RepoTarget } from "@waterplane/shared";

/**
 * What a repo's git button says: files changed, commits out (↑) and in (↓)
 * against the upstream. The git view's own `↑N ↓M` spelling, so the button and
 * the sheet it opens read the same.
 *
 * `ahead`/`behind` are ABSENT for a branch with no upstream — nothing is drawn
 * for them then, never a 0.
 */
type GitCounted = Pick<RepoTarget, "changedCount" | "ahead" | "behind" | "hasOrigin">;

/** Local only: the host looked and found no `origin`. Absent (not known) is NOT this. */
export function noOrigin(r: GitCounted): boolean {
  return r.hasOrigin === false;
}

/** Anything worth a badge: uncommitted files, or commits to push or pull. */
export function gitPending(r: GitCounted): boolean {
  return r.changedCount > 0 || (r.ahead ?? 0) > 0 || (r.behind ?? 0) > 0;
}

/** `↑15 ↓2`, only the nonzero halves; "" when in sync or no upstream. */
export function gitSyncText(r: GitCounted): string {
  const parts: string[] = [];
  if ((r.ahead ?? 0) > 0) parts.push(`↑${r.ahead}`);
  if ((r.behind ?? 0) > 0) parts.push(`↓${r.behind}`);
  return parts.join(" ");
}

/** The button's title — every count in words. */
export function gitTitle(r: GitCounted): string {
  const parts: string[] = [];
  if (r.changedCount > 0) parts.push(`${r.changedCount} changed file${r.changedCount > 1 ? "s" : ""}`);
  if ((r.ahead ?? 0) > 0) parts.push(`${r.ahead} commit${r.ahead! > 1 ? "s" : ""} to push`);
  if ((r.behind ?? 0) > 0) parts.push(`${r.behind} commit${r.behind! > 1 ? "s" : ""} to pull`);
  if (noOrigin(r)) parts.push("no origin remote, nothing to push to");
  return `${parts.length ? parts.join(", ") : "nothing pending"} — open git`;
}
