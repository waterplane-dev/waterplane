/**
 * "Push & open PR" — the push job's path for a repo whose remote rules demand a
 * pull request (`branchrules.ts`: mode pr / pr-checks). Direct and absent rules
 * never come here: `gitPush` runs its own plain path for them, unchanged.
 *
 * EVERY forge call of this flow goes through `forge/` (`forgeOrGh`), never `gh` directly. Outcome text ("opened PR #N" / "updated PR #N"
 * + url) travels as the push job's `output`, the field the phone already reads.
 *
 * Moving local default back (the dance): the new branch is created at HEAD, pushed
 * and the PR opened FIRST. Only then — every ahead commit verified reachable from
 * the new branch — is local default moved, with `git reset --keep origin/<default>`:
 * it moves HEAD to the remote's tip but REFUSES (changing nothing) if a locally
 * modified file would be overwritten, so uncommitted edits are never lost and a
 * commit is never lost (it lives on the branch). If it refuses, the PR still
 * stands, local default keeps its commits, and the sentence says so.
 */
import { execFileP } from "./proc.js";
import type { BranchRules } from "@waterplane/shared";
import { reportLocalCi } from "./localcistatus.js";
import { forgeOrGh } from "./forge/index.js";

type Result = { ok: boolean; output?: string; error?: string };
export interface PrPushIo {
  /** The streamed `git push` (local-CI hook output feeds the progress parser). */
  push(args: string[]): Promise<{ stdout: string; stderr: string }>;
  /** Turn a failed push's output into the sentence the phone shows. */
  failText(stdout: string, stderr: string): string;
}

type Lookup = (wt: string) => Promise<BranchRules | undefined>;
let lookup: Lookup | null = null;
/** Test seam: replace (or, with null, restore) how the rules are read. */
export function setRulesLookup(fn: Lookup | null): void { lookup = fn; }
/** What a push decides on: the CACHED reading only — a push never waits on `gh`, so a
 *  direct repo's push is exactly as fast as before. Not read yet = plain push; a rule
 *  refusal then re-reads (git.ts) and the next push opens the PR. */
export async function rulesFor(wt: string): Promise<BranchRules | undefined> {
  if (lookup) return lookup(wt);
  const { cachedBranchRules } = await import("./branchrules.js");
  return cachedBranchRules(wt);
}

const NO_PROMPT = { ...process.env, GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1" };
const git = (wt: string, args: string[]) => execFileP("git", args, { cwd: wt, timeout: 60_000, env: NO_PROMPT, maxBuffer: 8 * 1024 * 1024 });
const msg = (e: unknown) => String((e as { stderr?: string }).stderr || (e as Error)?.message || e).trim().split("\n").slice(-3).join(" ");
const out = async (wt: string, args: string[]) => (await git(wt, args)).stdout.trim();
const ok = async (wt: string, args: string[]) => { try { await git(wt, args); return true; } catch { return false; } };

/** `wp/<slug>` body: lowercase [a-z0-9-], at most 40 chars. */
export function branchSlug(subject: string): string {
  const s = subject.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/g, "");
  return s || "changes";
}

async function uniqueBranch(wt: string, slug: string): Promise<string> {
  for (let n = 1; n < 100; n++) {
    const name = `wp/${slug}${n === 1 ? "" : `-${n}`}`;
    if (await ok(wt, ["show-ref", "--verify", "--quiet", `refs/heads/${name}`])) continue;
    let remote = "";
    try { remote = await out(wt, ["ls-remote", "--heads", "origin", name]); } catch { /* offline: the push will say */ }
    if (!remote) return name;
  }
  throw new Error("no free branch name");
}

async function defaultBranch(wt: string): Promise<string | undefined> {
  try { return (await out(wt, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])).replace(/^origin\//, "") || undefined; } catch { /* fall through */ }
  return (await forgeOrGh(wt)).defaultBranch();
}

/** Append the local-ci receipt (when the switch is on) as a second sentence. */
const withNote = (r: Result, note: string | null): Result => {
  if (!note) return r;
  return r.ok ? { ...r, output: `${r.output ?? ""} ${note}`.trim() } : { ...r, error: `${r.error ?? ""} ${note}`.trim() };
};

const prNumber = (url: string) => /\/pull\/(\d+)/.exec(url)?.[1];
const done = (verb: string, url: string): Result => {
  const n = prNumber(url);
  return { ok: true, output: `${verb} PR${n ? ` #${n}` : ""} — ${url}` };
};

/** The PR for the checked-out branch, if one exists. */
async function existingPr(wt: string): Promise<{ url: string; number?: number } | undefined> {
  return (await forgeOrGh(wt)).existingPr();
}

/**
 * Run the PR flow. `null` = nothing for it to do (not in PR mode, detached, or
 * default branch with nothing ahead): the caller runs the plain push.
 */
export async function pushForPr(wt: string, rules: BranchRules | undefined, io: PrPushIo): Promise<Result | null> {
  if (!rules || rules.mode === "direct") return null;
  let cur: string;
  try { cur = await out(wt, ["rev-parse", "--abbrev-ref", "HEAD"]); } catch { return null; }
  if (!cur || cur === "HEAD") return null;
  const def = await defaultBranch(wt);
  if (!def) return null;
  try {
    if (cur !== def) return await onBranch(wt, cur, io);
    return await fromDefault(wt, def, io);
  } catch (e) {
    return { ok: false, error: `The pull request could not be opened — ${msg(e)}. Nothing else was changed.` };
  }
}

async function onBranch(wt: string, branch: string, io: PrPushIo): Promise<Result> {
  const hasUp = await ok(wt, ["rev-parse", "--abbrev-ref", "@{u}"]);
  let pushed: { stdout: string; stderr: string };
  try { pushed = await io.push(hasUp ? ["push", "--porcelain"] : ["push", "--porcelain", "--set-upstream", "origin", branch]); }
  catch (e) { return { ok: false, error: io.failText(String((e as any)?.stdout ?? ""), String((e as any)?.stderr ?? "") || String(e)) }; }
  const note = await reportLocalCi(wt, pushed, branch);
  const have = await existingPr(wt);
  if (have) return withNote(done("updated", have.url), note);
  try { return withNote(done("opened", await (await forgeOrGh(wt)).openPr()), note); }
  catch (e) { return withNote({ ok: false, error: `${branch} is pushed to origin, but opening the pull request failed — ${msg(e)}. Nothing else was changed.` }, note); }
}

async function fromDefault(wt: string, def: string, io: PrPushIo): Promise<Result | null> {
  await git(wt, ["fetch", "--quiet", "origin", def]).catch(() => undefined); // best effort
  let ahead: string[];
  try { ahead = (await out(wt, ["rev-list", "--reverse", `origin/${def}..HEAD`])).split("\n").filter(Boolean); } catch { return null; }
  if (!ahead.length) return null;
  const tip = await out(wt, ["rev-parse", "HEAD"]);
  const branch = await uniqueBranch(wt, branchSlug(await out(wt, ["log", "-1", "--format=%s", ahead[0]])));

  await git(wt, ["branch", branch, tip]);
  let pushed: { stdout: string; stderr: string };
  try { pushed = await io.push(["push", "--porcelain", "--set-upstream", "origin", `${branch}:${branch}`]); }
  catch (e) {
    // Nothing reached the remote and main still holds every commit: drop the branch we made.
    await git(wt, ["branch", "-D", branch]).catch(() => undefined);
    return { ok: false, error: io.failText(String((e as any)?.stdout ?? ""), String((e as any)?.stderr ?? "") || String(e)) };
  }
  const note = await reportLocalCi(wt, pushed, branch, tip);
  let url: string;
  try { url = await (await forgeOrGh(wt)).openPr({ head: branch, base: def }); }
  catch (e) {
    return withNote({ ok: false, error: `Your ${ahead.length} commit${ahead.length === 1 ? " is" : "s are"} pushed to origin as ${branch} and still on ${def} here, but opening the pull request failed — ${msg(e)}. Nothing else was changed; push again to retry.` }, note);
  }
  if (!(await ok(wt, ["merge-base", "--is-ancestor", tip, branch]))) {
    return withNote({ ok: true, output: `${done("opened", url).output}. Local ${def} was left as it is — the branch does not hold every commit.` }, note);
  }
  if (await ok(wt, ["reset", "--keep", `origin/${def}`])) return withNote(done("opened", url), note);
  return withNote({ ok: true, output: `${done("opened", url).output}. Local ${def} still has the commits — edited files in the tree stopped moving it back; they are all on ${branch} too.` }, note);
}
