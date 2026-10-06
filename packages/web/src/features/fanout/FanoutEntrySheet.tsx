/**
 * The `fanout` sheet, wired: `FanoutSheet.tsx` (unchanged) handed the repos,
 * the runs rebuilt from `intents`, and the queue verbs in `actions.ts`.
 */
import { fanoutRuns } from "@waterplane/shared";
import { useMemo } from "react";
import { useCore } from "../../sdk";
import { FanoutSheet } from "../../FanoutSheet";
import { followUpFanout, openFanoutSession, runFanout, scheduleFanout } from "./actions";

export function FanoutEntrySheet() {
  const core = useCore();
  const { intents, visibleRepos } = core.world;
  // A sweep is rows sharing a `groupId` in `intents`, and `fanoutRuns`
  // rebuilds each run from them — there is no separate run list to keep.
  const runs = useMemo(() => fanoutRuns(intents), [intents]);
  return <FanoutSheet
    repos={visibleRepos}
    runs={runs}
    online={core.conn.status === "open"}
    onRun={runFanout}
    onFollowUp={followUpFanout}
    onSchedule={scheduleFanout}
    onOpen={openFanoutSession}
    onClose={() => core.nav.close("fanout")}
  />;
}
