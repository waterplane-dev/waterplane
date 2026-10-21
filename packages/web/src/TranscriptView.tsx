import { AlertTriangle } from "lucide-react";
import { Empty } from "./Empty";
import { newestTs, writeSeen } from "./transcriptUtil";
import { PAGE } from "./transcript/tvRows";
import { TvFindBar } from "./transcript/TvFindBar";
import { TvStrips } from "./transcript/TvStrips";
import { TvOutline } from "./transcript/TvOutline";
import { TvTurn } from "./transcript/TvTurn";
import { TvTail } from "./transcript/TvTail";
import { useTranscriptView } from "./transcript/useTranscriptView";
import type { TranscriptViewProps } from "./transcript/tvTypes";
import { Button } from "./kit/Button";

export type { TranscriptStatus } from "./transcript/tvTypes";

/**
 * Reader view of a conversation — the scrollable, searchable, tappable
 * alternative to the xterm terminal.
 *
 * Fed by /api/transcript, which parses the claude CLI's own conversation log
 * (see host/src/transcript.ts). Because it's plain DOM: native momentum
 * scrolling, native text selection, real links, and a find that can jump
 * between hits — none of which a terminal grid gives you on a phone. The
 * outline turns a long session into something skimmable: one row per turn with
 * the prompt, a heuristic summary, and what it touched.
 */
export function TranscriptView(props: TranscriptViewProps) {
  const m = useTranscriptView(props);
  const {
    bodyRef, stickRef, seenRef, turnsRef, noteRead, seenMark, setSeenMark, sessionId, loading, doc, probing, err, onShowCli,
    emptyNow, cliPeek, peek, setPeek, turns, shown, setLimit,
  } = m;
  return (
    <div className="tr">
      <TvFindBar m={m} />
      <TvStrips m={m} />
      <TvOutline m={m} />

    <div
      className="tr-body"
      ref={bodyRef}
      onScroll={(e) => {
        const el = e.currentTarget;
        const atEnd = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        stickRef.current = atEnd;
        // Scrolling down to the tail IS reading what was new, so the mark
        // follows there and then. Otherwise the count sat at "4 new" over
        // turns already scrolled past, until the next turn landed or the
        // explicit button was found. Guarded on the mark actually MOVING, so
        // the frames a scroll fires write once and an idle scroll writes
        // nothing.
        if (atEnd && seenRef.current === sessionId) {
          const m = newestTs(turnsRef.current);
          if (m && m > seenMark) { writeSeen(sessionId, m); setSeenMark(m); }
        } else noteRead();
      }}
    >
      {/* Only once the cache has been ASKED and had nothing. Before this the
          spinner raced a 12 s fetch fuse over a document that was already on
          the phone, which is how a reader with a perfectly good saved copy
          showed a black screen and the word "loading" — see `probing`. */}
      {loading && !doc && !probing && <Empty>Reading the transcript…</Empty>}
      {err && !doc && (
        <Empty>
          <AlertTriangle size={14} /> {err}
          {/* The CLI view keeps its own persisted scrollback (App.tsx
              savePtyTail), so it is not an empty gesture: with no cached
              transcript it is the only saved output there is. */}
          {onShowCli && <div><Button onClick={onShowCli}>open the CLI (saved output)</Button></div>}
        </Empty>
      )}
      {emptyNow && !(cliPeek && peek !== "gone") && <Empty>No turns recorded yet.</Empty>}
      {cliPeek && ((emptyNow && peek !== "gone") || peek === "shown" || peek === "leaving") && cliPeek(peek === "leaving", () => setPeek("gone"))}
      {turns.length > shown.length && (
        <button className="tr-more" onClick={() => setLimit((n) => n + PAGE * 2)}>
          load {Math.min(PAGE * 2, turns.length - shown.length)} earlier turns ({turns.length - shown.length} hidden)
        </button>
      )}
        {shown.map((t) => <TvTurn key={t.id} m={m} t={t} />)}
        <TvTail m={m} />
      </div>
    </div>
  );
}
