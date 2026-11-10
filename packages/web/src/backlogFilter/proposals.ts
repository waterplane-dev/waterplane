/**
 * **Work a repo's script proposed** — the launcher's proposals strip: its
 * number, its per-repo doors and the cut each door opens, from ONE call.
 *
 * Part of `backlogFilter.ts`, the barrel every caller imports. Pure, and its
 * imports carry `.ts` because `node --test` loads it straight off the source.
 *
 * A proposal is a backlog row a script posted with no session behind it
 * (`origin` `proposed:<name>`, always `manual`). Shared `isPendingProposal` is
 * the one edge: the strip counts exactly the rows still waiting for the
 * person's fire, schedule or delete, and the host clears the push by the same
 * predicate. A count is a filter: every number here opens exactly its ids.
 */
import type { BacklogItem } from "@waterplane/shared";
import { pendingProposals, proposerOf } from "@waterplane/shared";

export interface ProposalRepo { dir: string; ids: string[]; proposers: string[] }
export interface ProposalCut { total: number; repos: ProposalRepo[] }

type Row = Pick<BacklogItem, "id" | "repoDir" | "origin" | "archived" | "manual" | "status" | "at">;

/** Every pending proposal, grouped by repo in first-seen order. */
export function proposalCut(items: readonly Row[]): ProposalCut {
  const byDir = new Map<string, ProposalRepo>();
  const rows = pendingProposals(items);
  for (const it of rows) {
    let r = byDir.get(it.repoDir);
    if (!r) { r = { dir: it.repoDir, ids: [], proposers: [] }; byDir.set(it.repoDir, r); }
    r.ids.push(it.id);
    const who = proposerOf(it.origin);
    if (who && !r.proposers.includes(who)) r.proposers.push(who);
  }
  return { total: rows.length, repos: [...byDir.values()] };
}

/** The strip's sentence: "1 proposal waits for you" / "3 proposals wait for you". */
export function proposalsHeadline(n: number): string {
  return n === 1 ? "1 proposal waits for you" : `${n} proposals wait for you`;
}

/** What the backlog's ids cut says it is — the filter bar's head. */
export function proposalsCutLabel(n: number, repoName: string): string {
  return n === 1 ? `the proposal in ${repoName}` : `the ${n} proposals in ${repoName}`;
}

/** Who proposed, for a repo's door: one name, or how many scripts. */
export function proposersWords(names: readonly string[]): string {
  if (!names.length) return "a script";
  return names.length === 1 ? names[0] : `${names.length} scripts`;
}
