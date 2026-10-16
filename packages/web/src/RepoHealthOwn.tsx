/**
 * A repo's OWN readings, under waterplane's — the repo's provenance said once,
 * in the heading, never as a badge on every tile.
 *
 * Three states, decided by `ownShow` (pure, in `repoHealthWords`): no block on
 * the wire says nothing (an engine older than the field, or a scope); a repo
 * that declares nothing gets ONE line naming the file that would add one; a
 * declaration gets a heading, its absence sentence where there is one, and a
 * tile per reading carrying the repo's own `means` and the direction the repo
 * says it wants — attributed to the repo, never the sheet's own verdict.
 *
 * The tiles are `SeriesTile`, the same tile waterplane's readings use: a
 * reading is a reading, and only the heading above it says whose.
 */
import type { ReactNode } from "react";
import { BRAND, type RepoHealthOwnSeries, type RepoHealthPlot } from "@waterplane/shared";
import { SeriesTile } from "./RepoHealthTiles";
import { ownAimWords, ownApartWords, ownHeadWords, ownNoneWords, ownShow } from "./repoHealthWords";

export function OwnReadings({ plot, repoName, width, actionsFor }: {
  plot: RepoHealthPlot;
  repoName: string;
  width: number;
  actionsFor?: (s: RepoHealthOwnSeries) => ReactNode;
}) {
  const show = ownShow(plot);
  if (show.kind === "none") return null;
  if (show.kind === "add") return <div className="rh-cap">{ownNoneWords(show.file)}</div>;
  const { own } = show;
  return (
    <>
      <div className="section rh-prov">{ownHeadWords(repoName, own.file)}</div>
      {own.absent ? <div className="rh-cap">{own.absent}</div> : null}
      {own.problems?.length ? <div className="rh-cap">{own.problems.join(" · ")}</div> : null}
      {own.series.length ? (
        <ul className="rh-tiles">
          {own.series.map((s) => {
            const aim = ownAimWords(s.better, repoName);
            return (
              <SeriesTile key={s.key} s={s} width={width}
                means={[s.means, aim].filter(Boolean).join(" ")}
                actions={actionsFor?.(s)} />
            );
          })}
        </ul>
      ) : null}
      <div className="rh-cap">{ownApartWords(BRAND.displayName)}</div>
    </>
  );
}
