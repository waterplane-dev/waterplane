/**
 * What the run looked at, then the two answers.
 * Part of `AssessSheet.tsx`, the facade every caller imports; map and rules: docs/notes/assess-architecture.md.
 */
import { ChevronDown, ChevronUp } from "lucide-react";
import { assessStepCounts } from "../assessRows";
import { track } from "../usage";
import { RunLog } from "./AsxParts";
import { AsxAsks } from "./AsxAsks";
import type { AssessModel } from "./useAssessSheet";
import { Button } from "../kit/Button";

export function AsxTail({ m }: { m: AssessModel }) {
  const { logOpen, setLogOpen, pastSteps } = m;
  return (
    <>
      {/* The same list, for a run that has finished: the stream is gone by the
          time anybody reads a proposal and wonders what it looked at. Shut by
          default — it is evidence, not the decision. */}
      {pastSteps && pastSteps.tail.length ? (
        <>
          <div className="section section-head">
            <span>what it looked at</span>
            {/* **The label is what the tap OPENS**, out of what there was. It
                said `212 steps` and opened twenty-four of them, with "the last
                24 of 212" in the `title` — invisible on a phone, so what a
                person met was a count that did not match the list behind it.
                The live panel's chip and this label are now one call on the
                same two numbers (`assessStepCounts`), so they cannot disagree
                about either. */}
            <Button title={logOpen ? "collapse this" : "show these"}
              onClick={() => { track("action:assess.log"); setLogOpen((v) => !v); }}>
              {logOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />} {assessStepCounts(pastSteps.steps, pastSteps.tail.length).button}
            </Button>
          </div>
          {logOpen ? <RunLog steps={pastSteps.tail} /> : null}
        </>
      ) : null}

      {/* The two questions this apply asks, last in the scroll and immediately
          above the bar that holds Apply — see `asks` for why they are not IN
          that bar. */}
      <AsxAsks m={m} />
    </>
  );
}
