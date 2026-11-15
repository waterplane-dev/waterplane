/**
 * What a screen reading through `slowJobs.ts` says about its run, beside the age line `Empty`
 * already draws: that a run is going (and since when, and how far where the host counts), that the
 * newest one failed, or why a start was refused. Nothing when there is nothing to say.
 */
import { Hint } from "./kit";
import { CantInline } from "./Unavailable";
import { failedWords, runningWords } from "./slowJobsLogic";
import type { SlowJob } from "@waterplane/shared";

export function SlowJobLine({ res, what }: { res: { job: SlowJob | null; data: unknown; refusal: string | null }; what: string }) {
  const run = res.job;
  return (
    <>
      {res.refusal && <CantInline>{res.refusal}</CantInline>}
      {run && run.state === "running" && <Hint>{runningWords(what, run, Date.now())}</Hint>}
      {run && run.state === "failed" && <Hint tone="warn">{failedWords(what, run, res.data !== null)}</Hint>}
    </>
  );
}
