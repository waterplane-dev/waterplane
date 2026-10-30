/**
 * "Health index" — the top section of the repo readings' series region: the
 * host's `healthindex` answer, fetched, drawn by `HealthIndexChart.tsx`.
 */
import { useEffect, useRef } from "react";
import { healthCommitsAvailability, type HealthIndexResponse } from "@waterplane/shared";
import { api } from "./api";
import { useRemoteResource } from "./useRemoteResource";
import { Empty } from "./Empty";
import { HealthIndexChart } from "./HealthIndexChart";
import type { IndexTrendWeek, IndexVsSubject, IndexWeekSubject } from "./setupRemedy";
import type { HealthAxisMode } from "./healthIndexWords";

/**
 * `onAsk` is a slot for the week's subject rather than a send path, as
 * `SeriesTile`'s `actions` is: the chart paints and words, and the sheet
 * decides what a prompt is and where it goes. Absent = no button at all.
 */
export function HealthIndexSection({ repoId, onAsk, onAskTrend, onQualityRun, axis, onCommits, seriesStamp }: {
  repoId: string;
  /** Changes whenever the series the index is computed from does (last sha + row count). */
  seriesStamp?: string;
  /** The region's x-axis choice, drawn as given (`HealthIndexChart`'s `axis`). */
  axis?: HealthAxisMode;
  onAsk?: (w: IndexWeekSubject, vs: IndexVsSubject | null) => void;
  onAskTrend?: (weeks: IndexTrendWeek[], baselineWeek: string, vs: IndexVsSubject | null) => void;
  onQualityRun?: () => void;
  /** Whether this host sends the per-commit series, reported up so the region's
   *  x-axis row offers `commits` only where it exists — read from this one
   *  fetch rather than a second read of the same document. Null until it is in. */
  onCommits?: (avail: ReturnType<typeof healthCommitsAvailability> | null) => void;
}) {
  const res = useRemoteResource<HealthIndexResponse>(
    `healthindex:${repoId}`, () => api.healthIndex(repoId), { enabled: !!repoId });
  // The index is derived from the series the region above re-reads: when that moves (a refresh,
  // a host run), read the index again — else a first run leaves "no series yet" under its rows.
  const { reload } = res;
  const seen = useRef(seriesStamp);
  useEffect(() => {
    if (seen.current === seriesStamp) return;
    seen.current = seriesStamp;
    reload({ quiet: true });
  }, [seriesStamp, reload]);
  const view = res.data;
  const avail = view ? healthCommitsAvailability(view) : null;
  useEffect(() => { onCommits?.(avail); }, [avail, onCommits]);
  return (
    <HealthIndexChart view={view} onAsk={onAsk} onAskTrend={onAskTrend} onQualityRun={onQualityRun} axis={axis} empty={
      <Empty res={res} empty={!view?.series} thing="the health index" noun="index">
        {view?.reason ?? "No health index yet: it starts at the first week every one of its five readings exists."}
      </Empty>
    } />
  );
}
