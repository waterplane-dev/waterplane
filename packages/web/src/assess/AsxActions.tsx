/**
 * The sheet's verbs: read the plan, discard, run.
 * Part of `AssessSheet.tsx`, the facade every caller imports; map and rules: docs/notes/assess-architecture.md.
 */
import { FileText, Play, Settings2, Trash2 } from "lucide-react";
import { ConfirmButton } from "../Confirm";
import { Unavailable } from "../Unavailable";
import { track } from "../usage";
import { openSettingsAt } from "../settingsFocus";
import { ICON } from "./asxConst";
import type { AssessModel } from "./useAssessSheet";

export function AsxActions({ m }: { m: AssessModel }) {
  const { p, run, proposal, runBlocked, scopeN, planPath, runLabel } = m;
  return (
    <>
      {/* **`read the plan`, not `plan`.** One word on a screen whose every
          other verb performs something reads as an instruction to go and make
          one; this says what the tap does and, in the title, everything it
          does not — because the reason somebody does not open the write-up
          that would settle the whole page is the suspicion that opening it
          starts an agent, or loses the ticks they have made. It does neither. */}
      {planPath && p.onOpenPlan ? (
        <button className="key"
          title={`open ${planPath}, the write-up the run left for you — for reading; it does not run anything, and your ticks are kept`}
          onClick={() => { track("action:assess.plan"); p.onOpenPlan?.(planPath); }}>
          <FileText size={ICON} /> read the plan
        </button>
      ) : null}
      {proposal && p.onDiscard ? (
        <ConfirmButton className="key" title="throw this proposal away without applying any of it"
          confirm="discard it?" confirmTitle="nothing is applied, and the items keep their words"
          onConfirm={() => { track("action:assess.discard"); p.onDiscard?.(); }}>
          <Trash2 size={ICON} /> discard
        </ConfirmButton>
      ) : null}
      {/* The label says the SCOPE, because the scope is the difference
          between this tap and the one that would read sixty-two rows. A
          scoped re-run over an unscoped proposal is the case this matters in:
          the screen is full of verdicts about the whole repo and the button
          is about to answer a narrower question. */}
      {runBlocked
        ? <>
            <Unavailable cants={[{ label: runLabel, reason: runBlocked }]} />
            {/* The budget is the one blocker a person can change from here. */}
            {p.budgetNote && runBlocked === p.budgetNote && (
              <button className="key" onClick={() => openSettingsAt("budget")}>
                <Settings2 size={ICON} /> change the usage budget
              </button>
            )}
          </>
        : (
          <button className="key"
            title={scopeN
              ? `judge ${scopeN === 1 ? "the one row" : `the ${scopeN} rows`} you came here with — it still reads ${p.repoName} as evidence`
              : run ? `read ${p.repoName} again and judge what is left now` : `read ${p.repoName} and judge what is left`}
            onClick={() => { track("action:assess.run"); p.onRun(); }}>
            {/* Always `Play`, never a spinner. A running run is the FIRST
                thing `assessRunBlocker` refuses on, so this button does not
                exist while one is going — the `Unavailable` sentence above is
                what is drawn instead, and the spinner branch here could not
                reach the screen. What a running run looks like is the watch
                panel, which has the spinner, the elapsed clock and the steps
                as they arrive. */}
            <Play size={ICON} /> {runLabel}
          </button>
        )}
    </>
  );
}
