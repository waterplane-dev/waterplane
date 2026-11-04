/**
 * The repo's pre-push hook run WITHOUT a push, and what is remembered of it.
 *
 * Git's hook contract is all this needs: the hook gets `<remote> <url>` as arguments and
 * `<local ref> <local sha> <remote ref> <remote sha>` on stdin, so feeding it the line a push
 * would feed it IS that push's check, for any repo's hook. Nothing here decides whether a push
 * may go: the real push still runs the hook, which stays the only gate. A verdict is
 * information, a mark on a commit in the phone's list, and never a reason to skip the hook.
 *
 * Which commit a run says anything about is the one trap. A hook that tests the working tree
 * (most do) says nothing about an older commit, and nothing about any commit while the tree
 * holds edits, so it only ever marks HEAD, with a clean tree before and after. Only a repo that
 * declares its hook tests the pushed commit (`waterplane.prePushTestsCommit`: it checks that sha
 * out on its own) can check a chosen commit or push up to one.
 *
 * Verdicts live in `<git common dir>/waterplane-checks.json`, by commit sha: every worktree of
 * the repo shares them, a folder rename keeps them, and they go when the repo goes.
 */
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { BRAND } from "@waterplane/shared";
import type { GitCheck } from "@waterplane/shared";
import { execFileP } from "./proc.js";
import { readJsonGuarded, writeJsonAtomic } from "./jsonstore.js";
import { isRunnableHook } from "./localcistatus.js";
import { pushFailureText } from "./pushverdict.js";

/** The repo-local git config key that says the hook tests the pushed commit, not the tree. */
export const TESTS_COMMIT_SWITCH = `${BRAND.storagePrefix}prePushTestsCommit`;
const STORE = `${BRAND.slug}-checks.json`;
/** Verdicts kept per repo, newest first. A commit that left the outgoing list is never read again. */
const KEEP = 200;
const ZERO = "0".repeat(40);
const OUTPUT_MAX = 16 * 1024 * 1024;
const NO_PROMPT = { ...process.env, GIT_TERMINAL_PROMPT: "0" };

const git = async (wt: string, args: string[]): Promise<string> =>
  (await execFileP("git", args, { cwd: wt, timeout: 15_000, env: NO_PROMPT })).stdout.trim();
const gitOr = (wt: string, args: string[], or = ""): Promise<string> => git(wt, args).catch(() => or);

export const isSha = (s: unknown): s is string => typeof s === "string" && /^[0-9a-f]{40,64}$/.test(s);

/**
 * What a hook's ending says about the code. `null` is no verdict: a signal, an interrupt (130)
 * or a newer push superseding the run stopped it before it finished, and a skip never ran it.
 * Saying "failed" there would mark code nobody found anything wrong with.
 */
export function hookVerdict(code: number | null, output: string): boolean | null {
  if (/^local-ci: (?:skipped|superseded)/m.test(output.replace(/\x1b\[[0-9;]*m/g, ""))) return null;
  if (code === 0) return true;
  return code == null || code >= 128 ? null : false;
}

/** Newest `keep` verdicts of `all`, with `sha`'s written in. */
export function withVerdict(all: Record<string, GitCheck>, sha: string, v: GitCheck, keep = KEEP): Record<string, GitCheck> {
  const rows = Object.entries({ ...all, [sha]: v }).sort((a, b) => b[1].at - a[1].at).slice(0, keep);
  return Object.fromEntries(rows);
}

const storePath = async (wt: string) => resolve(wt, await git(wt, ["rev-parse", "--git-common-dir"]), STORE);
const validStore = (v: unknown) => !!v && typeof v === "object" && !Array.isArray(v);

/** Every remembered verdict of this repo, `{}` when none or unreadable. */
export async function readChecks(wt: string): Promise<Record<string, GitCheck>> {
  try { return readJsonGuarded<Record<string, GitCheck>>(await storePath(wt), {}, validStore); } catch { return {}; }
}

async function remember(wt: string, sha: string, v: GitCheck): Promise<void> {
  try { const path = await storePath(wt); writeJsonAtomic(path, withVerdict(readJsonGuarded<Record<string, GitCheck>>(path, {}, validStore), sha, v)); }
  catch (e) { console.error(`[git] could not keep a check verdict: ${(e as Error).message}`); }
}

async function hookPath(wt: string): Promise<string | null> {
  const rel = await gitOr(wt, ["rev-parse", "--git-path", "hooks/pre-push"]);
  return isRunnableHook(wt, rel) ? resolve(wt, rel) : null;
}

export async function hookTestsCommit(wt: string): Promise<boolean> {
  return (await gitOr(wt, ["config", "--get", "--type=bool", TESTS_COMMIT_SWITCH])) === "true";
}

/** What the phone may offer here: absent = no hook to run. */
export async function prePushFacts(wt: string): Promise<{ testsCommit: boolean } | undefined> {
  return (await hookPath(wt)) ? { testsCommit: await hookTestsCommit(wt) } : undefined;
}

/** Where a push of this branch goes: its upstream's remote and ref, else `origin` and its own name. */
export async function pushDestination(wt: string): Promise<{ branch: string; remote: string; ref: string; remoteSha: string } | null> {
  const branch = await gitOr(wt, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (!branch) return null;
  const remote = (await gitOr(wt, ["config", "--get", `branch.${branch}.remote`])) || "origin";
  const ref = (await gitOr(wt, ["config", "--get", `branch.${branch}.merge`])) || `refs/heads/${branch}`;
  const remoteSha = (await gitOr(wt, ["rev-parse", "--verify", "--quiet", "@{u}^{commit}"])) || ZERO;
  return { branch, remote, ref, remoteSha };
}

/** Is `sha` a commit of this branch that its upstream does not have yet? */
export async function isOutgoing(wt: string, sha: string): Promise<boolean> {
  return (await gitOr(wt, ["rev-list", "@{u}..HEAD"])).split("\n").includes(sha);
}

const isClean = async (wt: string) => (await gitOr(wt, ["status", "--porcelain"], "?")) === "";

/** The hook, fed what a push of `sha` would feed it. Output streams to `onData`, like a push's. */
function runHook(wt: string, hook: string, args: string[], stdin: string, onData?: (stream: "out" | "err", chunk: string) => void):
  Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((done) => {
    const child = spawn(hook, args, { cwd: wt, stdio: ["pipe", "pipe", "pipe"], env: NO_PROMPT });
    const out = { out: "", err: "" };
    for (const k of ["out", "err"] as const) {
      const s = k === "out" ? child.stdout : child.stderr;
      s.setEncoding("utf8");
      s.on("data", (d: string) => {
        out[k] = (out[k] + d).length > OUTPUT_MAX ? (out[k] + d).slice(-OUTPUT_MAX / 2) : out[k] + d;
        onData?.(k, d);
      });
    }
    child.stdin.on("error", () => { /* a hook that never reads its stdin: not a failure */ });
    child.on("error", (e) => done({ code: 1, stdout: out.out, stderr: `${out.err}\n${e.message}` }));
    child.on("close", (code) => done({ code, stdout: out.out, stderr: out.err }));
    child.stdin.end(stdin);
  });
}

/** Run the checks on `sha` (absent = HEAD), remember what they said, and word it. Pushes nothing. */
export async function runCheck(wt: string, sha: string | undefined, onData?: (stream: "out" | "err", chunk: string) => void):
  Promise<{ ok: boolean; output?: string; error?: string }> {
  if (process.env.SKIP_LOCAL_CI === "1") return { ok: false, error: "SKIP_LOCAL_CI=1 is set on this desktop, so the hook would skip itself and prove nothing." };
  const hook = await hookPath(wt);
  if (!hook) return { ok: true, output: "This repo has no pre-push hook, so there is nothing to check." };
  const dest = await pushDestination(wt);
  if (!dest) return { ok: false, error: "This checkout is not on a branch, so there is no push to check." };
  const head = await gitOr(wt, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
  const target = sha ?? head;
  if (!isSha(target)) return { ok: false, error: "This branch has no commit to check." };
  const exact = await hookTestsCommit(wt);
  if (target !== head) {
    if (!(await isOutgoing(wt, target))) return { ok: false, error: "That commit is no longer waiting to be pushed." };
    if (!exact) return { ok: false, error: "This repo's hook tests the working tree, so it can only check the newest commit." };
  }
  const cleanBefore = exact || (await isClean(wt));
  const url = await gitOr(wt, ["remote", "get-url", dest.remote]);
  const line = `refs/heads/${dest.branch} ${target} ${dest.ref} ${dest.remoteSha}\n`;
  const r = await runHook(wt, hook, [dest.remote, url || dest.remote], line, onData);
  const verdict = hookVerdict(r.code, `${r.stdout}\n${r.stderr}`);
  const short = target.slice(0, 7);
  if (verdict === null) return { ok: false, error: `The checks on ${short} were stopped before they finished, so they say nothing about it.\n\n${pushFailureText(r.stdout, r.stderr, 6)}` };
  // A hook that tests the tree speaks for HEAD only if the tree WAS HEAD for the whole run.
  const speaks = exact || (cleanBefore && (await isClean(wt)) && (await gitOr(wt, ["rev-parse", "HEAD"])) === target);
  if (speaks) await remember(wt, target, { ok: verdict, at: Date.now() });
  const caveat = speaks ? "" : " The working tree had uncommitted changes or moved during the run, so no commit got this verdict.";
  if (verdict) return { ok: true, output: `Checks passed on ${short}. Nothing was pushed.${caveat}` };
  return { ok: false, error: `${pushFailureText(r.stdout, r.stderr)}${caveat ? `\n\n${caveat.trim()}` : ""}` };
}
