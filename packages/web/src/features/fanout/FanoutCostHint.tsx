/**
 * The line under the fan-out prompt: what the last similar sweep cost. Reads
 * the runs from core itself so `FanoutSheet` takes no new data props. Words
 * only, a reading and never a gate — absent (null) offline, on an older host,
 * or when that run's sessions are not in this desktop's logs.
 *
 * The run is `pickSimilarRun`; its dollars are the desktop's fold of the CLI's
 * logs over the run's span, grouped by launch (the host's `runId` for a sweep IS
 * `FanoutRun.id`). "≈ N% of week" is left out: it needs `useWeekUsdPerPct` from
 * `features/tokens`, and `local/feature-boundary` refuses a feature importing a
 * feature; `fanoutHintText` omits the clause on a null `weekPct`.
 */
import { History } from "lucide-react";
import { useMemo } from "react";
import { fanoutRuns, HOUR_MS, pickSimilarRun } from "@waterplane/shared";
import type { CostWindowDoc, FanoutRun } from "@waterplane/shared";
import { fanoutCostWords } from "./logic";
import { ledgers, useCore } from "../../sdk";
import { useRemoteResource, type ResourceState } from "../../useRemoteResource";

/** A sweep's sessions open a moment after `startedAt`; five minutes of lead is slack, not scope. */
const LEAD_MS = 5 * 60_000;

function useFanoutCostHint(runs: FanoutRun[], text: string, online: boolean): { text: string | null; state: ResourceState } {
  const run = useMemo(() => pickSimilarRun(runs, text), [runs, text]);
  const res = useRemoteResource<CostWindowDoc | null>(
    `fanoutcost:${run?.id ?? "none"}`,
    async () => {
      if (!run) return null;
      return ledgers.costWindow(run.startedAt - LEAD_MS, (run.finishedAt ?? Date.now()) + HOUR_MS);
    },
    { enabled: !!run, offline: !online },
  );
  const words = useMemo(
    () => (run && res.data ? fanoutCostWords(res.data, run, text) : null),
    [run, res.data, text],
  );
  return { text: words, state: res.state };
}

export function FanoutCostHint({ text }: { text: string }) {
  const core = useCore();
  const runs = useMemo(() => fanoutRuns(core.world.intents), [core.world.intents]);
  const h = useFanoutCostHint(runs, text, core.conn.status === "open");
  if (!h.text) return null;
  return (
    <div className="empty ts-caveat" title="Read off the desktop's logs for that run. A reading, not a limit: Run still runs.">
      <History size={13} /> {h.text}
    </div>
  );
}
