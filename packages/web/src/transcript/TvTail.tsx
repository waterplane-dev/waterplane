import { CloudOff, HelpCircle, Square, Terminal as TerminalIcon } from "lucide-react";
import { PromptAnswer } from "../PromptAnswer";
import { ConfirmButton } from "../Confirm";
import { track } from "../usage";
import type { TvModel } from "./useTranscriptView";

/** What follows the last turn: the open question, or the turn still in flight. */
export function TvTail({ m }: { m: TvModel }) {
  const { asking, status, onAnswer, queuedAnswers, onShowCli, busy, stale, elapsed, work, onStop } = m;
  return (
    <>
      {/* The CLI is asking something. The conversation log knows nothing about a
          TUI dialog, so without this the reader's last word is whatever the
          assistant wrote before it opened the box — i.e. it reads as "working"
          forever. Rendered at the tail (where a reader following along is
          looking) and scrolled to once when it appears. */}
      {asking && (
        <div className="tr-ask" id="tr-ask">
          <div className="tr-ask-head"><HelpCircle size={14} /> waiting for your answer</div>
          {status?.prompt && onAnswer
            ? <PromptAnswer
                prompt={status.prompt}
                queued={queuedAnswers ?? []}
                suggestion={status.suggestion}
                onAnswer={onAnswer}
                ev="prompt"
              />
            : status?.prompt
            ? <>
                {/* No `onAnswer` prop: this build's caller cannot queue an
                    answer, so the options are READ, never tapped. Deliberately
                    not buttons that toast — a control that cannot act is not a
                    control (`Unavailable.tsx`). */}
                <div className="tr-ask-q">{status.prompt.ask || status.prompt.question}</div>
                <div className="tr-ask-opts">
                  {status.prompt.options.map((o) => (
                    <span className="tr-ask-opt" key={o.index}>{o.index}. {o.label}</span>
                  ))}
                </div>
                <div className="row-sub">answer it in the CLI — press the option's number</div>
              </>
            : status?.asking
            ? <>
                {/* The agent's own closing line. There is no keystroke that
                    means anything here — the reply is prose — so the only
                    control is the one that opens a place to type it. */}
                <div className="tr-ask-q">{status.asking.text}</div>
                <div className="row-sub">the turn ended on this — nothing is running, it is waiting for your reply</div>
                <button className="key" onClick={() => { track("action:read.toCli"); onShowCli(); }}>
                  <TerminalIcon size={13} /> open the CLI
                </button>
              </>
            : <>
                <div className="tr-ask-q">A dialog is open in the CLI that has no one-tap buttons here.</div>
                <button className="key" onClick={() => { track("action:read.toCli"); onShowCli(); }}>
                  <TerminalIcon size={13} /> open the CLI
                </button>
              </>}
        </div>
      )}
      {busy && !asking && (
        // "output appears here as claude writes it" is a promise this card
        // cannot keep with the socket down — nothing is arriving, and the
        // elapsed counter is measuring the tunnel, not the turn.
        <div className={`tr-turn tr-inflight${stale ? " tr-linkdown" : ""}`}>
          {stale ? <CloudOff size={13} /> : <span className="tr-live-dot" />}
          <span className="tr-live-what">
            {stale ? "was working" : "working"}{elapsed ? ` · ${elapsed}` : ""}
          </span>
          {work
            ? <span className="tr-live-line">{work.text}</span>
            : <span className="row-sub">
                {stale
                  ? "no connection — nothing new can arrive until the link is back"
                  : "output appears here as claude writes it"}
              </span>}
          {/* Two taps (ConfirmButton): it sits on the bottom edge beside the
              composer, and a stray tap there must not throw away a turn.
              Not drawn with the link down — the key could not arrive. */}
          {onStop && !stale && (
            <ConfirmButton className="key tr-stop" confirm="stop?" aria-label="stop the running turn"
              onConfirm={() => { track("action:read.stop"); onStop(); }}>
              <Square size={12} /> stop
            </ConfirmButton>
          )}
        </div>
      )}
    </>
  );
}
