/**
 * Instruction delivery into a live `claude` session — the shared "type this
 * prompt as if a human typed it, and CONFIRM it landed" path.
 *
 * Extracted from `backlog.ts` (it was `BacklogManager.feed`) when the fan-out
 * runner needed the exact same guarantees: the text reaches the session AT MOST
 * ONCE, and the caller is told whether it definitely landed, definitely didn't,
 * or couldn't be confirmed. Every trap the backlog hit is the same here, so the
 * code must stay one implementation, not two drifting copies.
 */
import type { SessionManager } from "./sessions.js";
import type { DeliveryShape, HistoryEntry } from "@waterplane/shared";
import { noteAmbiguousDelivery, noteDeliveryEnded, noteDeliveryStarted } from "./opendeliveries.js";
import { recordSent } from "./sentlog.js";
import type { DeliverOpts, DeliveryResult } from "./deliver/delivertypes.js";
import { runDelivery } from "./deliver/deliverrun.js";

export type { DeliverOpts, DeliveryResult } from "./deliver/delivertypes.js";

/**
 * Deliver instruction text into a session as if typed + Enter, and CONFIRM it
 * landed:
 *  - `"ok"`          — the text echoed in the composer and the turn started.
 *  - `"retry"`       — nothing was typed (the session never became ready), so
 *                      re-running deliverPrompt() later is free of side effects.
 *  - `"unconfirmed"` — the text was written but never showed up on screen. It
 *                      may or may not be sitting in the session; the caller
 *                      MUST NOT auto-retry, because retrying is what stacked
 *                      the same prompt over and over.
 *  - `"unsubmitted"` — the text is provably IN the composer but every Return we
 *                      sent was swallowed, so nothing is running. The prompt is
 *                      there, one keypress from starting; the caller must say so
 *                      rather than report a turn that isn't happening, and MUST
 *                      NOT retype (that would stack a second copy under the
 *                      first).
 *
 * Two traps avoided:
 *  - `claude`'s TUI may not be ready instantly (trust prompt on first launch
 *    etc.) — wait for the session to go quiet, signalling it's awaiting input.
 *  - text+CR in one chunk reads as a paste in the TUI — split into two writes
 *    so Return is recognized as the submit keystroke. Bypass the remote-control
 *    gate (this is automation, not user input).
 */
/**
 * Deliver into a session that was JUST spawned — the fan-out's per-repo fire and
 * the "open a session here and run this" create both need the identical dance.
 *
 * The only difference from `deliverPrompt()` is the single retry on `"retry"`:
 * a session seconds old is legitimately still booting (trust prompt, MCP
 * servers), and `"retry"` means provably NOTHING was typed, so a second attempt
 * cannot stack a copy. `"unconfirmed"` is never retried — that is the exact path
 * that used to type the same prompt five times.
 */
export async function deliverToNewSession(
  sessions: SessionManager,
  sessionId: string,
  text: string,
  historyKind: HistoryEntry["kind"] = "prompt",
  opts: DeliverOpts = {},
): Promise<DeliveryResult> {
  // The caller hears the detail of the attempt whose verdict it gets, never a
  // first attempt's sentence under a second attempt's `retry`.
  let first: string | undefined;
  const res = await deliverPrompt(sessions, sessionId, text, historyKind, { ...opts, onDetail: (d) => { first = d; } });
  if (res !== "retry") {
    if (first !== undefined) { try { opts.onDetail?.(first); } catch { /* the caller's own throw */ } }
    return res;
  }
  return deliverPrompt(sessions, sessionId, text, historyKind, {
    ...opts,
    audit: opts.audit ? { ...opts.audit, detail: opts.audit.detail ?? "retry after a not-ready first attempt" } : undefined,
  });
}


export async function deliverPrompt(
  sessions: SessionManager,
  sessionId: string,
  text: string,
  historyKind: HistoryEntry["kind"] = "backlog",
  opts: DeliverOpts = {},
): Promise<DeliveryResult> {
  const startedAt = Date.now();
  /**
   * This delivery's stable name, for the two ledgers that must be able to tell
   * one delivery from another: the spent-turn ledger (`settle.ts`) and the
   * in-flight rival list (`opendeliveries.ts`).
   *
   * The ackId when there is one, because that is the name the phone, the open
   * question and `input.settle` all already use — a key that differs between
   * two asks about the same prompt would lock a row out of its own evidence.
   */
  const key = opts.ackId ?? `d_${sessionId}_${startedAt}`;
  /**
   * What this delivery is SHAPED like, filled in as it goes and stamped onto
   * the audit row at the end.
   *
   * Written by `runDelivery` through the reference rather than returned,
   * because the facts worth having are the ones a delivery that went WRONG
   * collected on its way there — and those exits are `return`s from a dozen
   * branches, every one of which would otherwise have to remember to carry
   * them. The grid is read at the START: a resize mid-delivery is exactly the
   * event that breaks an echo, so the number worth keeping is the one the
   * composer was drawn in when the text was typed.
   */
  const shape: DeliveryShape = {
    chars: text.length,
    lines: text.split("\n").length,
    ...(sessions.geometry(sessionId) ?? {}),
    ...(opts.view ? { view: opts.view } : null),
  };
  noteDeliveryStarted(key, sessionId, text);
  let out: { result: DeliveryResult; detail?: string };
  try { out = await runDelivery(sessions, sessionId, text, historyKind, opts, key, shape); }
  finally { noteDeliveryEnded(key); }
  const result = out.result;
  // Both, when there are both: the caller's detail says WHY this fired ("follow-up
  // in run X") and the delivery's says what happened to it. Neither is a
  // substitute for the other, and dropping the second is how a `retry` that
  // means "I could not tell your prompt from another one" gets logged as an
  // ordinary not-ready session.
  const detail = [opts.audit?.detail, out.detail].filter(Boolean).join(" — ") || undefined;
  if (out.detail) { try { opts.onDetail?.(out.detail); } catch { /* a caller's own throw is not this delivery's problem */ } }
  // Record on EVERY exit, including `"retry"` (= provably nothing typed): "the
  // backlog never managed to feed this session" is exactly as much of an answer
  // as "it did", and a log that only holds successes cannot be used to explain
  // a session that did nothing.
  const sent = recordSent({
    sessionId,
    actor: opts.audit?.actor ?? (opts.audit?.source === "compose" ? "user" : "auto"),
    source: opts.audit?.source ?? (historyKind === "backlog" ? "backlog" : "compose"),
    kind: text.trimStart().startsWith("/") ? "command" : "prompt",
    text,
    result,
    detail,
    shape,
  });
  // An unconfirmable verdict is not an outcome, it is an OPEN QUESTION, and
  // this is the chokepoint every delivery in the app passes through — the same
  // argument `recordSent` above is made from. Threading the registration
  // through the backlog, the fan-out, follow-ups, creates, the compose path and
  // the limit scheduler instead would mean a new call site could forget it, and
  // a forgotten one is a prompt whose fate nobody ever asks about again.
  if (opts.watch !== false && (result === "unconfirmed" || result === "unsubmitted")) {
    noteAmbiguousDelivery({
      sessionId, text, result, startedAt,
      ackId: opts.ackId,
      source: opts.audit?.source ?? (historyKind === "backlog" ? "backlog" : "compose"),
      kind: text.trimStart().startsWith("/") ? "command" : "prompt",
      // The audit row this attempt just wrote. When the sweep proves what
      // became of the delivery it corrects THAT row, instead of leaving the
      // sent log stating the echo window's opinion for ever.
      sentId: sent?.id,
    });
  }
  return result;
}
