/**
 * A repo's OWN readings, under waterplane's — the repo's provenance said once,
 * in the card's heading, never as a badge on every tile.
 *
 * Three states, decided by `ownShow` (pure, in `repoHealthWords`): no block on
 * the wire says nothing (an engine older than the field, or a scope); a repo
 * that declares nothing gets ONE line naming the file that would add one; a
 * declaration gets a heading naming whose readings these are, its absence
 * sentence where there is one (open — absences never fold), and the same
 * compact/expand grid as waterplane's tiles, each carrying the repo's own
 * `means` and the direction the repo says it wants — attributed to the repo,
 * never the sheet's own verdict.
 *
 * The tiles are `SeriesTile` in a `TileGrid`, the same tile waterplane's
 * readings use: a reading is a reading, and only the heading says whose.
 * The card is the jump nav's `#rh-own`.
 */
import type { ReactNode } from "react";
import { BRAND, type RepoHealthOwnSeries, type RepoHealthPlot } from "@waterplane/shared";
import { TileGrid } from "./RepoHealthTiles";
import { OWN_MORE_SUMMARY } from "./repoHealthTileWords";
import type { HealthAxisMode } from "./healthIndexWords";
import { ownAimWords, ownApartWords, ownHeadWords, ownNoneWords, ownShow } from "./repoHealthWords";

export function OwnReadings({ plot, repoName, actionsFor, series, axis }: {
  plot: RepoHealthPlot;
  repoName: string;
  actionsFor?: (s: RepoHealthOwnSeries) => ReactNode;
  /** The own series as the region draws them (folded to weeks in weeks mode).
   *  Absent = `plot.own.series` whole. */
  series?: readonly RepoHealthOwnSeries[];
  axis?: HealthAxisMode;
}) {
  const show = ownShow(plot);
  if (show.kind === "none") return null;
  if (show.kind === "add") {
    return <div className="rh-card" id="rh-own"><div className="rh-cap">{ownNoneWords(show.file)}</div></div>;
  }
  const { own } = show;
  const drawn = series ?? own.series;
  const meansFor = (s: RepoHealthOwnSeries) => [s.means, ownAimWords(s.better, repoName)].filter(Boolean).join(" ");
  return (
    <div className="rh-card" id="rh-own">
      <h3 className="rh-h">{ownHeadWords(repoName, own.file)}</h3>
      {own.absent ? <div className="rh-cap">{own.absent}</div> : null}
      {own.problems?.length ? <div className="rh-cap">{own.problems.join(" · ")}</div> : null}
      {drawn.length ? <TileGrid series={drawn} axis={axis} meansFor={meansFor} actionsFor={actionsFor} /> : null}
      <details className="hint-more rh-more">
        <summary>{OWN_MORE_SUMMARY}</summary>
        <p>{ownApartWords(BRAND.displayName)}</p>
      </details>
    </div>
  );
}
