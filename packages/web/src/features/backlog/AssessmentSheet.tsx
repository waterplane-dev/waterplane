/**
 * The `assess` overlay: `AssessSheet.tsx` (the assessment as a diff a person
 * approves — nothing applies itself) wired to this feature's stores and the
 * core. The sheet is the backlog's grooming, which is why it lives here: the
 * backlog opens it and it cuts the backlog.
 */
import type { RepoTarget } from "@waterplane/shared";
import { budgetReasonText } from "@waterplane/shared";
import { AssessSheet } from "../../AssessSheet";
import { useCore, useQueueEntries, useStore } from "../../sdk";
import { assessBusy, assessRuns, assessScope, backlog } from "./store";
import { applyAssessment, closeAssess, openBacklogCut, runAssessment } from "./actions";

export function AssessmentSheet({ repo }: { repo: RepoTarget }) {
  const core = useCore();
  const { liveSend } = core.conn;
  const { budget } = core.world;
  const dir = repo.worktreePath;
  const run = useStore(assessRuns).get(dir) ?? null;
  const busy = useStore(assessBusy);
  const scope = useStore(assessScope);
  const items = useStore(backlog).items;
  const outbox = useQueueEntries();
  return <AssessSheet
    repoDir={dir}
    repoName={repo.repoName}
    // The repo the rows are ABOUT, by id — a row's words may name a file, and
    // drawing it needs the id the artifact routes are keyed on. `outbox` is the
    // send queue, handed over so an `AttachStrip` shows what is queued against
    // a file as well as what is on disk.
    repoId={repo.id}
    outbox={outbox}
    run={run}
    online={core.conn.status === "open"}
    busy={busy.size > 0}
    // The host's own sentence, verbatim — the budget is the host's rule.
    budgetNote={budget?.verdict.blocked ? budgetReasonText(budget.verdict) : null}
    scope={scope}
    onRun={() => runAssessment(dir, scope ?? undefined)}
    // Durable on the wire, live on this side (`applyAssessment`).
    onApply={(choices) => { if (run) applyAssessment(run, choices); }}
    onDiscard={() => liveSend({ t: "assess.discard", runId: run?.runId ?? "" }, "proposal discarded — nothing was applied",
      "no connection — the proposal lives on the desktop")}
    /**
     * *read the plan* OPENS the document — never the composer, where a path
     * reads as an instruction to run one session over the whole plan (the
     * shape `host/src/backlog.ts` retired). `returnTo: "assess"` brings this
     * sheet back; `assessRepo` survives the trip because only this sheet's own
     * close clears it. `mtime` is `run.planMtime` — one path rewritten per run
     * would otherwise paint run A's plan under run B's verdicts; ABSENT passes
     * through as absent, never 0.
     */
    onOpenPlan={(planPath) => core.files.openFileFrom({ repoId: repo.id, relPath: planPath, mtime: run?.planMtime }, "assess")}
    // Where the words actually live: a note is on the pad (focused, so this is
    // an answer rather than a search), a work item is a row in Activity —
    // opened UNCUT: a bare `nav.open` would keep whatever cut Activity was
    // last left on by Back.
    onOpenItem={(item) => {
      if (item.source === "note") { core.nav.openPadAt(item.id); return; }
      core.nav.openActivity();
    }}
    /**
     * **The route from an applied assessment to the list it groomed** — LIVE
     * `backlogItems` scoped to this repo, never `intents` (builds, launches and
     * schedules are `queued` too and are in nobody's backlog).
     */
    backlog={items.filter((it) => it.repoDir === dir)}
    /**
     * **A count on a control is a filter**, across a sheet boundary: the same
     * door the schedule chips use, so the rows that open are the ones counted.
     * It does NOT clear `assessRepo` — the cut is pushed over this sheet's
     * history entry, and Back must come back to the applied sheet.
     */
    onOpenBacklog={(ids, label) => openBacklogCut(dir, ids, label)}
    // The scope goes with the sheet: a cut is the tap, not a setting.
    onClose={closeAssess}
  />;
}
