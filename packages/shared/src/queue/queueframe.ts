// The socket frame one queue entry puts on the wire — moved here from the
// phone's `core/queue/logic.ts` (move only, no behaviour change) so that a
// second sender of the SAME frames (the background relay: `queuerelay.ts`, the
// APK's service and the PWA's service worker) builds them with this one
// function rather than a copy that drifts. The web flusher still calls it
// through `logic.ts`, which re-exports it.
// The one door stays `./queue.js`; this slice imports its siblings directly, never the barrel.

import type { ClientMessage } from "../wire/messages.js";
import type { LaunchOpts, SendView } from "../wire/session.js";
import type { SessionBudget } from "../sessionbudget.js";
import { withFirstSentAt } from "../sendstamp.js";
import type { SendMode } from "./queueentry.js";

/**
 * The fields `entryFrame` reads — the phone's `OutboxEntry` satisfies it
 * structurally. Every field's meaning is documented on `OutboxEntry`
 * (`packages/web/src/outbox.ts`); only the shape lives here.
 */
export interface QueueFrameEntry {
  ackId: string;
  sessionId: string;
  cwd: string;
  text: string;
  mode?: SendMode;
  /** First attempt on the wire, never reset — the frame's `firstSentAt`. */
  firstTryAt?: number;
  /** op mode: the exact frozen ClientMessage. */
  op?: ClientMessage;
  /** An answer to a question box (`expectPrompt` and friends). */
  answer?: { fingerprint: string; submitBox?: boolean; choice?: number; text?: string };
  view?: SendView;
  label?: string;
  fire?: boolean;
  autoFire?: boolean;
  targetSessionId?: string;
  steps?: string[];
  resume?: boolean;
  closeWhenDone?: boolean;
  flagWhenDone?: boolean;
  budget?: SessionBudget;
  launch?: LaunchOpts;
  pastBudget?: boolean;
}

/**
 * The socket frame for one attempt of an entry (after `markAttempt`), or null
 * when there is nothing to write (an upload is an HTTP POST; an op row with no
 * payload). Every frame carries `firstSentAt` = the entry's `firstTryAt`, the
 * same on every retry of the same ackId; `web/ws.ts` adds `sentAt` at the write.
 */
export function entryFrame(e: QueueFrameEntry): ClientMessage | null {
  const firstSentAt = e.firstTryAt;
  if (e.mode === "upload") return null;
  if (e.mode === "op") {
    // A durable ACTION, sent verbatim: the payload was frozen (ackId and all)
    // when it was queued, so a re-send after a reload is the same message and
    // the host's persisted ledger re-acks it instead of starting a second
    // session / sweep / build. Deliberately NO session.record (nothing was
    // typed) and NO submitting Return — an op settles in `op.ack`, not in a
    // composer. The stamp rides on top of the frozen payload, not inside it,
    // so the stored op stays byte-identical.
    if (!e.op) return null;
    return firstSentAt == null ? e.op : withFirstSentAt(e.op, firstSentAt);
  }
  if (e.mode === "backlog") {
    // Durable work item: the host de-dupes on the same ackId, so a reconnect
    // re-send can't add it twice (host `routes/work.ts` "backlog.add").
    return {
      t: "backlog.add", text: e.text, repoDir: e.cwd, label: e.label ?? e.text.slice(0, 40),
      fire: e.fire, targetSessionId: e.targetSessionId, autoFire: e.autoFire, ackId: e.ackId, firstSentAt,
      // Additive, v1: an older desktop ignores both and runs `text`, which
      // is `steps[0]` — turn one of the chain, never nothing.
      steps: e.steps, resume: e.resume,
      // Additive, v1: absent inherits the global setting on the desktop.
      ...(typeof e.closeWhenDone === "boolean" ? { closeWhenDone: e.closeWhenDone } : {}),
      // Additive: an older desktop ignores it and the session is not flagged.
      ...(e.flagWhenDone ? { flagWhenDone: true } : {}),
      // Additive: an older desktop ignores it and the item runs uncapped.
      ...(e.budget ? { budget: e.budget } : {}),
      // Additive: an older desktop ignores it and opens on its own defaults.
      ...(e.launch ? { launch: e.launch } : {}),
      // Additive: an older desktop ignores it and the row waits for the budget.
      ...(e.pastBudget ? { pastBudget: true } : {}),
    };
  }
  if (e.answer) {
    // An ANSWER to a question box: raw keystrokes, not prose. No `submit`
    // (there is no composer to echo-check and no Return to prove — the digit
    // IS the submit for a single-choice box), and `expectPrompt` so the host
    // writes nothing if that question is no longer the one on screen. That
    // guard is what lets this entry have been sitting in localStorage since
    // before the tunnel came back.
    //
    // `promptSubmit` is the exception to "the digit IS the submit": a checkbox
    // box confirms on its own Submit ROW, so the host has to put the cursor
    // there before the Return — which is a thing only the side that can see
    // the screen can do.
    //
    // `promptChoice` is the second exception, and the stronger one: an
    // opencode permission box has no digits at all, so there is no keystroke
    // this side could send. The entry names the option and the host walks the
    // selection there against the rendered screen. Same reason as
    // `promptSubmit` — only the side that can see the screen can do it — and
    // the client knows to use it because the published box said `nav`, never
    // because it knows which binary drew the dialog.
    return { t: "session.input", id: e.sessionId, data: e.text, ackId: e.ackId, firstSentAt, expectPrompt: e.answer.fingerprint, promptSubmit: e.answer.submitBox, promptChoice: e.answer.choice, ...(e.answer.text !== undefined ? { promptText: e.answer.text } : {}) };
  }
  // `submit: true` — the host types it, checks the echo, presses Return and
  // proves the turn started (deliver.ts), then acks. The client used to own
  // that Return: a bare, unacked `session.input "\r"` fired 50 ms AFTER the
  // receipt, i.e. after this entry had already been dropped from the queue. A
  // socket that died in between left the prompt sitting in the composer with
  // nothing left to retry and a UI that said "sent" — the lost-prompt bug. No
  // `session.record` either: the host records it, and only when the text
  // provably echoed, so history stops listing prompts that never ran. `cwd` is
  // a HINT, read only if the session turns out to be gone: the host then keeps
  // the words as a work item in that repo instead of refusing (`state:
  // "rescued"`). The rescue used to live here — a grace timer on the PHONE's
  // clock, which only ticks while a tab is foregrounded, i.e. never on the
  // device this queue exists for.
  return { t: "session.input", id: e.sessionId, data: e.text, ackId: e.ackId, firstSentAt, submit: true, cwd: e.cwd, view: e.view };
}
