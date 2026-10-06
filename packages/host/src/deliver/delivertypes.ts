/**
 * The delivery contract's types (`deliver.ts` re-exports the two public ones).
 * Types only — `tools/hostshape.test.mjs` holds it to that.
 */
import type { DeliveryShape, HistoryEntry, SendView, SentCommand, SentSource } from "@waterplane/shared";
import type { SessionManager } from "../sessions.js";
import type { noteHealth } from "../clihealth.js";
import type { makeLogProof, makeSubmitProof } from "./deliverproof.js";

/** What a delivery attempt did — see `deliverPrompt()` for the contract. */
export type DeliveryResult = "ok" | "retry" | "unconfirmed" | "unsubmitted";

/**
 * Options for one delivery.
 *
 * `interactive` is the COMPOSE-BAR case, and it exists because the automation
 * case and the human case want opposite things from a busy session.
 *
 * The backlog and the fan-out must never type into a session mid-turn: their
 * instruction is a new task, and dropping it into the composer while the agent
 * is answering is how an item gets lost or half-read. So they wait for the turn
 * to end (up to 45 s) and report `"retry"` if it never does.
 *
 * A person typing in the compose bar means the opposite. Typing at a working
 * agent is a normal, useful thing to do — you interject, and the TUI holds the
 * line until the turn ends. Making that send WAIT would silently turn every
 * compose send into the "hold until idle" mode the app offers as an explicit,
 * separate choice, and a prompt that sits on the host for 45 s and then comes
 * back "not ready" is a worse outcome than the raw write it replaced.
 *
 * So `interactive` waits only for the TUI to stop mid-draw, not for the turn to
 * finish. The echo check is unchanged and still does the work that matters. What
 * it costs is the Return PROOF: `turnActive` is already true when you interject,
 * so "the turn started" cannot distinguish a landed Return from a swallowed one,
 * and the delivery falls back to the same press-and-look guess a non-hooked
 * session gets — which is still strictly better than the old path, where nothing
 * checked anything at all.
 *
 * It is not, however, a fact about the CLI, and the health record is told so:
 * a proof that cannot exist for this input is a rule declining to fire, not a
 * rule failing. See the submit branch in `runDelivery`.
 */
export interface DeliverOpts {
  /** Human-typed: don't wait for the turn to end (see above). */
  interactive?: boolean;
  /**
   * The client's row key for this send, when it has one.
   *
   * Carried only so that a verdict settled MINUTES later can name the row it
   * retires. The phone keys its queue by ackId; without it a resolution the
   * host works out on its own arrives as a fact about a session and a string of
   * text, which is not something a client can match against the red row it is
   * showing.
   */
  ackId?: string;
  /**
   * Register an open question when the verdict comes back unconfirmable
   * (default true).
   *
   * False for exactly one caller: the sweep's own re-delivery of a prompt it
   * proved never ran. Its verdict updates the row that ordered it — a second
   * row would make one prompt look like two, and a re-send that came back
   * ambiguous would open a question whose answer is another re-send.
   */
  watch?: boolean;
  /**
   * Who is sending this and why — stamped onto the sent-command log entry.
   *
   * Optional so no call site can fail to compile, but every caller passes it:
   * an unlabelled delivery still gets logged (falling back to the history kind
   * below), because a command missing from the audit trail is worse than one
   * with a vague source.
   */
  audit?: { source: SentSource; actor?: SentCommand["actor"]; detail?: string };
  /**
   * Hand the caller the sentence this delivery wrote about itself, when it
   * wrote one.
   *
   * The four-value return is a contract about what may be RETRIED, and it
   * cannot carry a reason — but two `retry`s can mean completely different
   * things ("the session never reached its prompt" and "that composer already
   * holds text I cannot tell apart from yours"), and the second is the one a
   * person has to act on. A callback rather than a fifth enum member, because
   * the retry contract is right as it stands and every caller that does not
   * care may keep ignoring it.
   */
  onDetail?: (detail: string) => void;
  /**
   * Which screen the person composed this on — `term` or `read`.
   *
   * Carried for the AUDIT ROW and for nothing else: no branch in this file may
   * read it. The reader unmounts the xterm, so a send composed over it is
   * indistinguishable here from one composed over the live grid, and whether
   * the two confirm at different rates is a question this log could not be
   * asked. Measuring it is the point; acting on an unmeasured hunch about it
   * would be the mistake.
   */
  view?: SendView;
}

/**
 * What `runDelivery` hands its tail (`deliverreturn.ts`): its own locals, by
 * name. Every member is a const there; the proof's mutable facts are read
 * through `proof`'s getters, never copied out.
 */
export interface DeliveryRun {
  sessions: SessionManager;
  sessionId: string;
  text: string;
  historyKind: HistoryEntry["kind"];
  shape: DeliveryShape;
  note: typeof noteHealth;
  snapshot: () => Promise<string>;
  noTurn: boolean;
  unannounced: boolean;
  proof: ReturnType<typeof makeSubmitProof>;
  ranAnyway: ReturnType<typeof makeLogProof>;
}
