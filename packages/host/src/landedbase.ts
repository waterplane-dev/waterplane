import { execFileP } from "./proc.js";

/**
 * THE one owner of "the base this branch is measured against" when the question is local and must
 * stay fast and offline-safe (the pre-close check, the review diff, a leftover worktree's unlanded
 * count). It was guessed three times — `main` then `master` in two places in git.ts, the primary
 * checkout's branch in worktreeleftover.ts — and the guesses disagreed: a repo whose default is
 * `develop` or `trunk` had NO base, so closing a session with unlanded commits warned about nothing.
 *
 * Not the push rule. prpush.ts `defaultBranch` asks the forge first and may refuse a push; this
 * never asks a network and never refuses anything, it only says what a count is measured against.
 *
 * ORDER (first that names a branch that exists here):
 *  1. `origin-head` — `refs/remotes/origin/HEAD`, what a clone recorded as the remote's default.
 *     A clone-time cache `git fetch` never refreshes (see prpush.ts), so it only counts when the
 *     branch it names still exists; the local branch of that name, else `origin/<name>`.
 *  2. `main`, then `master` — the local branch of that name.
 *  3. `primary` — the branch the repo's main checkout is on. Last, not first: a primary checkout
 *     can sit on a feature branch, and measuring a branch against itself reads as "nothing unmerged".
 * None of them: `base` is null and the caller must say "unknown", never "0".
 */
export type BaseSource = "origin-head" | "main" | "master" | "primary";
export interface LandedBase {
  /** The branch as a person names it (`develop`, `origin/develop`); null = none found. */
  base: string | null;
  /** The full ref to hand to git. */
  ref: string | null;
  source: BaseSource | null;
}

const run = (wt: string, args: string[]) => execFileP("git", args, { cwd: wt, timeout: 15_000, maxBuffer: 16 * 1024 * 1024 }).then((r) => r.stdout);
const has = (wt: string, ref: string) => run(wt, ["rev-parse", "--verify", "--quiet", ref]).then(() => true, () => false);

/** The branch the repo's first (main) worktree is on, null when detached or unreadable. */
export async function primaryBranch(wt: string): Promise<{ path: string; branch: string | null }> {
  const out = await run(wt, ["worktree", "list", "--porcelain"]);
  const first = out.split("\n\n")[0] ?? "";
  const path = /^worktree (.+)$/m.exec(first)?.[1]?.trim() ?? "";
  const branch = /^branch refs\/heads\/(.+)$/m.exec(first)?.[1]?.trim() ?? null;
  return { path, branch };
}

export async function landedBase(wt: string): Promise<LandedBase> {
  const none: LandedBase = { base: null, ref: null, source: null };
  const head = await run(wt, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]).then((s) => s.trim().replace(/^origin\//, ""), () => "");
  if (head) {
    if (await has(wt, `refs/heads/${head}`)) return { base: head, ref: `refs/heads/${head}`, source: "origin-head" };
    if (await has(wt, `refs/remotes/origin/${head}`)) return { base: `origin/${head}`, ref: `refs/remotes/origin/${head}`, source: "origin-head" };
  }
  for (const name of ["main", "master"] as const) {
    if (await has(wt, `refs/heads/${name}`)) return { base: name, ref: `refs/heads/${name}`, source: name };
  }
  const primary = await primaryBranch(wt).catch(() => ({ path: "", branch: null }));
  if (primary.branch && await has(wt, `refs/heads/${primary.branch}`)) {
    return { base: primary.branch, ref: `refs/heads/${primary.branch}`, source: "primary" };
  }
  return none;
}

/** Commits on HEAD that `ref` does not reach, by SHA. null = git could not read it. */
export async function commitsAhead(wt: string, ref: string): Promise<number | null> {
  try {
    const n = Number((await run(wt, ["rev-list", "--count", "HEAD", "--not", ref])).trim());
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/**
 * Commits on HEAD whose patch is not on `ref` — `git cherry`, so a cherry-picked commit (new SHA,
 * same patch) is landed. null = git could not read it (a missing object, a locked repo): the
 * caller says "unknown"; a failed read is never a 0.
 */
export async function unlandedCount(wt: string, ref: string): Promise<number | null> {
  const ahead = await commitsAhead(wt, ref);
  if (ahead === null) return null;
  if (ahead === 0) return 0;
  try {
    return (await run(wt, ["cherry", ref, "HEAD"])).split("\n").filter((l) => l.startsWith("+")).length;
  } catch {
    return null;
  }
}
