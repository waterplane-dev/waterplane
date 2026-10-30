/**
 * Whether a branch's work has reached its REMOTE — read off local refs, never a fetch, never a
 * push. Its own module because it is a question about git STATE, asked by whoever notices refs
 * may have moved (`gitnotify.ts`: when a host-run pull or push ends, and on its tick), while
 * `git.ts` RUNS git operations. A push from a terminal updates the same remote-tracking ref a
 * host-run one does, so this answers for both (design round 4).
 *
 * The branch's remote ref is where its PUSHES go (`remoteRefOf`), never merely its upstream; a LOCAL
 * upstream (`branch.X.remote = .`) is no remote at all, and a branch with no upstream (pushed with a
 * bare `git push origin X`) is `refs/remotes/<its push remote>/X` when that ref exists.
 */
import { execFileP as pexec } from "./proc.js";
import { safeBranch } from "./git.js";

const SHA = /^[0-9a-f]{40,64}$/;

async function git(wt: string, args: string[]): Promise<string> {
  return (await pexec("git", args, { cwd: wt, maxBuffer: 1024 * 1024 })).stdout.trim();
}

/** `git config --get`: the value, "" when unset (exit 1); throws when git itself broke. */
async function config(wt: string, key: string): Promise<string> {
  try { return await git(wt, ["config", "--get", key]); }
  catch (e: any) { if (e?.code === 1) return ""; throw e; }
}

/** `merge-base --is-ancestor`: true/false, undefined when git cannot say (a missing object). */
async function isAncestor(wt: string, a: string, b: string): Promise<boolean | undefined> {
  try { await git(wt, ["merge-base", "--is-ancestor", a, b]); return true; }
  catch (e: any) { return e?.code === 1 ? false : undefined; }
}

/**
 * The remote-tracking ref a branch's pushes land on, or "" when there is none to read. First
 * `%(push)` — git's OWN answer for where a bare `git push` sends this branch (branch.<b>.pushRemote,
 * remote.pushDefault, push.default, remote.<r>.push), so a branch tracking `origin/main` but pushed
 * to `origin/feat` is read at `origin/feat`, never at its upstream. When git names no remote ref
 * (no upstream under `simple`, a refused push), the branch's own name on its push remote — what an
 * explicit `git push <remote> <b>` moved — when that ref exists. A remote ref holding a commit is
 * never a wrong yes, whichever way it got there.
 */
async function remoteRefOf(wt: string, b: string, push: string): Promise<string> {
  if (push.startsWith("refs/remotes/")) return push;
  const remote = (await config(wt, `branch.${b}.pushRemote`)) || (await config(wt, "remote.pushDefault"))
    || (await config(wt, `branch.${b}.remote`)) || "origin";
  if (remote === "." || !/^[\w.-]+$/.test(remote)) return ""; // a local upstream: the branch went nowhere
  const ref = `refs/remotes/${remote}/${b}`;
  try { await git(wt, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]); return ref; }
  catch { return ""; }
}

/**
 * True when a failed push of `sha` on `branch` is RESOLVED by git state: the branch's remote ref
 * contains `sha`, or contains the branch's CURRENT tip when that tip REPLACED `sha` (an `--amend` or
 * rebase — not a reset back onto the remote, whose tip `sha` descends from) and what the branch now
 * is went up. False when neither is there.
 * Undefined — never a made-up "it went up" — for no such branch, no remote ref, an unsafe name or
 * sha, or git broke. It asks about THAT branch, never HEAD.
 */
export async function pushedAlready(wt: string, branch: string, sha: string): Promise<boolean | undefined> {
  const b = safeBranch(branch);
  if (!b || !SHA.test(sha)) return undefined;
  try {
    // `for-each-ref` matches a pattern up to a slash too (`feat` would list `feat/x`): the exact line only.
    const line = (await git(wt, ["for-each-ref", "--format=%(refname)%09%(objectname)%09%(push)", `refs/heads/${b}`]))
      .split("\n").map((l) => l.split("\t")).find((p) => p[0] === `refs/heads/${b}`);
    if (!line) return undefined;
    const ref = await remoteRefOf(wt, b, line[2] ?? "");
    if (!ref) return undefined;
    const onRemote = (c: string): Promise<boolean | undefined> => isAncestor(wt, c, ref);
    const own = await onRemote(sha);
    if (own !== false) return own;
    // The tip counts only as a REPLACEMENT of `sha` (amend, rebase): a tip `sha` descends from
    // is a reset BACK — `sha`'s work is uncommitted or dropped, and a remote holding the older
    // tip says nothing about it. `sha` gone from the store (128) is unknown, never a yes.
    const tip = line[1];
    const back = await isAncestor(wt, tip, sha);
    if (back !== false) return back ? false : undefined;
    return onRemote(tip);
  } catch { return undefined; }
}
