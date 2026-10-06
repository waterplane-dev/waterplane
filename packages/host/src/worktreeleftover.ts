import { readdirSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import type { SessionInfo, WorktreeLeftover } from "@waterplane/shared";
import { execFileP as pexec } from "./proc.js";

/**
 * A worktree nobody is using, and whether it can go.
 *
 * They pile up because the thing that made one is not around to remove it: an
 * orchestrating session runs `git worktree add` for a wave of agents and then
 * dies (a limit, a closed tab) before its cleanup step — measured here, five
 * `fix-*` worktrees at main's own commit, made a minute before their session's
 * last record. The launcher showed them as bare rows with no word on why.
 *
 * Removing one is only ever offered when NOTHING lives only there — see
 * `WorktreeLeftover`. The remove re-derives the whole check rather than trusting
 * the reading the phone looked at, and uses `git worktree remove` WITHOUT
 * `--force` and `git branch -d` where it can, so git refuses too if this check
 * is ever wrong.
 */

const TIMEOUT = 15_000;

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await pexec("git", args, { cwd, timeout: TIMEOUT, maxBuffer: 8 * 1024 * 1024 });
  return stdout;
}

/** The primary checkout's path and branch: `git worktree list`'s first entry. */
async function primaryOf(wt: string): Promise<{ path: string; branch: string | null }> {
  const out = await git(wt, ["worktree", "list", "--porcelain"]);
  const first = out.split("\n\n")[0] ?? "";
  const path = /^worktree (.+)$/m.exec(first)?.[1]?.trim() ?? "";
  const branch = /^branch refs\/heads\/(.+)$/m.exec(first)?.[1]?.trim() ?? null;
  return { path, branch };
}

/** Files under the gitignored transport dirs — nothing in git would save them. */
function countTransport(wt: string): number {
  let n = 0;
  const walk = (dir: string, depth: number) => {
    if (depth > 6) return;
    let ents;
    try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.isDirectory()) walk(join(dir, e.name), depth + 1);
      // The read markers are bookkeeping, not anybody's file.
      else if (!e.name.startsWith(".seen")) n++;
    }
  };
  walk(join(wt, ".claude", "outbox"), 0);
  walk(join(wt, ".claude", "inbox"), 0);
  return n;
}

/**
 * How long a worktree must have sat untouched before it is offered for removal.
 * A wave of agents gets its worktrees a moment before the agents start, and a
 * fresh one is clean by definition — every other check passes on it. An hour of
 * no git activity is what separates "about to be used" from "left behind".
 */
export const LEFTOVER_IDLE_MIN = 60;

/** Minutes since git last wrote this worktree's HEAD, index or reflog. */
async function idleMinutes(wt: string): Promise<number | null> {
  try {
    const admin = (await git(wt, ["rev-parse", "--absolute-git-dir"])).trim();
    let newest = 0;
    for (const f of ["HEAD", "index", join("logs", "HEAD")]) {
      try { newest = Math.max(newest, statSync(join(admin, f)).mtimeMs); } catch { /* absent is fine */ }
    }
    return newest ? Math.floor((Date.now() - newest) / 60_000) : null;
  } catch {
    return null;
  }
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export interface LeftoverInput {
  wt: string;
  branch: string;
  sessions: Pick<SessionInfo, "cwd">[];
  /** `worktreeOwners()` names a live session for this worktree. */
  ownerLive: boolean;
}

export async function worktreeLeftover({ wt, branch, sessions, ownerLive }: LeftoverInput): Promise<WorktreeLeftover> {
  const blockers: string[] = [];
  const primary = await primaryOf(wt);
  const base = primary.branch ?? "";
  if (!primary.path || primary.path === wt) blockers.push("This is the repo's main checkout, not a worktree.");
  if (!base) blockers.push("The main checkout is on no branch, so there is nothing to check this worktree's commits against.");

  let ahead = 0;
  let unlanded = 0;
  if (base) {
    ahead = Number((await git(wt, ["rev-list", "--count", "HEAD", "--not", `refs/heads/${base}`])).trim()) || 0;
    // `+` = a commit whose patch is not on base. A cherry-picked agent commit
    // has a new SHA on main but the same patch, so it is `-` and counts as landed.
    if (ahead > 0) unlanded = (await git(wt, ["cherry", `refs/heads/${base}`, "HEAD"])).split("\n").filter((l) => l.startsWith("+")).length;
  }
  if (unlanded > 0) blockers.push(`${plural(unlanded, "commit")} on ${branch} ${unlanded === 1 ? "is" : "are"} not on ${base}.`);

  // --no-optional-locks: a read must not refresh the index, which would reset
  // the idle clock below to "just now".
  const uncommitted = (await git(wt, ["--no-optional-locks", "status", "--porcelain"])).split("\n").filter(Boolean).length;
  if (uncommitted > 0) blockers.push(`${plural(uncommitted, "file")} changed or new and not committed.`);

  const transport = countTransport(wt);
  if (transport > 0) blockers.push(`${plural(transport, "file")} in its .claude/outbox or .claude/inbox, which git does not keep.`);

  const inside = (cwd: string) => cwd === wt || cwd.startsWith(wt + sep);
  const live = sessions.filter((s) => s.cwd && inside(s.cwd)).length;
  if (live > 0) blockers.push(`${plural(live, "session")} running in it.`);

  if (ownerLive) blockers.push("The session whose agent made it is still open.");

  const idle = await idleMinutes(wt);
  if (idle === null) blockers.push("Could not tell when it was last used.");
  else if (idle < LEFTOVER_IDLE_MIN) blockers.push(`Used ${idle === 0 ? "just now" : `${plural(idle, "minute")} ago`} — something may be about to work in it. Ask again after ${LEFTOVER_IDLE_MIN} minutes untouched.`);

  return { branch, base, ahead, unlanded, uncommitted, transport, sessions: live, ownerLive, idleMinutes: idle, blockers };
}

export type RemoveResult =
  | { ok: true; leftover: WorktreeLeftover; branchDeleted: boolean; note?: string }
  | { ok: false; leftover?: WorktreeLeftover; error: string };

export async function removeLeftover(input: LeftoverInput): Promise<RemoveResult> {
  const { wt, branch } = input;
  let leftover: WorktreeLeftover;
  try { leftover = await worktreeLeftover(input); } catch (err) {
    return { ok: false, error: `Could not check the worktree: ${(err as Error).message}` };
  }
  if (leftover.blockers.length) return { ok: false, leftover, error: leftover.blockers.join(" ") };
  const primary = await primaryOf(wt);
  try {
    // No --force: git refuses a dirty or locked worktree on its own.
    await git(primary.path, ["worktree", "remove", wt]);
  } catch (err) {
    return { ok: false, leftover, error: `git refused: ${(err as Error).message.split("\n").slice(-3).join(" ").trim()}` };
  }
  if (branch === "(detached)" || !branch) return { ok: true, leftover, branchDeleted: false };
  try {
    // -d when git can see it is merged; -D only when every commit was
    // just shown to be on base by patch (cherry-picked).
    await git(primary.path, ["branch", leftover.ahead > 0 ? "-D" : "-d", branch]);
    return { ok: true, leftover, branchDeleted: true };
  } catch (err) {
    return { ok: true, leftover, branchDeleted: false, note: `The worktree is gone; its branch ${branch} stayed: ${(err as Error).message.trim().split("\n")[0]}` };
  }
}
