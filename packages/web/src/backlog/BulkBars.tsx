/**
 * The bars that act on the cut on screen (re-time many and name these are
 * `PickBars`, above the list): the focus sentence (is this cut going to run?),
 * drop the clocks, run these again, archive the done. Each count is the cut on
 * screen; one tap is one receipt.
 *
 * Every verb here is a `.link-btn` on ONE left edge (`.bl-bulk`, the chips'
 * own edge above it): a framed `.key` each, in a panel of its own, read as a
 * row of primary verbs under slim filters, at three different x. The solid
 * fill stays for a sheet's one primary verb, and there is none here.
 *
 * A REGION of the backlog sheet: no hooks of its own (a child's effects run
 * before its parent's, so a hook here would reorder them), only the model.
 * Shape: docs/notes/backlog-architecture.md.
 */
import type { ReactNode } from "react";
import { AlarmClockOff, Archive, CircleDot, RotateCcw } from "lucide-react";
import { ConfirmButton } from "../Confirm";
import { Explain } from "../Explain";
import {
  archiveDoneLabel, archiveDoneNote, dropClockNote, dropClocksLabel, dropClocksNote, FOCUS_AUTO_ON_LABEL,
  FOCUS_AUTO_ON_TITLE, runAgainLabel, runAgainNote,
} from "../backlogFilter";
import { track } from "../usage";
import type { BacklogModel } from "./backlogTypes";

/** A bar's sentence, then its one verb on the sheet's shared edge (`.bl-bulk`). */
function Bar({ note, children }: { note: ReactNode; children: ReactNode }) {
  return (
    <div className="bl-bulk-bar">
      <div className="form-hint">{note}</div>
      <div className="bl-bulk">{children}</div>
    </div>
  );
}

export function BulkBars({ m }: { m: BacklogModel }) {
  const {
    bulkClockIds, bulkDoneIds, bulkRunAgainAimed, bulkRunAgainIds, cut, focusWords, p, runAgainOffered,
  } = m;
  return (
    <>
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
        <div className="bl-bulk-bar"><div className="form-hint">
          <Explain of="when these run" label="when do these run?">{focusWords}</Explain>
        </div></div>
      )}
      {focusWords && !p.auto && (
        <Bar note={focusWords}>
          <button className="link-btn" title={FOCUS_AUTO_ON_TITLE}
            onClick={() => { track("action:backlog.auto.focus"); p.cutVerbs.onSetAuto(true); }}>
            <CircleDot size={14} /> {FOCUS_AUTO_ON_LABEL}
          </button>
        </Bar>
      )}
      {/* The bulk answer to seven skipped one-offs. `ConfirmButton` and never
          `window.confirm` — a native modal blocks the WebView's event loop —
          and never a confirm on top of a per-row undo either: there is no undo
          for this one, which is exactly why it asks once. Armed, the link goes
          `danger` red. */}
      {bulkClockIds.length > 1 && p.online && (
        <Bar note={dropClocksNote(bulkClockIds.length, cut.length)}>
          <ConfirmButton
            className="link-btn"
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
        </Bar>
      )}
      {/* The other half of the same cut, and the bulk answer to nineteen failed
          rows: put them back where the queue — and therefore auto and the smart
          pick — can see them. `ConfirmButton` for its twin's reason (this one
          starts real work later, and there is no undo but the archive), and
          deliberately NOT gated on `p.online`: `intent.requeue` is durable, the
          host refuses it on any row that is no longer failed, and a greyed
          button whose reason lives in a `title` is invisible on a phone. */}
      {bulkRunAgainIds.length > 1 && (
        <Bar note={runAgainNote(bulkRunAgainIds.length, cut.length, bulkRunAgainAimed)}>
          <ConfirmButton
            className="link-btn"
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
        </Bar>
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
        <Bar note={archiveDoneNote(bulkDoneIds.length, cut.length)}>
          <ConfirmButton
            className="link-btn"
            confirm={`archive all ${bulkDoneIds.length}?`}
            title="they keep their words and stay in show archived — any one of them comes back from its own row"
            onConfirm={() => {
              track("action:backlog.archive.done");
              p.cutVerbs.onArchiveMany(bulkDoneIds);
            }}>
            <Archive size={14} /> {archiveDoneLabel(bulkDoneIds.length)}
          </ConfirmButton>
        </Bar>
      )}
    </>
  );
}
