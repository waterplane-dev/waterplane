/**
 * The pinned run status row.
 * Part of `AssessSheet.tsx`, the facade every caller imports; map and rules: docs/notes/assess-architecture.md.
 */
import { assessAppliedWords } from "../assessRows";
import { ago } from "../format";
import { RUN_TAG } from "./asxConst";
import type { AssessModel } from "./useAssessSheet";

export function AsxHead({ m }: { m: AssessModel }) {
  const { run, finishedAt } = m;
  if (!run) return null;
  return (
    <div className="act-triage">
      <span className={RUN_TAG[run.status]}>{run.status}</span>
      {finishedAt ? <span className="act-count">{ago(finishedAt)}</span> : null}
      {run.assessableCount != null
        ? <span className="act-count">{run.assessableCount} judged{run.itemCount != null && run.itemCount > run.assessableCount ? ` · ${run.itemCount - run.assessableCount} read as context` : ""}</span>
        : null}
      {/* **A scoped run says so on its own row.** Without it a proposal
          about seven rows is indistinguishable from one about the repo,
          and the whole screen exists to be trusted about what it looked
          at. Read off the RUN, which carries it from the moment it starts
          — `input` does not exist until it ends, and the twenty minutes
          in between is exactly when somebody is watching to see whether
          it is doing what they asked. */}
      {run.scopedIds?.length
        ? <span className="act-count" title="this run was asked about a cut of the backlog, not the whole repo — it still read the repo as evidence">
          scoped to {run.scopedIds.length === 1 ? "1 row" : `${run.scopedIds.length} rows`}
        </span>
        : null}
      {/* The receipt for an apply that has happened, worded in
          `assessRows.ts` beside the button that promised it. The literal
          that used to be here named three counts, and `requeued` is a
          fourth: a run whose whole effect was to put nineteen dead rows
          back reported itself as having re-sorted nothing. */}
      {run.applied
        ? <span className="act-count">{assessAppliedWords(run.applied)}</span>
        : null}
    </div>
  );
}
