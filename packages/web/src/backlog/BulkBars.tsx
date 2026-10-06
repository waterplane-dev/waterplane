/**
 * The bars that act on the cut on screen: re-time many, the focus sentence
 * (is this cut going to run?), drop the clocks, run these again, archive the
 * done, name these. Each count is the cut on screen; one tap is one receipt.
 *
 * A REGION of the backlog sheet: no hooks of its own (a child's effects run
 * before its parent's, so a hook here would reorder them), only the model.
 * Shape: docs/notes/backlog-architecture.md.
 */
import { AlarmClockOff, Archive, CircleDot, ListChecks, RotateCcw, Sparkles } from "lucide-react";
import { ConfirmButton } from "../Confirm";
import { Explain } from "../Explain";
import {
  NAME_COST_NOTE, NAME_RUNNING_NOTE, archiveDoneLabel, archiveDoneNote, dropClockNote, nameLabel, nameNote,
  dropClocksLabel, dropClocksNote, FOCUS_AUTO_ON_LABEL, FOCUS_AUTO_ON_TITLE, runAgainLabel, runAgainNote,
  RETIME_PICK_LABEL,
} from "../backlogFilter";
import { RetimeBar, RetimeLayer } from "../RetimeBar";
import { track } from "../usage";
import { Unavailable } from "../Unavailable";
import type { BacklogModel } from "./backlogTypes";

export function BulkBars({ m }: { m: BacklogModel }) {
  const {
    bulkClockIds, bulkDoneIds, bulkRunAgainAimed, bulkRunAgainIds, choosing, cut, displayOrder, focusWords, nameIds,
    namingHere, p, picking, repoDir, retimeable, retimeIds, runAgainOffered, setChoosing, setPicked, setPicking,
  } = m;
  return (
    <>
      {/* **Re-time many at once.** A pick list over the rows ON SCREEN, one new
          instant, one tap, one receipt. Every per-row path to a new time is the
          Send sheet, one row at a time; eight rows waiting for the same reset
          that should all move to tomorrow morning was eight trips through it.

          The count on the button IS the ticked-and-eligible set on screen
          (`retimeIds`), rows that cannot move draw no box and the note says so
          in text, and with nothing ticked or a time already gone the button is
          ABSENT and a sentence stands where it would be — never a dimmed one.
          Live-only like every bulk bar here: a clock decision replayed an hour
          late is about an instant that may have arrived. */}
      {p.online && !picking && retimeable.length > 1 && (
        <div className="annot-tools wrap bl-filters">
          <button className="key" title="tick several rows and move them all to one new time"
            onClick={() => { track("action:backlog.retime.pick"); setPicking(true); }}>
            <ListChecks size={14} /> {RETIME_PICK_LABEL}
          </button>
        </div>
      )}
      {p.online && picking && (
        <RetimeBar picked={retimeIds.length} eligible={retimeable.length} shown={displayOrder.length}
          where="backlog"
          onAll={() => setPicked(new Set(retimeable.map((it) => it.id)))}
          onNone={() => setPicked(new Set())}
          onDone={() => { setPicking(false); setPicked(new Set()); }}
          onChoose={() => setChoosing(true)} />
      )}
      {choosing && retimeIds.length > 0 && (
        <RetimeLayer>{p.nav.renderRetime(retimeIds, {
          onSent: () => { setChoosing(false); setPicking(false); setPicked(new Set()); },
          onCancel: () => setChoosing(false),
        })}</RetimeLayer>
      )}
      {/* **Is the cut on screen going to run?** — the question somebody arrives
          at an ids cut holding, having just decided something somewhere else
          (an assessment applied, a merge approved, a schedule's row followed).

          It describes what ALREADY happens and starts nothing — the per-row
          `fire` buttons are untouched and there is still no batch runner on this
          side — and it describes it off `focusBreakdown`, never off the count.
          Each clause is drawn only for rows it is true of: *a session of its
          own* for a fresh row, *in &lt;session&gt;* for an aimed one, *one at a
          time in this repo* only where nothing is aimed, and the order only
          where the list on screen IS the order. With nothing in the cut going
          to start it says nothing at all, which `merged from 3` — three
          archived originals — is the case for.

          Auto ON it is reassurance, behind a `?`. Auto OFF it is the reason,
          drawn, with the head chip's own `onSetAuto` beside it. */}
      {focusWords && p.auto && (
        <div className="form"><div className="form-hint">
          <Explain of="when these run" label="when do these run?">{focusWords}</Explain>
        </div></div>
      )}
      {focusWords && !p.auto && (
        <div className="form"><div className="form-hint">
          {focusWords}
          <div className="annot-tools" style={{ marginTop: 6 }}>
            <button className="key" title={FOCUS_AUTO_ON_TITLE}
              onClick={() => { track("action:backlog.auto.focus"); p.cutVerbs.onSetAuto(true); }}>
              <CircleDot size={14} /> {FOCUS_AUTO_ON_LABEL}
            </button>
          </div>
        </div></div>
      )}
      {/* The bulk answer to seven skipped one-offs. `ConfirmButton` and never
          `window.confirm` — a native modal blocks the WebView's event loop —
          and never a confirm on top of a per-row undo either: there is no undo
          for this one, which is exactly why it asks once. */}
      {bulkClockIds.length > 1 && p.online && (
        <div className="form"><div className="form-hint">
          {dropClocksNote(bulkClockIds.length, cut.length)}
          <div className="annot-tools" style={{ marginTop: 6 }}>
            <ConfirmButton
              confirm={`drop all ${bulkClockIds.length}?`}
              title={dropClockNote("failed")}
              onConfirm={() => {
                track("action:backlog.dropclock.all");
                // One call, in the order on screen. The app still sends one
                // `intent.update` per row — the wire has no batch — but the
                // RECEIPT is one sentence carrying the count, because seven
                // identical toasts for one tap is the feed describing a
                // decision seven times and the number never once.
                p.cutVerbs.onDropClocks(bulkClockIds);
              }}>
              <AlarmClockOff size={14} /> {dropClocksLabel(bulkClockIds.length)}
            </ConfirmButton>
          </div>
        </div></div>
      )}
      {/* The other half of the same cut, and the bulk answer to nineteen failed
          rows: put them back where the queue — and therefore auto and the smart
          pick — can see them. `ConfirmButton` for its twin's reason (this one
          starts real work later, and there is no undo but the archive), and
          deliberately NOT gated on `p.online`: `intent.requeue` is durable, the
          host refuses it on any row that is no longer failed, and a greyed
          button whose reason lives in a `title` is invisible on a phone. */}
      {bulkRunAgainIds.length > 1 && (
        <div className="form"><div className="form-hint">
          {runAgainNote(bulkRunAgainIds.length, cut.length, bulkRunAgainAimed)}
          <div className="annot-tools" style={{ marginTop: 6 }}>
            <ConfirmButton
              confirm={`run all ${bulkRunAgainIds.length} again?`}
              // The BULK note, not a row's: the same string in the visible text
              // above and in the title, which is `dropClockNote`'s rule. It used
              // to wear the per-row sentence, so the one place the bar could
              // have said where nineteen rows would land said where ONE would.
              title={runAgainNote(bulkRunAgainIds.length, cut.length, bulkRunAgainAimed)}
              onConfirm={() => {
                track("action:backlog.runagain.all");
                // One call, in the order on screen. The app still sends one
                // `intent.requeue` per row — the wire has no batch — but the
                // RECEIPT is one sentence carrying the count.
                //
                // Each row carries the failure the person was LOOKING at
                // (`finishedAt`, which is `Intent.settledAt` as the phone was
                // shown it): the host refuses a row that has settled again
                // since, so a frame delivered late is either still the decision
                // that was taken or not applied at all.
                p.cutVerbs.onRunAgainMany(cut.filter((it) => runAgainOffered(it)).map((it) => ({ id: it.id, failedAt: it.finishedAt })));
              }}>
              <RotateCcw size={14} /> {runAgainLabel(bulkRunAgainIds.length)}
            </ConfirmButton>
          </div>
        </div></div>
      )}
      {/* The same bar, one state along: **clearing out the finished.** A repo
          worked for a fortnight carries a `done` row per item, and every one of
          them is a row scrolled past for ever to reach the few still waiting.
          `ConfirmButton` for its twin's reason, though the stakes are the other
          way round — archiving keeps the words and the per-row unarchive keeps
          working, which is what the note says, because somebody who reads
          "archive" as "throw away" will not press it and somebody who presses
          it believing that is owed the truth first. */}
      {bulkDoneIds.length > 1 && p.online && (
        <div className="form"><div className="form-hint">
          {archiveDoneNote(bulkDoneIds.length, cut.length)}
          <div className="annot-tools wrap" style={{ marginTop: 6 }}>
            <ConfirmButton
              confirm={`archive all ${bulkDoneIds.length}?`}
              title="they keep their words and stay in show archived — any one of them comes back from its own row"
              onConfirm={() => {
                track("action:backlog.archive.done");
                p.cutVerbs.onArchiveMany(bulkDoneIds);
              }}>
              <Archive size={14} /> {archiveDoneLabel(bulkDoneIds.length)}
            </ConfirmButton>
          </div>
        </div></div>
      )}
      {/* **The tap that asks for titles and kinds.**
          A hand-written row has neither, and nothing in this app derives one
          for it — so a repo's list is fifty-two first-lines-of-prose and the
          kind chips a line above have nothing to count. This is the only verb
          here that is not behind a `ConfirmButton`, and deliberately: naming
          destroys nothing, never writes over a name somebody typed, and any of
          them is one tap to edit or clear on its own row. A confirm on a
          harmless button is what teaches people to tap through the ones that
          matter.

          Drawn only while the link is up: this sheet's own offline line, above,
          already says every mutation here waits for the connection, and a
          second copy of it under every bulk bar is four sentences for one fact.
          While a pass is running the button is ABSENT and the sentence says why
          — never a dimmed copy of itself, whose reason on a phone lives
          nowhere. */}
      {nameIds.length > 0 && p.online && (
        <div className="form"><div className="form-hint">
          {namingHere ? (
            <Unavailable cants={[{ label: nameLabel(nameIds.length), reason: NAME_RUNNING_NOTE }]} />
          ) : (
            <div className="annot-tools wrap">
              <button className="key" data-hint="backlog.name"
                title={nameNote(nameIds.length, cut.length)}
                onClick={() => { track("action:backlog.name"); p.cutVerbs.onName(repoDir, nameIds); }}>
                <Sparkles size={14} /> {nameLabel(nameIds.length)}
              </button>
              {/* What it does and SPENDS, one tap away beside the button. */}
              <Explain of="naming">
                {nameNote(nameIds.length, cut.length)}
                <div className="bl-cost">{NAME_COST_NOTE}</div>
              </Explain>
            </div>
          )}
        </div></div>
      )}
    </>
  );
}
