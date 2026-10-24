// A slice of the repo-health words (../repoHealthWords.ts is the facade; docs/notes/webclient-architecture.md).
//
// WHOSE reading a tile is. The engine's own (central) readings are the same method in every
// repo and the only inputs to the health index; a repo's own are declared by
// the repo in a committed file and never enter the index. Each group is named
// ONCE, by its heading — never a badge repeated on every tile.
import type { RepoHealthPlot, RepoHealthPlotOwn, RepoHealthOwnSeries } from "@waterplane/shared";

/** The heading over the engine's own tiles and charts. `product` is
 *  `BRAND.displayName`, passed in: this module has no value imports. */
export function centralHeadWords(product: string): string {
  return `${product}'s readings — measured the same way in every repo`;
}

/** The heading over the repo's own tiles, naming the file they come from. */
export function ownHeadWords(repoName: string, file: string): string {
  return `${repoName}'s own readings — declared in ${file}`;
}

/** The ONE line where a repo declares nothing: how to add one, never a dead end. */
export function ownNoneWords(file: string): string {
  return `No readings of this repo's own. To add one beside these, commit ${file}: each entry names a key, what it counts, which way the repo wants it to go, and the argv that prints the number.`;
}

/**
 * The direction the REPO says it wants, attributed to it. Never "better" in
 * this sheet's own voice: the engine takes no side, and the repo's side is
 * reported as the repo's.
 */
export function ownAimWords(better: RepoHealthOwnSeries["better"], repoName: string): string | null {
  if (better === "higher") return `${repoName} aims for this to rise.`;
  if (better === "lower") return `${repoName} aims for this to fall.`;
  return null;
}

/** The line under the own tiles: what they are kept out of. */
export function ownApartWords(product: string): string {
  return `Not part of the health index, which is built from ${product}'s readings only so it compares across repos. Each runs once per refresh that measures a new commit, at that commit; there is no history from before a reading was declared.`;
}

/**
 * What the own-readings block draws, as one decision. `none`: no block from
 * this engine (an older engine, or a scope) — nothing is said. `add`: the repo
 * declares nothing — one line. `drawn`: a heading, its absence sentence if any,
 * and a tile per reading.
 */
export type OwnShow =
  | { kind: "none" }
  | { kind: "add"; file: string }
  | { kind: "drawn"; own: RepoHealthPlotOwn };

export function ownShow(plot: Pick<RepoHealthPlot, "own" | "scope"> | null | undefined): OwnShow {
  const own = plot?.own;
  if (!own || plot?.scope) return { kind: "none" };
  if (!own.declared && own.series.length === 0 && !own.absent) return { kind: "add", file: own.file };
  return { kind: "drawn", own };
}

/** The two verbs of a pending approval, side by side in ONE box. While the
 *  repo's own commands wait, the jump bar's refresh verb is absent: beside an
 *  approve button it read as a second way to do the same thing, and it is not
 *  — it skips the repo's commands (bundled engine) or does nothing at all (the
 *  repo's own engine, which never runs unapproved). */
export function approveRunLabel(kind: "repo" | "bundled", series: { rows?: number } | null | undefined): string {
  if (kind === "repo") return "approve and run its engine";
  return series && (series.rows ?? 0) > 0 ? "approve and update" : "approve and build";
}

/** The other verb, offered only where the bundled engine can run without them. */
export function skipOwnLabel(series: { rows?: number } | null | undefined): string {
  return series && (series.rows ?? 0) > 0 ? "update without them" : "build without them";
}
