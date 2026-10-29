/**
 * The `local-ci` commit status, reported after a phone push in PR mode (prpush.ts only —
 * never `gitPush`'s plain path). Honor system: the pre-push hook ran on this desktop and
 * the push went through, so the pushed commit gets a `success` status the repo's rules can
 * require. It proves the hook did not fail the push, not that anyone ran the tests; a push
 * from a terminal or an agent is not covered. Switch: `git config waterplane.localCiStatus true`.
 *
 * Posts `success` only (a failed hook means the sha is not on GitHub), for the sha the push
 * REPORTED (never HEAD after the push), for the PR branch only. Never throws; a failure is a
 * sentence on the push receipt, never a failed push.
 */
import { accessSync, constants } from "node:fs";
import { resolve } from "node:path";
import { execFileP, sleep } from "./proc.js";
import { BRAND } from "@waterplane/shared";
import { ghOfRemote } from "./exposurewatch.js";
import { forgeOverride, githubForge } from "./forge/index.js";

/** The repo-local git config key of the switch (brand prefix + localCiStatus). */
export const LOCAL_CI_SWITCH = `${BRAND.storagePrefix}localCiStatus`;

export interface PorcelainRef { flag: string; src: string; dst: string; newAbbrev?: string }

/** `git push --porcelain` ref lines: `<flag>\t<src>:<dst>\t<summary>`. Everything else is ignored. */
export function porcelainRefs(stdout: string): PorcelainRef[] {
  const out: PorcelainRef[] = [];
  for (const line of stdout.split("\n")) {
    const m = /^([ +\-*=!])\t([^:\t]*):([^\t]*)\t(.*)$/.exec(line.replace(/\r$/, ""));
    if (!m) continue;
    const ref: PorcelainRef = { flag: m[1], src: m[2], dst: m[3] };
    const r = /^([0-9a-f]+)\.\.\.?([0-9a-f]+)/.exec(m[4]);
    if (r) ref.newAbbrev = r[2];
    out.push(ref);
  }
  return out;
}

export type StatusPoster = (wt: string, slug: string, sha: string, description: string) => Promise<void>;
let poster: StatusPoster | null = null;
/** Test seam: replace (or, with null, restore) the `gh api` call. */
export function setStatusPoster(fn: StatusPoster | null): void { poster = fn; }

const NO_PROMPT = { ...process.env, GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1" };
const DESCRIPTION = "pre-push checks ran locally before this push";

async function ghPost(wt: string, slug: string, sha: string, description: string): Promise<void> {
  await (forgeOverride() ?? githubForge(wt, slug)).postStatus(sha, description);
}

const gitOut = async (wt: string, args: string[]) => (await execFileP("git", args, { cwd: wt, timeout: 10_000, env: NO_PROMPT })).stdout.trim();

/** Is `rel` (what `git rev-parse --git-path hooks/pre-push` printed) an executable file, resolved against `wt`? */
export function isRunnableHook(wt: string, rel: string): boolean {
  try { accessSync(resolve(wt, rel), constants.X_OK); return !!rel; } catch { return false; }
}

/** Is there a pre-push hook git would run (executable file at the hooks path)? */
export async function hasRunnablePrePush(wt: string): Promise<boolean> {
  try { return isRunnableHook(wt, await gitOut(wt, ["rev-parse", "--git-path", "hooks/pre-push"])); } catch { return false; }
}

/** The receipt sentence, or `null` when the switch is off (the caller's output stays as it was). */
export async function reportLocalCi(wt: string, push: { stdout: string; stderr: string }, branch: string, knownSha?: string): Promise<string | null> {
  try {
    let on = "";
    try { on = await gitOut(wt, ["config", "--get", "--type=bool", LOCAL_CI_SWITCH]); } catch { /* unset */ }
    if (on !== "true") return null;
    if (process.env.SKIP_LOCAL_CI === "1" || push.stderr.includes("local-ci: skipped (SKIP_LOCAL_CI=1)")) return "local-ci not reported: the hook was skipped.";
    if (!(await hasRunnablePrePush(wt))) return "local-ci not reported: no runnable pre-push hook.";
    const ref = porcelainRefs(push.stdout).find((r) => r.dst === `refs/heads/${branch}` && (r.flag === " " || r.flag === "+" || r.flag === "*"));
    if (!ref) return "Nothing new was pushed, so nothing was reported to GitHub.";
    const sha = knownSha ?? await gitOut(wt, ["rev-parse", `refs/remotes/origin/${branch}`]).catch(() => "");
    if (!/^[0-9a-f]{40,64}$/.test(sha) || (ref.newAbbrev && !sha.startsWith(ref.newAbbrev))) return "local-ci not reported: could not tell which commit was pushed.";
    const slug = ghOfRemote(await gitOut(wt, ["remote", "get-url", "origin"]).catch(() => ""));
    if (!slug && !poster) return "local-ci not reported: origin is not a GitHub remote.";
    const post = poster ?? ghPost;
    let last = "";
    for (let i = 0; i < 2; i++) {
      try { await post(wt, slug ?? "", sha, DESCRIPTION); return `Reported local-ci as passed for ${sha.slice(0, 7)} on GitHub.`; }
      catch (e) { last = String((e as { stderr?: string }).stderr || (e as Error)?.message || e).trim().split("\n").slice(-2).join(" "); }
      if (i === 0) await sleep(2_000);
    }
    return `local-ci could not be reported to GitHub — ${last || "unknown error"}. The push itself went through.`;
  } catch (e) {
    return `local-ci not reported: ${(e as Error)?.message ?? e}`;
  }
}
