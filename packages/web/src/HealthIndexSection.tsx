/**
 * "Health index" — the top section of the repo readings' series region: the
 * host's `healthindex` answer, fetched, drawn by `HealthIndexChart.tsx`.
 */
import type { HealthIndexResponse } from "@waterplane/shared";
import { api } from "./api";
import { useRemoteResource } from "./useRemoteResource";
import { Empty } from "./Empty";
import { HealthIndexChart } from "./HealthIndexChart";
import type { IndexTrendWeek, IndexVsSubject, IndexWeekSubject } from "./setupRemedy";

/**
 * `onAsk` is a slot for the week's subject rather than a send path, as
 * `SeriesTile`'s `actions` is: the chart paints and words, and the sheet
 * decides what a prompt is and where it goes. Absent = no button at all.
 */
export function HealthIndexSection({ repoId, onAsk, onAskTrend }: {
  repoId: string;
  onAsk?: (w: IndexWeekSubject, vs: IndexVsSubject | null) => void;
  onAskTrend?: (weeks: IndexTrendWeek[], baselineWeek: string, vs: IndexVsSubject | null) => void;
}) {
  const res = useRemoteResource<HealthIndexResponse>(
    `healthindex:${repoId}`, () => api.healthIndex(repoId), { enabled: !!repoId });
  const view = res.data;
  return (
    <HealthIndexChart view={view} onAsk={onAsk} onAskTrend={onAskTrend} empty={
      <Empty res={res} empty={!view?.series} thing="the health index" noun="index">
        {view?.reason ?? "No health index yet: it starts at the first week every one of its five readings exists."}
      </Empty>
    } />
  );
}
