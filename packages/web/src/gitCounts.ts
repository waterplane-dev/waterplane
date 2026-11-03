import type { GitBranch, GitStatus, RepoTarget } from "@waterplane/shared";
import { ago } from "./format.ts";

/**
 * What a repo's git button says: files changed, commits out (↑) and in (↓)
 * against the upstream. The git view's own `↑N ↓M` spelling, so the button and
 * the sheet it opens read the same.
 *
 * `ahead`/`behind` are ABSENT for a branch with no upstream — nothing is drawn
 * for them then, never a 0.
 */
type GitCounted = Pick<RepoTarget, "changedCount" | "ahead" | "behind" | "hasOrigin" | "fetchedAt">;

/**
 * How old a ↓ count may be before it is drawn as unknown rather than as a number. git counts
 * `behind` against the remote-tracking ref, which only a fetch moves: a repo nobody fetched for
 * four weeks read ↓0 while 30 commits waited (2026-11-03). A day, because the git sheet fetches
 * when it opens — a count older than that is one nobody has looked at since.
 */
export const BEHIND_STALE_MS = 24 * 60 * 60_000;

/**
 * What ↓ may claim, cut off `fetchedAt` and never off the count itself. `none` = no upstream,
 * nothing to count against. `fresh` = fetched within `BEHIND_STALE_MS`. `aged` = older (not "stale": that word is the send queue's delivery state, `core/queue/phase.ts`): a nonzero
 * count is still a FLOOR (those commits are at least there), a zero says nothing. `unchecked` =
 * never fetched from this worktree (or an older host that did not say).
 */
export type IncomingReading =
  | { kind: "none" }
  | { kind: "fresh" | "aged"; behind: number; checkedAt: number }
  | { kind: "unchecked"; behind: number };

export function incomingReading(r: Pick<GitCounted, "behind" | "fetchedAt">, now = Date.now()): IncomingReading {
  if (r.behind === undefined) return { kind: "none" };
  if (r.fetchedAt === undefined) return { kind: "unchecked", behind: r.behind };
  return { kind: now - r.fetchedAt > BEHIND_STALE_MS ? "aged" : "fresh", behind: r.behind, checkedAt: r.fetchedAt };
}

/** The figure after ↓: the count when current, a nonzero floor as is, and `?` where a stale or
 *  never-taken zero would pass for "in sync". null = no upstream, nothing drawn. */
export function behindLabel(inc: IncomingReading): string | null {
  if (inc.kind === "none") return null;
  return inc.kind === "fresh" || inc.behind > 0 ? String(inc.behind) : "?";
}

/** One sentence on how old ↓ is, under the git sheet's head. `up` is the upstream as drawn. */
export function incomingWords(inc: IncomingReading, up: string, now = Date.now()): string | null {
  switch (inc.kind) { // closed: IncomingReading is derived on the phone from `fetchedAt`, never sent by a host
    case "none": return null;
    case "fresh": return `↓ is as of the last check of ${up}, ${ago(inc.checkedAt, now)}.`;
    case "aged": return `${up} was last checked ${ago(inc.checkedAt, now)}, so ↓ is ${inc.behind > 0 ? "at least that" : "not known"} — Pull checks first.`;
    case "unchecked": return `${up} has never been checked from this worktree, so ↓ is not known — Pull checks first.`;
  }
}

/** Local only: the host looked and found no `origin`. Absent (not known) is NOT this. */
export function noOrigin(r: GitCounted): boolean {
  return r.hasOrigin === false;
}

/** Anything worth a badge: uncommitted files, or commits to push or pull. */
export function gitPending(r: GitCounted): boolean {
  return r.changedCount > 0 || (r.ahead ?? 0) > 0 || (r.behind ?? 0) > 0;
}

/** `↑15 ↓2`, only the nonzero halves; "" when in sync or no upstream. A stale nonzero ↓ is still
 *  drawn — it is a floor — and the title says how old it is; a stale zero draws nothing, as before,
 *  because nothing is what it knows. */
export function gitSyncText(r: GitCounted, now = Date.now()): string {
  const parts: string[] = [];
  if ((r.ahead ?? 0) > 0) parts.push(`↑${r.ahead}`);
  const inc = incomingReading(r, now);
  if (inc.kind !== "none" && inc.behind > 0) parts.push(`↓${inc.behind}`);
  return parts.join(" ");
}

/** The button's title — every count in words, and how old the ↓ half is when it is not current. */
export function gitTitle(r: GitCounted, now = Date.now()): string {
  const parts: string[] = [];
  if (r.changedCount > 0) parts.push(`${r.changedCount} changed file${r.changedCount > 1 ? "s" : ""}`);
  if ((r.ahead ?? 0) > 0) parts.push(`${r.ahead} commit${r.ahead! > 1 ? "s" : ""} to push`);
  const inc = incomingReading(r, now);
  if (inc.kind !== "none" && inc.behind > 0) parts.push(`${inc.behind} commit${inc.behind > 1 ? "s" : ""} to pull${inc.kind === "fresh" ? "" : " at least"}`);
  if (inc.kind === "aged") parts.push(`last checked against the remote ${ago(inc.checkedAt, now)}`);
  if (inc.kind === "unchecked") parts.push("never checked against the remote");
  if (noOrigin(r)) parts.push("no origin remote, nothing to push to");
  return `${parts.length ? parts.join(", ") : "nothing pending"} — open git`;
}

/**
 * The upstream the branch LIST prints for a row. For the CURRENT branch it is the status header's
 * verdict (host `branchHeader`), the one reading the sheet's head shows, so the row and the head
 * agree when status is the fresher read. Another branch, or no status for this one yet, keeps its
 * own listing — which reads a `[gone]` upstream as none through the same host helper
 * (`liveUpstream`, design round 5).
 */
export function branchUpstream(b: Pick<GitBranch, "name" | "current" | "upstream">, status: Pick<GitStatus, "branch" | "upstream"> | null | undefined): string | undefined {
  return b.current && status?.branch === b.name ? status.upstream : b.upstream;
}
