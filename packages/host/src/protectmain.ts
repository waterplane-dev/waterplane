/**
 * **The owner's standard branch rules, set from a tap** — the `protect-main` fix the exposure
 * watch's `B4:default-branch` finding offers (no ruleset, no protection on the default branch).
 *
 * The rules are the ones every public repo here already carries, nothing stricter: block
 * force-push and deletion on the default branch, and on `v*` tags. Direct pushes to main keep
 * working — the owner's workflow has no branches and no PRs, and these rules never ask for either.
 *
 *  - **Only ADDS**: a ruleset with the same name already on the repo is left as it is; nothing is
 *    edited or deleted. A repo that turned out to be protected meanwhile is a note, not a write.
 *  - **The repo is this worktree's own github.com `origin`** — no slug arrives from the client.
 *  - **The remote's refusal is quoted** (a private repo on a free plan cannot have rulesets);
 *    never a guess, never retried.
 *  - Confirm-gated (`CONFIRM_GATED_FIXES`): it changes GitHub, not this desktop. Sync `gh` calls
 *    with short timeouts, like the rest of `fixRepoCompliance` — one tap, three calls at most.
 */
import { execFileSync } from "node:child_process";
import { ghOfRemote } from "./exposurewatch.js";

const RULES = [{ type: "non_fast_forward" }, { type: "deletion" }];
export const STANDARD_RULESETS = [
  { name: "protect main", target: "branch", enforcement: "active", bypass_actors: [],
    conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } }, rules: RULES },
  { name: "protect release tags", target: "tag", enforcement: "active", bypass_actors: [],
    conditions: { ref_name: { include: ["refs/tags/v*"], exclude: [] } }, rules: RULES },
] as const;

type Gh = (args: string[], input?: string) => string;
const gh: Gh = (args, input) => execFileSync("gh", args, {
  encoding: "utf8", timeout: 15_000, input, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, GH_PROMPT_DISABLED: "1" },
});

/** The remote's own words out of a failed `gh` call, one line. */
function why(e: unknown): string {
  const err = e as { stderr?: unknown; message?: unknown };
  const text = String(err?.stderr || err?.message || e).split("\n").map((l) => l.trim()).filter(Boolean);
  return text.find((l) => /HTTP \d{3}|upgrade|not found|forbidden/i.test(l)) ?? text[0] ?? "gh failed";
}

export function protectMain(wt: string, run: Gh = gh): { applied: boolean; note: string } {
  let slug: string | undefined;
  try { slug = ghOfRemote(execFileSync("git", ["remote", "get-url", "origin"], { cwd: wt, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 3000 })); } catch { /* none */ }
  if (!slug) return { applied: false, note: "this repo has no github.com origin — no branch rules set" };
  let have: Set<string>;
  try {
    const list = JSON.parse(run(["api", `repos/${slug}/rulesets`]) || "[]") as Array<{ name?: unknown }>;
    have = new Set(list.map((r) => String(r?.name)));
  } catch (e) { return { applied: false, note: `could not read ${slug}'s rulesets — ${why(e)}` }; }
  const made: string[] = [], kept: string[] = [], failed: string[] = [];
  for (const rs of STANDARD_RULESETS) {
    if (have.has(rs.name)) { kept.push(rs.name); continue; }
    try { run(["api", "-X", "POST", `repos/${slug}/rulesets`, "--input", "-"], JSON.stringify(rs)); made.push(rs.name); }
    catch (e) { failed.push(`${rs.name}: ${why(e)}`); }
  }
  const parts = [
    made.length ? `set "${made.join('" and "')}" on ${slug} (force-push and deletion blocked; direct pushes still work)` : "",
    kept.length ? `"${kept.join('" and "')}" already there — left as it is` : "",
    failed.length ? `GitHub refused ${failed.join("; ")}` : "",
    made.length ? "the exposure watch reads it again on its next run" : "",
  ].filter(Boolean);
  return { applied: made.length > 0, note: parts.join("; ") };
}
