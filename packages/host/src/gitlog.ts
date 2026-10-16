/**
 * The branch's history against its upstream, for the git sheet's ↑N ↓M:
 * what a push would send, what a pull would bring, and the recent history
 * both sides already have. Plus the one write it needs — a fetch, so
 * "incoming" can be as of now rather than as of whatever last fetched.
 */
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { GitCommit, GitLog } from "@waterplane/shared";
import { execFileP as pexec } from "./proc.js";

/** Rows per list. A branch 400 commits behind is told as a count, not drawn. */
const LIST_MAX = 100;
const SHARED_MAX = 30;
const NO_PROMPT = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
const errText = (err: any): string => (err?.stderr || err?.stdout || String(err)).toString().trim();

async function git(wt: string, args: string[]): Promise<string> {
  return (await pexec("git", args, { cwd: wt, maxBuffer: 16 * 1024 * 1024 })).stdout;
}

const FORMAT = "--format=%H%x1f%h%x1f%an%x1f%at%x1f%s%x1e";

export function parseLog(out: string): GitCommit[] {
  return out.split("\x1e").map((r) => r.replace(/^\n/, "")).filter(Boolean).map((r) => {
    const [sha, short, author, at, subject] = r.split("\x1f");
    return { sha, short, author, at: Number(at) * 1000, subject: subject ?? "" };
  });
}

async function count(wt: string, range: string): Promise<number> {
  return Number((await git(wt, ["rev-list", "--count", range])).trim()) || 0;
}

/** When this worktree last fetched (FETCH_HEAD's mtime) — absent if it never has. */
async function lastFetch(wt: string): Promise<number | undefined> {
  try {
    const p = (await git(wt, ["rev-parse", "--git-path", "FETCH_HEAD"])).trim();
    return (await stat(resolve(wt, p))).mtimeMs;
  } catch {
    return undefined;
  }
}

export async function gitLog(wt: string): Promise<GitLog> {
  const branchRaw = (await git(wt, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
  const branch = branchRaw === "HEAD" ? "(detached)" : branchRaw;
  let upstream: string | undefined;
  try {
    upstream = (await git(wt, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])).trim() || undefined;
  } catch { /* no upstream */ }
  const fetchedAt = await lastFetch(wt);
  if (!upstream) {
    const shared = parseLog(await git(wt, ["log", `-n${SHARED_MAX}`, FORMAT, "HEAD"]).catch(() => ""));
    return { branch, incoming: [], incomingTotal: 0, outgoing: [], outgoingTotal: 0, shared, fetchedAt };
  }
  const [incoming, incomingTotal, outgoing, outgoingTotal, base] = await Promise.all([
    git(wt, ["log", `-n${LIST_MAX}`, FORMAT, "HEAD..@{u}"]).then(parseLog),
    count(wt, "HEAD..@{u}"),
    git(wt, ["log", `-n${LIST_MAX}`, FORMAT, "@{u}..HEAD"]).then(parseLog),
    count(wt, "@{u}..HEAD"),
    git(wt, ["merge-base", "HEAD", "@{u}"]).then((s) => s.trim()).catch(() => ""),
  ]);
  const shared = base ? parseLog(await git(wt, ["log", `-n${SHARED_MAX}`, FORMAT, base])) : [];
  return { branch, upstream, incoming, incomingTotal, outgoing, outgoingTotal, shared, fetchedAt };
}

/**
 * `git fetch` of the upstream's remote — moves remote-tracking refs only,
 * never the branch or the tree, so it is safe beside a running push or a
 * session editing this worktree.
 */
export async function gitFetch(wt: string): Promise<{ ok: boolean; error?: string }> {
  let remote = "";
  try {
    remote = (await git(wt, ["config", "--get", `branch.${(await git(wt, ["rev-parse", "--abbrev-ref", "HEAD"])).trim()}.remote`])).trim();
  } catch { /* no upstream configured */ }
  if (!remote) return { ok: false, error: "This branch has no upstream to check. Push it once to set one." };
  try {
    await pexec("git", ["fetch", "--no-tags", remote], { cwd: wt, timeout: 120_000, env: NO_PROMPT, maxBuffer: 4 * 1024 * 1024 });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `The fetch from ${remote} failed — nothing was changed.\n\n${errText(err)}` };
  }
}

/** One commit's message body and file stat, for a tapped row. `null` = no such commit. */
export async function gitShow(wt: string, sha: string): Promise<string | null> {
  if (!/^[0-9a-f]{7,40}$/.test(sha)) return null;
  try {
    return await git(wt, ["show", "--stat", "--no-color", "--format=%B", sha]);
  } catch {
    return null;
  }
}
