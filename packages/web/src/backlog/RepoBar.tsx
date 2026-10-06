/**
 * The sheet's head (*send…*, *auto*) and the repo bar under it: the repo
 * picker, *assess* with its scope, and the per-repo smart-pick tick.
 *
 * A REGION of the backlog sheet: no hooks of its own (a child's effects run
 * before its parent's, so a hook here would reorder them), only the model.
 * Shape: docs/notes/backlog-architecture.md.
 */
import { Circle, CircleDot, ClipboardCheck, SendHorizontal, Sparkles } from "lucide-react";
import { ASSESS_NONE_IN_CUT, assessScopeLabel, assessScopeNote } from "../backlogFilter";
import { track } from "../usage";
import { RepoSelect } from "../RepoPicker";
import { SheetHead } from "../Sheet";
import type { BacklogModel } from "./backlogTypes";

export function BacklogHead({ m }: { m: BacklogModel }) {
  const { p, repoDir } = m;
  return (
      <SheetHead title={"Backlog"} onClose={p.nav.onClose}>
        {/* The one way to add — the same sheet every other send in this app goes
            through, seeded to this repo and *when it's free*. With no repo it
            is ABSENT rather than dimmed: this sheet is scoped to one repo and
            with none there is nothing here at all, which the empty state below
            already says. A `title` carrying the reason is invisible on a
            phone. */}
        {repoDir && (
          <button className="rc" title="write something for this repo — the send sheet, with the repo already chosen"
            onClick={() => { track("action:backlog.send"); p.nav.onOpenSend(repoDir); }}>
            <SendHorizontal size={14} /> send…
          </button>
        )}
        {/* The global machinery switch. Its label used to carry the idle
            threshold ("auto (10s idle)"), which named the gate it used to be:
            waiting for a shared session to go quiet. Work opens its own session
            now and the ladder decides, so the number described nothing. */}
        <button className={`rc ${p.auto ? "on" : "off"}`} onClick={() => p.cutVerbs.onSetAuto(!p.auto)}>
          {p.auto ? <><CircleDot size={14} /> auto</> : <><Circle size={14} /> auto off</>}
        </button>
      </SheetHead>
  );
}

export function RepoBar({ m }: { m: BacklogModel }) {
  const { assessIds, assessWhyNot, cut, filtering, p, repoCount, repoDir, selectRepo, smartOn } = m;
  return (
    <>
      {/* Repo scope: the backlog belongs to ONE repo at a time. */}
      <div className="form bl-repobar">
        {/* The shared picker (`RepoPicker.tsx`), in its `<select>` shape: the
            repo is one field in a bar that also has the session button, so a
            full-width row list would push the rest of the sheet off screen. */}
        <RepoSelect repos={p.repos} value={repoDir} onChange={selectRepo} aria-label="repo"
          note={(r) => (repoCount(r.worktreePath) ? String(repoCount(r.worktreePath)) : undefined)} />
        {/* *open a session here* is GONE. Its one stated purpose was "somewhere
            to queue items into by hand" — a control that existed to give
            another control a target. With the row verb saying *when <session>
            is free* about the session you are already looking at, there is
            nothing left for it to do that the launcher's own `+` does not, and
            it was the fourth of five buttons in this app meaning "a new session
            in this repo". */}
        {p.cutVerbs.onAssess && repoDir ? (
          // ABSENT, not dimmed. This was a greyed button whose refusal lived in
          // a `title` — invisible on the only device this sheet is used from —
          // in a sheet that already has a banner for exactly this job.
          assessWhyNot ? (
            <span className="form-hint">assess: {assessWhyNot}</span>
          ) : filtering && !assessIds.length ? (
            // ABSENT with the reason in words, never a dimmed button: a cut of
            // finished rows has nothing an assessment can form a verdict about,
            // and a run over it would spend an agent reading a repo to answer a
            // question with no candidates.
            <span className="form-hint">{ASSESS_NONE_IN_CUT}</span>
          ) : (
            <button className="key"
              title={filtering
                ? "judge exactly the open rows in this cut — it still reads the whole repo as evidence, and nothing applies itself"
                : "read this repo and judge what is left in it — with evidence, and nothing applies itself"}
              onClick={() => {
                track("action:backlog.assess");
                // The cut, or nothing at all. `undefined` is what says "the
                // whole repo" all the way down to the payload, so an unfiltered
                // tap is byte-identical to what it always sent.
                p.cutVerbs.onAssess?.(repoDir, filtering ? assessIds : undefined);
              }}>
              <ClipboardCheck size={14} /> {filtering ? assessScopeLabel(assessIds.length) : "assess"}
            </button>
          )
        ) : null}
        {/* **The one control here whose number is not the cut on screen.**
            Every other count in this sheet is a filter; `assess.run` takes a
            repo and nothing else, so with a filter on, the screen says *6 of
            62* directly above a button that means the 62. Said in words, on its
            own line in the bar (`.bl-repobar > .form-hint` is full width), and
            only while a filter is actually on — with none there are no two
            numbers to confuse and the sentence would be chrome. */}
        {p.cutVerbs.onAssess && repoDir && !assessWhyNot && filtering && assessIds.length > 0 && (
          <span className="form-hint">{assessScopeNote(assessIds.length, cut.length)}</span>
        )}
        {/* The per-repo tick. Drawn only when the host said the feature exists
            (`smartPick` present) and only while the socket is up: it is a
            `liveSend` mutation like *auto*, and the sheet's offline sentence
            already says every mutation is read-only — a switch that flips back
            when the next list lands is worse than no switch. Absent rather than
            dimmed with no repo chosen, for the reason `Unavailable.tsx` gives. */}
        {p.smartPick && p.online && repoDir ? (
          <button className={`rc ${smartOn ? "on" : "off"}`} data-hint="backlog.smartpick"
            title={smartOn
              ? "stop looking before each item — the backlog then fires in the order you see"
              : "look over this repo's waiting items before each one starts"}
            onClick={() => { track("action:backlog.smartpick"); p.cutVerbs.onSetSmartPick(repoDir, !smartOn); }}>
            <Sparkles size={14} /> {smartOn ? "smart pick" : "smart pick off"}
          </button>
        ) : null}
      </div>
    </>
  );
}
