/**
 * The requirements extension's wire: what the phone may ask its host half, typed once for both ends,
 * and the two pure strings both ends must word the same way (the update brief, the once-per-build key).
 * Pure, no node imports — the host compiles it (`tsconfig.extensions.json`), the phone bundles it.
 */
import type { RequirementItem } from "@waterplane/shared";

export type ReqItem = RequirementItem;

/** One shipped commit, resolved on the host: the phone has no git of its own. */
export interface ReqCommit { sha: string; date: string; subject: string }

/** What the launcher chip needs: no transcript scan, area files only. */
export interface ReqSummary { setUp: boolean; built: boolean; requested: number; total: number }

export interface ReqList {
  repoName: string;
  setUp: boolean;
  /** False when this host cannot find the build script — the sheet says where it looked. */
  scriptFound: boolean;
  lastRun: string | null;
  lastCostUsd: number | null;
  /** Prompts since the last build, null = could not be counted (never 0). */
  promptsBehind: number | null;
  commitsBehind: number | null;
  /** The threshold at which the setup row turns to a warning. */
  stalePrompts: number;
  items: ReqItem[];
  areas: string[];
  /** Keyed by the sha as written in the item; a sha this repo does not know is absent. */
  commits: Record<string, ReqCommit>;
}

// A type alias, not an interface: it must satisfy PluginMethods' index signature.
export type ReqMethods = {
  summary: { args: { repo: string }; result: ReqSummary };
  list: { args: { repo: string }; result: ReqList };
  update: { args: { repo: string }; result: { intentId: string; existing: boolean } };
  setup: { args: { repo: string }; result: { applied: boolean; note: string } };
};

/** What the agent is told about the update — also the setup row's guidance (`web/setupRow.ts`). */
export const REQ_UPDATE_GUIDANCE =
  "Run the command quoted above from the repo root; it spends a few cents of model calls and leaves an " +
  "uncommitted diff under `docs/requirements/`. Do not commit it. Then check the diff the way the run cannot: " +
  "for each item still marked `requested`, look in the code — if it is clearly there, change its status line " +
  "to `shipped` and add the commit that brought it (`git log -S`/`git blame`). Flag duplicates, items that " +
  "describe a change rather than an end state, and anything that contradicts another item. Touch nothing else " +
  "in the list, and end with a short summary of the diff for me to review.";

/** The prompt that waits in the backlog for a tap. `detail` is the setup row's own sentence. */
export function updateBrief(p: { repoName: string; detail: string; cmd: string }): string {
  return `Update the requirements list in ${p.repoName}.\n\nWhere it stands: ${p.detail}\n\nThe command: ${p.cmd}\n\n${REQ_UPDATE_GUIDANCE}`;
}

function fnv8(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, "0");
}

/**
 * The once-per-build key `handToAgent` dedupes on: one waiting update per repo per build state, so a
 * second tap finds the first, and a new build frees the next. Fits pluginapi's 44 chars.
 */
export function updateKey(repoId: string, lastRun: string | null): string {
  return `u.${fnv8(repoId)}.${(lastRun ?? "").replace(/\D/g, "").slice(0, 14) || "never"}`;
}

/**
 * The key for the n-th update of one build state (n ≥ 1 after the first finished): `updateKey` plus `.<n>`.
 * A build that never wrote `.state.json` keeps the same base key forever, so a row that is over must be
 * followed by a NEW key, not answered with the dead one. Stays within pluginapi's 44 chars.
 */
export function updateKeyNth(repoId: string, lastRun: string | null, n: number): string {
  const base = updateKey(repoId, lastRun);
  return n <= 0 ? base : `${base}.${n}`.slice(0, 44);
}
