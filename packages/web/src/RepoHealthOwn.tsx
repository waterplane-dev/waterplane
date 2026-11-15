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
 *
 * Read back (R-metrics-065): while a tile has fewer readings than a curve
 * needs, the card offers `read back 20 commits` — the desktop runs the repo's
 * approved commands at older commits (`repoHealthOwnBackfill.ts` holds the
 * rule and every sentence). The card draws; the region owns the request.
 * While it runs the button is replaced by the desktop's progress line; its
 * answer — a refusal in the host's own words included — is one line under it.
 */
import type { ReactNode } from "react";
import { History } from "lucide-react";
import { BRAND, ownThisDesktopText, type RepoHealthOwnSeries, type RepoHealthPlot } from "@waterplane/shared";
import { Button } from "./kit/Button";
import { OWN_BACKFILL_DONE, OWN_BACKFILL_HINT, ownBackfillDone, ownBackfillLabel, ownBackfillOffered, ownBackfillRunningWords } from "./repoHealthOwnBackfill";
import { TileGrid } from "./RepoHealthTiles";
import { OWN_MORE_SUMMARY } from "./repoHealthTileWords";
import type { HealthAxisMode } from "./healthIndexWords";
import { ownApartWords, ownHeadWords, ownNoneWords, ownShow } from "./repoHealthWords";

/** The read-back state the region holds (it owns the request). Absent = no verb on this card. */
export interface OwnBackfillState {
  busy: boolean;
  /** Seconds since the tap, while busy. */
  secs: number;
  /** The desktop's progress line, while busy (its `run.note`). */
  note: string | null;
  /** The last answer as one sentence (`ownBackfillResultWords`). */
  result: string | null;
  /** A run here said no older day is left: the button goes, the sentence stays. */
  exhausted: boolean;
  onRun: () => void;
}

export function OwnReadings({ plot, repoName, actionsFor, series, axis, backfill }: {
  plot: RepoHealthPlot;
  repoName: string;
  actionsFor?: (s: RepoHealthOwnSeries) => ReactNode;
  /** The own series as the region draws them (folded to weeks in weeks mode).
   *  Absent = `plot.own.series` whole. */
  series?: readonly RepoHealthOwnSeries[];
  axis?: HealthAxisMode;
  backfill?: OwnBackfillState;
}) {
  const show = ownShow(plot);
  if (show.kind === "none") return null;
  if (show.kind === "add") {
    return <div className="rh-card" id="rh-own"><div className="rh-cap">{ownNoneWords(show.file)}</div></div>;
  }
  const { own } = show;
  const drawn = series ?? own.series;
  const meansFor = (s: RepoHealthOwnSeries) => [s.means, s.backfill === false ? ownThisDesktopText() : ""].filter(Boolean).join(" ");
  return (
    <div className="rh-card" id="rh-own">
      <h3 className="rh-h">{ownHeadWords(repoName, own.file)}</h3>
      {own.absent ? <div className="rh-cap">{own.absent}</div> : null}
      {own.problems?.length ? <div className="rh-cap">{own.problems.join(" · ")}</div> : null}
      {backfill && (backfill.busy || ownBackfillOffered({ series: drawn, unread: own.unread }, backfill.exhausted)) ? (
        <div className="rh-cap">
          {backfill.busy
            ? ownBackfillRunningWords(backfill.note, backfill.secs)
            : (
              <>
                <Button className="rh-verb" type="button" onClick={backfill.onRun}>
                  <History size={12} aria-hidden /> {ownBackfillLabel()}
                </Button>{" "}
                {OWN_BACKFILL_HINT}
              </>
            )}
        </div>
      ) : backfill && ownBackfillDone({ series: drawn, unread: own.unread }, backfill.exhausted) ? (
        <div className="rh-cap">{OWN_BACKFILL_DONE}</div>
      ) : null}
      {backfill?.result && !backfill.busy ? <div className="rh-cap">{backfill.result}</div> : null}
      {drawn.length ? <TileGrid series={drawn} axis={axis} meansFor={meansFor} betterFor={(s) => s.better} actionsFor={actionsFor} /> : null}
      <details className="hint-more rh-more">
        <summary>{OWN_MORE_SUMMARY}</summary>
        <p>{ownApartWords(BRAND.displayName)}</p>
      </details>
    </div>
  );
}
