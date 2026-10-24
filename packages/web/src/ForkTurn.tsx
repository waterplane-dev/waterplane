/**
 * "Fork from here" and "reset to here" — the reader's two conversation verbs.
 *
 * A session misreads the request at turn 7 and spends an hour down a wrong path.
 * Until now the only moves were to let it finish, interject, or kill it and lose
 * the good half with it. These two put the turn itself back in play: fork
 * BRANCHES (a second session holding the conversation up to just BEFORE that
 * turn, this one left running) and reset REWINDS IN PLACE (the same copy,
 * opened where this session was). "Here" is the start of the tapped turn, so
 * its prompt is what gets taken back (`forkAnchor()` argues why). Both are one durable `session.create` carrying `forkAtTurn`;
 * the host writes the new log (`host/convfork.ts`) and resumes it.
 *
 * Lifted out of `TranscriptView` because it is a self-contained widget and the
 * reader was at the file's line ceiling with the turn renderer, the search, the
 * outline and the status strip already in it. WHERE a tap actually cuts, and
 * what an unavailable verb must say, are `forkAnchor.ts` — pure, so `node
 * --test` pins them without a browser.
 */
import { GitFork, Undo2 } from "lucide-react";
import type { TranscriptDoc, TranscriptTurn } from "@waterplane/shared";
import { anchorNote, forkAnchor, forkBlocker } from "./forkAnchor";
import { Unavailable } from "./Unavailable";
import { track } from "./usage";
import { Button } from "./kit/Button";
import { RowSub } from "./kit/Row";

/** One tap on "fork from here" / "reset to here", as the reader can describe it. */
export interface ForkRequest {
  /** `fork` branches and leaves this session alone; `reset` replaces it. */
  mode: "fork" | "reset";
  /** The conversation being forked — the file the host copies from. */
  sourceId: string;
  /** The ANCHOR's prompt-record uuid — the newest logged turn before the
   *  tapped one. The host keeps everything through this WHOLE turn. */
  turnId: string;
  /** The TAPPED turn's number: the copy ends just before it. Display only, for
   *  the confirm, the toast and the fork's title ("before #N"). */
  n: number;
}

/**
 * The two verbs, wired by App.
 *
 * `online` is a prop rather than something read here for the reason the whole
 * reader exists: this document is happily composed from a CACHED transcript — a
 * turn uuid is stable for ever — but the VERB starts a session on the host, and
 * a reset replayed an hour later kills a session that has since done an hour of
 * work. So the action is disabled and SAYS SO rather than being queued, which is
 * `intent.cancel`'s argument exactly.
 */
export interface ForkCtx {
  online: boolean;
  /** The session names its conversation (`resumeIdOf`); absent = assume so. Said before the tap. */
  hasId?: boolean;
  run: (req: ForkRequest) => void;
}

/**
 * The action row, inline under the turn header it belongs to.
 *
 * Deliberately NOT a nested sheet: the reader is already a full-screen overlay,
 * and a sheet on top of it puts the answer two Backs away from the turn it is
 * about — on a phone that is the difference between an affordance and a menu
 * dive.
 */
export function ForkTurnRow({ doc, turn, fork, onRun }: {
  doc: TranscriptDoc | null;
  turn: TranscriptTurn;
  fork: ForkCtx;
  /** Called after a verb fires, so the reader can close this row. */
  onRun: () => void;
}) {
  const anchor = forkAnchor(doc, turn);
  const why = forkBlocker(doc, turn, fork.online, !!doc?.claudeSessionId || fork.hasId !== false);
  const note = anchor ? anchorNote(turn, anchor) : null;
  const run = (mode: "fork" | "reset") => {
    if (why || !anchor || !doc) return;
    track(`action:read.${mode}`);
    onRun();
    // The ANCHOR's uuid (the host cuts AFTER a turn) with the TAPPED row's
    // number: every word the person reads afterwards says "before #N", which is
    // the same cut named by the row they tapped.
    fork.run({ mode, sourceId: doc.claudeSessionId ?? "", turnId: anchor.turn.id, n: turn.n });
  };
  return (
    <div className="tr-fork">
      {/* A verb that cannot run is not drawn as a control (`Unavailable.tsx`):
          on a phone a dimmed button and a live one differ by an opacity nobody
          can read, and the reason has to be said rather than hovered for. */}
      {why
        ? <Unavailable cants={[
            { label: "fork from here", reason: why },
            { label: "reset to here", reason: why },
          ]} />
        : <div className="tr-fork-acts">
            <Button onClick={() => run("fork")}>
              <GitFork size={12} /> fork from here
            </Button>
            <Button variant="danger" onClick={() => run("reset")}>
              <Undo2 size={12} /> reset to here
            </Button>
          </div>}
      {note && <RowSub as="div">{note}</RowSub>}
      {!why && (
        <RowSub as="div">
          Both take back #{turn.n}: fork opens a second session holding this conversation up to
          just before it (through #{anchor?.turn.n}) and leaves this one running; reset replaces
          this session with that copy. Neither deletes anything: #{turn.n} and the turns after it
          stay on disk under this conversation and stay listed in the archive, and no file in the
          repo is touched.
        </RowSub>
      )}
    </div>
  );
}
