import { Clock, Copy, CornerDownRight, FoldVertical, GitFork, Terminal as TerminalIcon, Wrench } from "lucide-react";
import { answeredOnlyInCli, nextTurnText, type TranscriptTurn } from "@waterplane/shared";
import { Markdown } from "../Markdown";
import { CostFold } from "../TurnCostCard";
import { ForkTurnRow } from "../ForkTurn";
import { clock, turnText, turnTs } from "../transcriptUtil";
import { stamp, took } from "../turnWhen";
import { track } from "../usage";
import { TvBlocks } from "./TvBlocks";
import type { TvModel } from "./useTranscriptView";
import { Button, Tag } from "../kit";

/** One turn: its header, the prompt, the notes about how it was sent, its blocks and its foot. */
export function TvTurn({ m, t }: { m: TvModel; t: TranscriptTurn }) {
  const {
    turns, seenMark, newIdx, unread, markRead, copy, fork, forkTurn, setForkTurn, doc, files, q, stillGoing,
    whyTurnId, costLastOpen, costOpen, toggleCost, mixSlotsDoc, agentsSoFar, usdPerWeekPct, weekIncl,
    onOpenCost, nextTurn, onShowCli, today,
  } = m;
          const isNew = seenMark > 0 && turnTs(t) > seenMark;
          const firstNew = isNew && newIdx !== -1 && turns[newIdx]?.id === t.id;
  return (
    <div className={`tr-turn${isNew ? " tr-unread" : ""}`} id={`tr-turn-${t.n}`} key={t.id}>
      {firstNew && (
        <div className="tr-newmark" id="tr-newmark">
          <span>{unread} new since you left</span>
          <Button onClick={markRead}>mark read</Button>
        </div>
      )}
      <div className="tr-turn-head">
        <span className="tr-n">#{t.n}</span>
        <span className="row-sub">{clock(t.sentAt)}</span>
        {/* A command the CLI answered itself. It is not a model turn, and
            a reader that let it pass for one would have the conversation
            claim an answer nobody was billed for. `screen` says more:
            the conversation log has no record of this at all and the
            words were read back off the terminal. */}
        {t.local && (
          <Tag title={t.local === "screen"
            ? "the CLI answered this in the terminal — no conversation-log record exists, so this was read back from the screen capture"
            : "the CLI answered this itself — a local command, no model turn"}>
            <TerminalIcon size={11} /> {t.local === "screen" ? "terminal only" : "local command"}
          </Tag>
        )}
        {/* SENT, NOT STARTED. The TUI holds a prompt typed into a busy
            session until the turn ends, so this row is the app's own record
            of what it typed in and not a turn the CLI has run — it says
            so rather than sitting at the bottom looking like a turn that
            produced nothing. It is replaced by the real turn the moment
            the conversation log takes the prompt. */}
        {t.queued && (
          <Tag title="typed into that session and accepted — the CLI holds a prompt until the turn it is working on ends, so nothing has started it yet">
            <Clock size={11} /> waiting for the CLI
          </Tag>
        )}
        {/* THE OTHER END OF `queued`. The CLI took these words into the
            turn it was already running instead of starting a turn of
            their own, and wrote them to the log as an attachment and
            nowhere else — so the row is exact, but the boundary above it
            is the CLI's decision rather than a prompt-and-answer pair. */}
        {t.absorbed && (
          <Tag title="the CLI took this prompt into the turn it was already running instead of starting a new one">
            <CornerDownRight size={11} /> taken mid-turn
          </Tag>
        )}
        {t.toolCount > 0 && <Tag><Wrench size={11} /> {t.toolCount}</Tag>}
        {t.sidechains > 0 && <Tag>{t.sidechains} sub-agent</Tag>}
        <Button title="copy turn" onClick={() => copy(turnText(t))}><Copy size={13} /></Button>
        {fork && (
          <Button title="fork or reset to this turn" aria-expanded={forkTurn === t.id}
            onClick={() => setForkTurn((id) => (id === t.id ? null : t.id))}>
            <GitFork size={13} />
          </Button>
        )}
      </div>
      {fork && forkTurn === t.id && (
        <ForkTurnRow doc={doc} turn={t} fork={fork} onRun={() => setForkTurn(null)} />
      )}
      {/* NOT A PROMPT SOMEBODY SENT.
          `marker: "compaction"` is the backend's own record of the
          conversation being summarised: a user-role row carrying a
          compaction part and no text at all (measured on a real opencode
          store: exactly the 43 rows with a compaction part are exactly
          the 43 user rows with no text). Rendered as a prompt it is an
          empty `.tr-you` quote — which reads as a person having sent a
          blank message, a claim about somebody rather than about the
          tool. So it is a labelled DIVIDER: the one thing on this screen
          that is the conversation's own seam. */}
      {t.marker === "compaction" && (
        <div className="tr-mark" title="the conversation was summarised here — everything before this point reaches the model as that summary, not as the turns you can read above">
          <FoldVertical size={12} /> <span>conversation compacted here</span>
        </div>
      )}
      {/* Prompts get the same markdown treatment — pasted specs, lists and
          fenced snippets are common in what you send from the phone. */}
      {t.prompt && (
        <div className="tr-you">
          <Markdown src={t.prompt} q={q} onCopy={copy} files={files} />
          {t.sentAt && new Date(t.sentAt).toDateString() !== today ? <div className="tr-when">posted {stamp(t.sentAt)}</div> : null}
        </div>
      )}
      {/* …and the empty body under it is SAID, never left blank: a turn
          with no blocks reads as one the agent answered with silence. */}
      {t.queued && (
        <div className="tr-status tr-note">
          <Clock size={13} />
          <span className="tr-live-what">sent from this app · the CLI has not started it yet</span>
        </div>
      )}
      {/* …and where it DID start it, but folded into the turn above, that
          is said in words too. A `title` is invisible on a phone, and
          without the sentence the reply under this prompt looks like a
          clean answer to it when the CLI was still finishing the previous
          one. */}
      {t.absorbed && (
        <div className="tr-status tr-note">
          <CornerDownRight size={13} />
          <span className="tr-live-what">the CLI took this into the turn it was already running · the answer above may be replying to both</span>
        </div>
      )}
      {/* `/btw`: the CLI answers in an overlay of its own and writes it
          nowhere, and copying it off the screen kept breaking — so the
          reader stopped trying (host `screenCommandTurns`). The empty body
          says where the answer is instead of looking like silence. */}
      {t.local === "screen" && answeredOnlyInCli(t.prompt) && (
        <div className="tr-status tr-note">
          <TerminalIcon size={13} />
          <span className="tr-live-what">
            the CLI answers {t.prompt.trim().split(/\s+/)[0]} in an overlay of its own and keeps no record of it,
            so the reader does not copy it · read it in the CLI while the overlay is up — once closed (Esc) it is gone
          </span>
          <Button onClick={() => { track("action:read.btwToCli"); onShowCli?.(); }}>
            <TerminalIcon size={13} /> open the CLI
          </Button>
        </div>
      )}
      <TvBlocks m={m} t={t} />
      {(() => {
        const newest = turns[turns.length - 1]?.id === t.id;
        return (
          <CostFold t={t} className="tr-fold"
            which={newest && stillGoing ? "running" : t.id === whyTurnId ? "last" : "earlier"}
            open={t.id === whyTurnId ? costLastOpen : costOpen.has(t.id)}
            onToggle={() => toggleCost(t.id, t.id === whyTurnId)}
            slots={mixSlotsDoc} agentsSoFar={agentsSoFar.has(t.id)} usdPerWeekPct={usdPerWeekPct ?? null} weekIncl={weekIncl ?? null} onOpen={onOpenCost}
            next={newest && !stillGoing && !t.queued ? nextTurnText(nextTurn) : null}
            why={whyTurnId === t.id} />
        );
      })()}
      {/* When the turn FINISHED. `endedAt` is the last record so far, so on
          the turn still running it is not a finish and is not drawn — the
          status strip below says "working" instead. */}
      {t.endedAt && !t.queued && (() => {
        const going = turns[turns.length - 1]?.id === t.id ? stillGoing
          : t.agentsRunning ? `${t.agentsRunning} subagent${t.agentsRunning === 1 ? "" : "s"} still running`
          : null;
        // While the main loop runs, the status strip says "working"; a
        // stamp would be the last record so far, not a finish.
        if (going === "working") return null;
        const dur = took(t.sentAt, t.endedAt);
        return (
          <div className="tr-when tr-ended">
            {going
              ? `last reply ${stamp(t.endedAt)} · not finished — ${going}`
              : `finished ${stamp(t.endedAt)}${dur ? ` · took ${dur}` : ""}`}
          </div>
        );
      })()}
    </div>
  );
}
