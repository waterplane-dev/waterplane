/**
 * What a remote's own rules demand of a push to the default branch — read from
 * GitHub's rules, never chosen by waterplane. `direct` is today's behaviour and
 * the owner's: no rules, or only force-push/deletion blocked. Only a
 * `pull_request`, `required_status_checks`, `merge_queue` or required-review rule
 * makes it anything else. Unparseable input is ABSENT (undefined), never a guess.
 *
 * `mergeQueue`: a merge on this branch is ENQUEUED, not done — `gh pr merge` exits 0
 * having only queued the PR, so its exit code is never the merge's outcome (the host
 * re-reads the PR's state before it touches a branch).
 */
export type BranchMode = "direct" | "pr" | "pr-checks";
export type MergeMethod = "merge" | "squash" | "rebase";

export interface BranchRules {
  mode: BranchMode;
  /** Status-check contexts the rules require (empty unless `pr-checks`). */
  requiredChecks: string[];
  /** Required checks pinned to one GitHub App (integration_id / app_id): only that app's status
   *  satisfies them, so a `local-ci` status from the user's token would not. Omitted when none. */
  pinnedChecks?: string[];
  requiredApprovals: number;
  /** Merge methods the repo allows; empty = the repo JSON did not say. */
  allowedMerge: MergeMethod[];
  autoMerge: boolean;
  /** The branch's rules demand a merge queue (`merge_queue` rule). Omitted when not. */
  mergeQueue?: boolean;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * @param rules  parsed `repos/{slug}/rules/branches/{branch}` (array of {type, parameters})
 * @param classic parsed classic `branches/{b}/protection`, or null/undefined when none (404)
 * @param repo   parsed `repos/{slug}` (allow_*_merge, allow_auto_merge)
 */
export function classifyBranchRules(rules: unknown, classic?: unknown, repo?: unknown): BranchRules | undefined {
  if (!Array.isArray(rules)) return undefined;
  if (classic !== undefined && classic !== null && !isObj(classic)) return undefined;
  let pr = false;
  let approvals = 0;
  const checks = new Set<string>();
  const pinned = new Set<string>();
  let statusChecks = false;
  let queue = false;
  for (const r of rules) {
    if (!isObj(r) || typeof r.type !== "string") return undefined;
    const p = isObj(r.parameters) ? r.parameters : {};
    if (r.type === "pull_request") {
      pr = true;
      const n = p.required_approving_review_count;
      if (typeof n === "number" && n > 0) approvals = Math.max(approvals, Math.floor(n));
    } else if (r.type === "merge_queue") {
      // A queue lands only PRs: a push to the branch is refused as surely as under `pull_request`.
      pr = true;
      queue = true;
    } else if (r.type === "required_status_checks") {
      statusChecks = true;
      const list = p.required_status_checks;
      if (Array.isArray(list)) for (const c of list) if (isObj(c) && typeof c.context === "string") {
        checks.add(c.context);
        if (typeof c.integration_id === "number") pinned.add(c.context);
      }
    }
  }
  if (isObj(classic)) {
    const rev = classic.required_pull_request_reviews;
    if (isObj(rev)) {
      pr = true;
      const n = rev.required_approving_review_count;
      if (typeof n === "number" && n > 0) approvals = Math.max(approvals, Math.floor(n));
    }
    const sc = classic.required_status_checks;
    if (isObj(sc)) {
      statusChecks = true;
      if (Array.isArray(sc.contexts)) for (const c of sc.contexts) if (typeof c === "string") checks.add(c);
      if (Array.isArray(sc.checks)) for (const c of sc.checks) if (isObj(c) && typeof c.context === "string") {
        checks.add(c.context);
        if (typeof c.app_id === "number" && c.app_id !== -1) pinned.add(c.context);
      }
    }
  }
  const mode: BranchMode = statusChecks ? "pr-checks" : pr ? "pr" : "direct";
  const allowedMerge: MergeMethod[] = [];
  let autoMerge = false;
  if (isObj(repo)) {
    if (repo.allow_merge_commit === true) allowedMerge.push("merge");
    if (repo.allow_squash_merge === true) allowedMerge.push("squash");
    if (repo.allow_rebase_merge === true) allowedMerge.push("rebase");
    autoMerge = repo.allow_auto_merge === true;
  }
  const out: BranchRules = { mode, requiredChecks: [...checks], requiredApprovals: approvals, allowedMerge, autoMerge };
  if (pinned.size) out.pinnedChecks = [...pinned];
  if (queue) out.mergeQueue = true;
  return out;
}
