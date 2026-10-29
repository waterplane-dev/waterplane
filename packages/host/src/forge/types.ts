/**
 * The forge seam: every call the host makes to the remote's hosting service
 * (pull requests, branch rules, commit statuses) goes through this interface.
 * GitHub (`github.ts`, `gh`) is the only implementation; see docs/notes/forge.md.
 *
 * Methods return RAW forge JSON where a pure classifier in `@waterplane/shared`
 * reads it (`classifyBranchRules`, `prViewsFrom`) — the classifiers stay pure and
 * forge-agnostic in what they ask for, never in how it was fetched. Methods that
 * the caller words a failure for THROW the raw exec error (the caller's `msg(e)`
 * reads its stderr); the ones whose failure means "absent" return undefined.
 */
export type MergeMethod = "merge" | "squash" | "rebase";

/** Raw JSON of the three reads `classifyBranchRules` takes. */
export interface ForgeRulesRaw { rules: unknown; classic: unknown; repo: unknown }

export interface Forge {
  readonly kind: string;
  /** The default branch's rules, raw; undefined when any required read fails (caller behaves as direct). */
  rules(): Promise<ForgeRulesRaw | undefined>;
  /** The remote's default branch name, or undefined. */
  defaultBranch(): Promise<string | undefined>;
  /** The PR for the checked-out branch, if one exists. */
  existingPr(): Promise<{ url: string; number?: number } | undefined>;
  /** Open a PR (fill from commits); returns its URL. Throws on failure. */
  openPr(o?: { head: string; base: string }): Promise<string>;
  /** Open PRs authored by me, raw JSON for `prViewsFrom`. Throws on failure. */
  listPrs(): Promise<unknown>;
  /** One PR's lifecycle state ("OPEN", "MERGED", "CLOSED"). Throws on failure. */
  prState(n: number): Promise<string>;
  /** One PR's raw head/base/state. Throws on failure. */
  prInfo(n: number): Promise<{ headRefName?: unknown; baseRefName?: unknown; state?: unknown }>;
  merge(n: number, method: MergeMethod | undefined): Promise<void>;
  autoMerge(n: number, on: boolean, method?: MergeMethod): Promise<void>;
  close(n: number): Promise<void>;
  /** The failing-step log of a CI run (text). Throws on failure. */
  checksLog(runId: string): Promise<string>;
  /** Report a `local-ci` success status on a commit. Throws on failure. */
  postStatus(sha: string, description: string): Promise<void>;
}
