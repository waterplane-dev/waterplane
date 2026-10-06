import { CloudOff, HelpCircle, MessageCircleQuestion, Terminal as TerminalIcon, X } from "lucide-react";
import type { SessionInfo } from "@waterplane/shared";
import { promptFingerprint } from "@waterplane/shared";
import type { OutboxEntry } from "./outbox";
import { track } from "./usage";
import { ago } from "./format";
import { PromptAnswer } from "./PromptAnswer";
import { SheetHead } from "./Sheet";
import { Empty } from "./Empty";

interface Props {
  /** Every live session — the ones with a question are what this lists. */
  sessions: SessionInfo[];
  /** The send queue, so an already-answered question says so instead of
   *  inviting a second tap that would queue a duplicate keystroke. */
  outbox: OutboxEntry[];
  /** True while the socket is up. Offline is the case this sheet exists for, so
   *  it is stated rather than implied. */
  online: boolean;
  /** When the session list last came from the host — how old what you are
   *  reading is. Null when it has never arrived on this device. */
  seenAt: number | null;
  /** Queue an answer (App's `answerPrompt` — durable, fingerprinted, armed). */
  /** `submitBox` marks a checkbox box's Submit ROW — the host has to place the
   *  cursor on it before the Return (App's `answerPrompt`). */
  /** `choice` names a `nav` box's option by index — that box has no digits, so
   *  the host walks its selection there instead of typing one. */
  onAnswer: (session: SessionInfo, data: string, label: string, submitBox?: boolean, choice?: number) => void;
  /** Open that session's terminal, for a question the parser could not read. */
  onOpen: (sessionId: string) => void;
  /**
   * "I dealt with that elsewhere" — retire a prose question without answering
   * it (App's `ackAsking`). Live-only, deliberately: it is not durable and not
   * queued, because an acknowledgement delivered when the tunnel returns speaks
   * for a screen nobody is looking at any more.
   */
  onAck: (session: SessionInfo) => void;
  onClose: () => void;
}

/**
 * Pending questions, in one place, answerable with no link at all.
 *
 * The failure this removes: a session parks on a choice, the phone learns about
 * it during whatever seconds of connectivity the tunnel allowed, and then the
 * link is gone — and with it every route to the answer. The question itself
 * survived (it rides on `SessionInfo`, which App snapshots to localStorage on
 * every update), but reaching it meant opening that session's TERMINAL, and
 * getting to the right session out of eleven means knowing which one is
 * waiting, which is the thing the launcher only shows while it is live.
 *
 * So: one list, seeded from the same snapshot the launcher is, showing every
 * session that wants an answer and drawing the same card the reader does
 * (`PromptAnswer.tsx`). Tapping one queues it (App's `answerPrompt`), and the queue
 * delivers it the moment the tunnel is back — with the host refusing anything
 * whose question has since changed, which is what makes a keystroke minted
 * twenty minutes ago safe to send at all.
 *
 * Deliberately NOT a place that fetches anything: everything rendered here is
 * already on the device, so the sheet paints identically online and off. The
 * only difference offline is the age of what it is showing, which is said out
 * loud rather than left to be inferred from stale-looking text.
 */
export function QuestionsSheet({ sessions, outbox, online, seenAt, onAnswer, onOpen, onAck, onClose }: Props) {
  // Parsed questions first (they are answerable here), then the dialogs
  // `prompt.ts` could not read into options — those can only be pointed at.
  const asked = sessions.filter((s) => s.running && s.prompt);
  const unreadable = sessions.filter((s) => s.running && !s.prompt && s.awaitingInput);
  // …and the ones that asked in PROSE and then went quiet. No box, so nothing
  // to tap — but it is the same sentence this sheet exists for ("something is
  // waiting on you"), and the row that carried it was badged `done`.
  const inProse = sessions.filter((s) => s.running && !s.prompt && !s.awaitingInput && s.asking);
  const total = asked.length + unreadable.length + inProse.length;

  /** The answers already queued for THIS exact question — matched on the
   *  fingerprint, not the session: one left over from a box that has since been
   *  replaced is not this one's, and saying it was would be a lie about what is
   *  on its way. A list rather than a lookup because a checkbox box collects
   *  several (toggle, toggle, Submit). `failed` entries are excluded; those are
   *  in the recovery bar. */
  const queuedFor = (s: SessionInfo) => {
    const fp = promptFingerprint(s.prompt!);
    return outbox.filter((e) => e.answer?.fingerprint === fp && e.status !== "failed");
  };

  return (
    <div className="sheet">
      <SheetHead title={<><MessageCircleQuestion size={16} /> Questions</>} onClose={onClose}>
        <span className="muted">{total}</span>
      </SheetHead>

      {!online && (
        <div className="form-hint">
          <CloudOff size={13} style={{ verticalAlign: "-2px" }} />{" "}
          offline — {seenAt ? <>these are the questions as of {ago(seenAt)}</> : <>nothing has been synced to this device yet</>}.
          Answer anyway: it is queued and sent the moment the link is back.
        </div>
      )}

      {total === 0 && (
        <Empty>
          <HelpCircle size={20} />
          <div>Nothing is waiting on you.</div>
          <div className="muted">
            {online
              ? "A session parked on a choice shows up here."
              : "A session parked on a choice shows up here — as of the last time the phone reached the host."}
          </div>
        </Empty>
      )}

      <div className="list">
        {asked.map((s) => {
          const p = s.prompt!;
          const queued = queuedFor(s);
          return (
            <div key={s.id} className="q-card">
              <div className="q-head">
                <button className="linkish" onClick={() => { track("action:questions.open"); onOpen(s.id); }}>
                  <TerminalIcon size={13} style={{ verticalAlign: "-2px" }} /> {s.title || s.cwd}
                </button>
              </div>
              {/* Every word and every button from `PromptAnswer.tsx` — the one
                  card, shared with the reader's `tr-ask`. It used to be a second
                  copy of the approve bar's markup, and the two had already
                  drifted: this one sent a DIGIT at a `nav` box (opencode's
                  unnumbered permission dialog), where a digit is a stray
                  character in the composer. */}
              <PromptAnswer
                prompt={p}
                queued={queued.map((e) => ({ label: e.answer!.label }))}
                suggestion={s.suggestion}
                onAnswer={(data, label, submitBox, choice) => onAnswer(s, data, label, submitBox, choice)}
                ev="questions"
              />
            </div>
          );
        })}

        {unreadable.map((s) => (
          <div key={s.id} className="q-card">
            <div className="q-head">
              <button className="linkish" onClick={() => { track("action:questions.open"); onOpen(s.id); }}>
                <TerminalIcon size={13} style={{ verticalAlign: "-2px" }} /> {s.title || s.cwd}
              </button>
            </div>
            {/* A dialog is up but `prompt.ts` could not parse it into options.
                There is nothing safe to offer as a one-tap answer — a guessed
                keystroke into an unknown box is exactly what the fingerprint
                guard exists to prevent — so say what is true and point at the
                only thing that can resolve it. */}
            <div className="approve-q">A dialog is open in the CLI that couldn’t be read into options.</div>
            <div className="approve-opts">
              <button className="approve-btn" onClick={() => { track("action:questions.open"); onOpen(s.id); }}>
                open the CLI
              </button>
            </div>
          </div>
        ))}
        {inProse.map((s) => (
          <div key={s.id} className="q-card">
            <div className="q-head">
              <button className="linkish" onClick={() => { track("action:questions.open"); onOpen(s.id); }}>
                <TerminalIcon size={13} style={{ verticalAlign: "-2px" }} /> {s.title || s.cwd}
              </button>
            </div>
            {/* The agent's own words, not a paraphrase: this is the one line of
                the turn that decides what happens next, and it is the line a
                "Turn finished" ping threw away. No one-tap answer because there
                is no keystroke that means anything here — the reply is prose,
                so the only honest control is the one that opens the composer. */}
            <div className="approve-q">{s.asking!.text}</div>
            <div className="approve-hint">the turn ended on this — the CLI is idle, waiting for your reply</div>
            {/* Two ways this stops being a question, and only one of them is a
                reply. The other is the one the badge had no word for: the
                decision was taken somewhere else — the change committed at the
                desk, the choice overtaken — and there is nothing to type that
                would clear it, so the card, the launcher count and the push all
                kept standing over something already settled. *handled* types
                nothing; it names this question, so it cannot silence a
                different one that has replaced it since.

                Live-only, and said as a SENTENCE when the tunnel is down rather
                than as a dimmed twin of the button beside it: the ack is not
                durable and not queued, so offline there is genuinely no control
                here — only the reason there isn't. */}
            <div className="approve-opts">
              <button className="approve-btn primary" onClick={() => { track("action:questions.reply"); onOpen(s.id); }}>
                open and reply
              </button>
              {online
                ? <button className="approve-btn" onClick={() => { track("action:questions.ack"); onAck(s); }}>
                    handled — clear it
                  </button>
                : <span className="approve-hint">no link — “handled” needs the host, it is not queued</span>}
            </div>
          </div>
        ))}
      </div>

      <div className="sheet-actions">
        <button className="key" onClick={onClose}><X size={16} /> close</button>
      </div>
    </div>
  );
}
