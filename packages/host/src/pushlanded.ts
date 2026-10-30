/**
 * A push the remote refused only because its ref had already moved — `refsLockedAt` — is DONE when
 * the remote now holds exactly what this push sent (another push of the same commit landed while
 * this one's hook ran). Its own module beside `git.ts`, which runs the push and stays under its cap.
 *
 * Two halves: `landedAlready` confirms it (the refusal's own `is at <sha>`, else one bounded
 * `ls-remote`; a timeout or a prompt confirms nothing, so it stays a refusal), and `recordLanded`
 * does what a successful push would have done locally — moves the remote-tracking ref and sets the
 * upstream it was asked for — only ever to the sha just confirmed on the remote.
 */
import { execFileP as pexec } from "./proc.js";

/** What the confirming `ls-remote` may take: a hung network or a credential prompt is no answer. */
export const LANDED_LS_REMOTE_MS = 30_000;

type Locked = { to: string | null; refs: { src: string; dst: string; at?: string }[] };
export type Landed = { dst: string; sha: string }[];

async function git(wt: string, args: string[], timeout?: number): Promise<string> {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  return (await pexec("git", args, { cwd: wt, maxBuffer: 1024 * 1024, env, ...(timeout ? { timeout } : {}) })).stdout.trim();
}

/** Every locked ref with the sha this push sent (`rev-parse src`), when the remote is at exactly that
 *  sha — read off the refusal when the remote named it, else asked of the remote (`ls-remote`, the
 *  push's `To`) — or null when any one is not, or could not be confirmed. */
export async function landedAlready(wt: string, locked: Locked, timeoutMs = LANDED_LS_REMOTE_MS): Promise<Landed | null> {
  const landed: Landed = [];
  for (const { src, dst, at } of locked.refs) {
    const sha = await git(wt, ["rev-parse", "--verify", "--end-of-options", `${src}^{commit}`]).catch(() => "");
    let there = at;
    if (!there && locked.to) {
      const ls = await git(wt, ["ls-remote", "--end-of-options", locked.to, dst], timeoutMs).catch(() => "");
      there = ls.split("\n").map((l) => l.split("\t")).find((c) => c[1] === dst)?.[0];
    }
    if (!sha || sha !== there) return null;
    landed.push({ dst, sha });
  }
  return landed;
}

/**
 * What the refused push would have left locally, for HEAD's branch: the upstream it asked for
 * (`setUpstream`, a first push's `--set-upstream <remote> <branch>`), then the remote-tracking ref
 * git maps its push to (`%(push)`) moved to the confirmed sha — only when that ref is the branch a
 * landed ref names. Anything it cannot place is left as it was; a failure here never fails the push.
 */
export async function recordLanded(wt: string, landed: Landed, setUpstream: { remote: string; branch: string } | null): Promise<void> {
  try {
    const b = await git(wt, ["symbolic-ref", "--short", "HEAD"]);
    if (setUpstream && setUpstream.branch === b && landed.some((l) => l.dst === `refs/heads/${b}`)) {
      await git(wt, ["config", `branch.${b}.remote`, setUpstream.remote]);
      await git(wt, ["config", `branch.${b}.merge`, `refs/heads/${b}`]);
    }
    const [push, remote] = (await git(wt, ["for-each-ref", "--format=%(push)%09%(push:remotename)", `refs/heads/${b}`])).split("\t");
    if (!remote || !/^[\w.-]+$/.test(remote) || !push?.startsWith(`refs/remotes/${remote}/`)) return;
    // A first push named its remote; %(push) follows remote.pushDefault, which may be another one.
    if (setUpstream && remote !== setUpstream.remote) return;
    const hit = landed.find((l) => l.dst === `refs/heads/${push.slice(`refs/remotes/${remote}/`.length)}`);
    if (hit) await git(wt, ["update-ref", "-m", "push: already landed", push, hit.sha]);
  } catch { /* the push is done either way; git status stays as it was */ }
}
