/**
 * The top of the scroll: verdict counts, the guide, the run's detail and watch panel, the empty states, the refused notes.
 * Part of `AssessSheet.tsx`, the facade every caller imports; map and rules: docs/notes/assess-architecture.md.
 */
import { AlertTriangle, ChevronDown, ChevronUp, Loader } from "lucide-react";
import { ASSESS_VERDICTS, assessVerdictLabel } from "@waterplane/shared";
import { Empty } from "../Empty";
import { track } from "../usage";
import { ICON, VERDICT_TAG } from "./asxConst";
import { RunLog } from "./AsxParts";
import type { AssessModel } from "./useAssessSheet";
import { Button, Hint } from "../kit";

export function AsxTop({ m }: { m: AssessModel }) {
  const { p, run, proposal, counts, watch, guideOpen, setGuideOpen, res, nothing, guide } = m;
  return (
    <>
      {/* The summary: every verdict including the zeros, because on a screen
          whose job is to prove nothing was lost, a count that disappears when
          it empties makes the list look like it dropped rows. First thing in
          the scroll rather than pinned above it — see the note on the return. */}
      {counts ? (
        <div className="act-filters">
          {ASSESS_VERDICTS.map((v) => (
            <span key={v} className={VERDICT_TAG[v]}>{assessVerdictLabel(v)} <span className="act-count">{counts[v]}</span></span>
          ))}
        </div>
      ) : null}
      {/* **What this screen is, before the first tap — one line of it, and the
          rest one tap away.**
          The lead says the two things somebody needs before their first tap and
          is always drawn: this is a proposal, and nothing here builds, runs or
          sends anything. What each verb does is four paragraphs, and four
          paragraphs is the state this screen was last found in — a wall between
          a person and the words they came to decide about. So the bullets are
          behind the disclosure and it is SHUT: open-when-nothing-is-ticked
          meant open in exactly the state everybody lands in.
          The chevron is the same shape every strip on this sheet collapses
          with; the words are `assessRows.ts`'s. */}
      {run ? (
        <div className="assess-intro">
          {m.slotIntro ? <div className="assess-guide-lead">{m.slotIntro}</div> : null}
          <div className="assess-guide-lead">{guide.lead}</div>
          <div className="act-group-head">
            <Button title={guideOpen ? "hide this" : "what accepting and applying on this screen actually do"}
              onClick={() => { track("action:assess.guide"); setGuideOpen((v) => !v); }}>
              {guideOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />} how this works
            </Button>
          </div>
          {guideOpen ? (
            <ul className="assess-guide">
              {guide.lines.map((l, i) => <li key={i}>{l}</li>)}
            </ul>
          ) : null}
        </div>
      ) : null}
      {/* The host's own one-line summary of the run, verbatim — it is built from
          the proposal's counts, so the row and this screen cannot disagree. */}
      {run?.detail ? <Hint tone={run.status === "failed" ? "warn" : undefined}>{run.detail}</Hint> : null}
      {run?.status === "failed" && run.envelope
        ? <div className="hist-out mono">{run.envelope}</div>
        : null}
      {/* **What it is doing, while it does it.** Every fact here came off the
          CLI's own stream through `AssessProgress`; nothing is inferred, and a
          host that sends no progress falls back to the sentence below with the
          screen otherwise unchanged. It decides nothing: the verdicts are still
          only ever the proposal's. */}
      {watch ? (
        <div className="assess-watch">
          <div className="assess-doing">
            <Loader size={ICON} className="spin" />
            <span>{watch.doing}</span>
          </div>
          <div className="act-triage">
            <span className="act-count">{watch.elapsed}</span>
            {watch.counts ? <span className="act-count">{watch.counts}</span> : null}
            {run?.progress?.model ? <span className="act-count">{run.progress.model}</span> : null}
            {/* Said as an AGE, never as a verdict: a long command and a wedged
                run look identical from here, and only one of them is worth
                telling somebody about — which one is theirs to decide. */}
            {watch.quiet ? <span className="act-count warn">{watch.quiet}</span> : null}
          </div>
          {watch.say ? <Hint className="assess-say">{watch.say}</Hint> : null}
          <RunLog steps={run?.progress?.tail ?? []} />
        </div>
      ) : null}

      {!p.online ? (
        <Hint tone="warn">
          No connection — this is the last proposal this phone was told about. Applying starts work on the
          desktop, so it waits for the link; nothing here expires while it is down.
        </Hint>
      ) : null}

      <Empty res={res} empty={nothing} thing="the assessment" noun="proposal">
        {run == null
          ? `Nothing has been assessed in ${p.repoName} yet. An assessment reads the repo and says, of everything still open here, what is already done, what no longer applies, what is covered elsewhere and what is still worth doing — with evidence, and nothing is applied until you approve it.`
          : run.status === "running"
            ? "The assessment is reading the repo — what it is doing is above. It leaves a proposal here when it finishes; you can close this and come back."
            : run.status === "failed"
              ? "The run did not produce a proposal, so nothing was decided and nothing was touched."
              : "The run came back with nothing to decide — there was nothing still open in this repo."}
      </Empty>

      {proposal && proposal.notes.length ? (
        <>
          <div className="section section-head">
            <span>what the app refused</span>
            <span className="section-hint">shown, not swallowed — a dropped group and a group nobody proposed look identical otherwise</span>
          </div>
          <div className="list">
            {proposal.notes.map((n, i) => (
              <div key={i} className="act-verdict"><AlertTriangle size={11} /> {n}</div>
            ))}
          </div>
        </>
      ) : null}
    </>
  );
}
