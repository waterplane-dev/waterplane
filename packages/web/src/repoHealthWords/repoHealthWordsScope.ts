// A slice of the repo-health words (../repoHealthWords.ts is the facade; docs/notes/webclient-architecture.md).
import { nf } from "./repoHealthWordsFmt.ts";

// ── a reading of one subtree ───────────────────────────────────────────────

/** The chip for the repo-wide reading. Named for what it IS, not "all" or
 *  "none": a scope switched off is still a reading of something. */
export const SCOPE_ALL_LABEL = "whole repo";

/**
 * What a scoped reading is, above the charts it changes.
 *
 * Three things are different and a reader has to have all three before the
 * numbers below mean anything: the subtree is measured AS a repo, so its
 * groups are its own top-level directories; only the commits that touched it
 * are in the series, so the window a rank is taken in is its history and not
 * the repo's; and every path printed below is relative to it.
 */
export function scopeHeadWords(scope: string): string {
  return (
    `These readings are of ${scope} alone, measured as though it were the repo: its own groups, its own ` +
    `instructions, and only the commits that touched it. Every path below is relative to ${scope}/.`
  );
}

/**
 * What the break-down chooser does, and what each pick costs.
 *
 * The cost is stated because it is the whole reason this is a choice rather
 * than something the tool does for every group it finds: a scope is its own
 * backfill over its own commits, and a monorepo with eighteen apps would turn
 * one refresh into eighteen. `nothing applies itself` — the tool offers what
 * it found, and the picks are what get measured.
 */
export function scopePickWords(): string {
  return (
    "Pick the parts of this repo worth their own readings. Each one gets its own series, measured over the " +
    "commits that touched it, and the first run of one walks that history from the start — so this is a " +
    "choice and not a sweep. Picking one measures nothing by itself; the reading is built when you refresh it."
  );
}

/** The chooser's own head, naming where the list came from. */
export function scopeChoiceHeadWords(n: number): string {
  return n
    ? `break down by — the ${nf(n)} source groups this engine derived from the tree`
    : "break down by — the engine derived no source group here, so there is nothing to offer";
}

/** A scope with no series yet: what one tap would walk, in its own commits. */
export function scopeEmptyWords(scope: string, commits: number | null | undefined): string {
  const size = typeof commits === "number" && commits > 0
    ? ` It would walk the ${nf(commits)} commit${commits === 1 ? "" : "s"} that touched it.`
    : "";
  return `Nothing measured for ${scope} yet — it has a series of its own and it is empty.${size} It spends no tokens.`;
}
