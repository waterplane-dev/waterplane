/** The GitHub forge: `gh`. The ONLY file under packages/host/src (besides protectmain.ts) that spawns it. */
import { execFileP } from "../proc.js";
import type { Forge, MergeMethod } from "./types.js";

const FIELDS = "number,title,headRefName,url,reviewDecision,statusCheckRollup,mergeable,autoMergeRequest";
const FLAG = { merge: "--merge", squash: "--squash", rebase: "--rebase" } as const;
const flagOf = (m: MergeMethod | undefined) => (m ? FLAG[m] : "--merge");
const NO_PROMPT = () => ({ ...process.env, GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1" });

/** `gh` in the worktree. Env is read per call so a test can put a fake `gh` first on PATH. */
const gh = (wt: string, args: string[], timeout: number, maxBuffer: number) =>
  execFileP("gh", args, { cwd: wt, timeout, env: NO_PROMPT(), maxBuffer });

/** `slug` is `owner/repo`; absent for the cwd-resolved fallback (gh finds the repo from the worktree). */
export function githubForge(wt: string, slug?: string): Forge {
  const api = async (args: string[]): Promise<{ ok: true; json: unknown } | { ok: false }> => {
    try {
      const { stdout } = await execFileP("gh", args, { timeout: 8000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, GH_PROMPT_DISABLED: "1" } });
      return { ok: true, json: JSON.parse(stdout) };
    } catch { return { ok: false }; }
  };
  return {
    kind: "github",
    async rules() {
      if (!slug) return undefined;
      const repo = await api(["api", `repos/${slug}`]);
      if (!repo.ok) return undefined;
      const branch = (repo.json as { default_branch?: unknown } | null)?.default_branch;
      if (typeof branch !== "string" || !branch) return undefined;
      const b = encodeURIComponent(branch);
      const rules = await api(["api", `repos/${slug}/rules/branches/${b}`]);
      if (!rules.ok) return undefined;
      const classic = await api(["api", `repos/${slug}/branches/${b}/protection`]);
      // 404 = no classic protection; any other failure (403 on a free private repo) = no classic reading.
      return { rules: rules.json, classic: classic.ok ? classic.json : undefined, repo: repo.json };
    },
    async defaultBranch() {
      try {
        const j = JSON.parse((await gh(wt, ["repo", "view", "--json", "defaultBranchRef"], 60_000, 4 * 1024 * 1024)).stdout);
        return typeof j?.defaultBranchRef?.name === "string" ? j.defaultBranchRef.name : undefined;
      } catch { return undefined; }
    },
    async existingPr() {
      try {
        const j = JSON.parse((await gh(wt, ["pr", "view", "--json", "url,number"], 60_000, 4 * 1024 * 1024)).stdout);
        return typeof j?.url === "string" ? { url: j.url, number: j.number } : undefined;
      } catch { return undefined; }
    },
    async openPr(o) {
      const args = o ? ["pr", "create", "--fill", "--head", o.head, "--base", o.base] : ["pr", "create", "--fill"];
      return (await gh(wt, args, 60_000, 4 * 1024 * 1024)).stdout.trim().split("\n").pop() ?? "";
    },
    async listPrs() {
      const { stdout } = await gh(wt, ["pr", "list", "--author", "@me", "--state", "open", "--limit", "30", "--json", FIELDS], 20_000, 16 * 1024 * 1024);
      return JSON.parse(stdout);
    },
    async prState(n) {
      return String(JSON.parse((await gh(wt, ["pr", "view", String(n), "--json", "state"], 15_000, 16 * 1024 * 1024)).stdout)?.state ?? "");
    },
    async prInfo(n) {
      return JSON.parse((await gh(wt, ["pr", "view", String(n), "--json", "headRefName,baseRefName,state"], 20_000, 16 * 1024 * 1024)).stdout);
    },
    async merge(n, method) { await gh(wt, ["pr", "merge", String(n), flagOf(method)], 60_000, 16 * 1024 * 1024); },
    async autoMerge(n, on, method) {
      await gh(wt, on ? ["pr", "merge", String(n), "--auto", flagOf(method)] : ["pr", "merge", String(n), "--disable-auto"], 30_000, 16 * 1024 * 1024);
    },
    async close(n) { await gh(wt, ["pr", "close", String(n)], 30_000, 16 * 1024 * 1024); },
    async checksLog(runId) { return (await gh(wt, ["run", "view", runId, "--log-failed"], 60_000, 16 * 1024 * 1024)).stdout; },
    async postStatus(sha, description) {
      await gh(wt, ["api", "-X", "POST", `repos/${slug}/statuses/${sha}`, "-f", "state=success", "-f", "context=local-ci", "-f", `description=${description}`], 8_000, 1024 * 1024);
    },
  };
}
