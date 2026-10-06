/**
 * A send the desktop has NOT finished answering — and why that is not a failure.
 *
 * `deliver.ts` gives up on reading the screen after four seconds and the log
 * after two and a half, and answers `unconfirmed`. That verdict was applied to
 * the queue row as a FAILURE: seven seconds after tapping Send the strip above
 * the composer went red, said "1 message not delivered — nothing ran", and
 * offered Restore / Manage / Dismiss. Every word of it was premature. The host
 * had at that moment only just written the row down, and it goes on to re-ask
 * the CLI's own conversation log on a doubling sweep and to retype a
 * provably-absent prompt up to `RESEND_TRIES` times — roughly the first minute
 * — before anything about that send is settled. A person reading the red strip
 * was being asked to act on a question nobody had answered yet, which is the
 * worst possible moment to ask: re-sending by hand is exactly what stacks a
 * second copy of a prompt that may already be running.
 *
 * So the one genuinely ambiguous verdict gets a state of its own on this side:
 * **the host is still confirming it.** It is not `queued` (it has been typed),
 * not `sent` (nothing confirmed that), and not `failed` (nobody knows that
 * yet). It resolves one of three ways — `delivery.settled` arrives and the row
 * is dropped (`landed`) or restated with the host's own sentence, or the window
 * below runs out with no word at all, and only then is red the honest colour.
 *
 * Pure and node-tested on purpose: what turns a row red is a rule, not a
 * rendering, and this one was wrong for months in a way no screenshot showed
 * until someone timed it.
 */
import type { OutboxEntry } from "./outbox";   // type-only: erased before node sees it

/**
 * How long the host is given to answer before the row is treated as failed
 * anyway.
 *
 * Sized off the host's own ladder rather than picked: four delivery attempts,
 * each spending a four-second echo window and a 2.5-second log poll, over
 * re-ask gaps that double from `WATERPLANE_SETTLE_BASE_MS` (5 s → 10 s → 20 s), is
 * about ninety seconds of genuine work. 150 s leaves room for a slow transcript
 * parse and a re-ask that lands late without ever letting a row sit in a
 * hopeful state for minutes. Past it the row says the last thing anybody
 * actually knew, which is that the desktop typed it and could not read the
 * screen back.
 *
 * It is a BACKSTOP, not the normal path: a connected phone hears
 * `delivery.settled` the moment the host decides, and a phone that was away
 * gets the whole list on reconnect (`delivery.list`).
 */
export const CONFIRM_WINDOW_MS = 150_000;

/**
 * The verdict that is a question rather than an answer.
 *
 * `unsubmitted` is deliberately NOT in here, though it is the other verdict
 * nobody may re-send by hand. It is not ambiguous: the host SAW the text in
 * that session's composer, so the fact is known, the action is a person's
 * (press Return there), and the host's own sweep will only ever confirm it
 * again — it never re-sends one. Calling that "still confirming" would hide a
 * row that genuinely is waiting on somebody. `unconfirmed` is the opposite: the
 * screen could not be read at all, which is precisely the row the host spends
 * its ladder on.
 */
const ASKING = new Set(["unconfirmed"]);

/**
 * Is the desktop still working on this row?
 *
 * `hostSettled` is the authoritative end — it is set when a verdict for this
 * ackId arrives — and the window is only for the case where none ever does.
 */
export function hostStillConfirming(e: OutboxEntry, now: number): boolean {
  if (e.status !== "failed" || e.hostSettled) return false;
  if (!e.failState || !ASKING.has(e.failState)) return false;
  const at = e.failedAt ?? e.sentAt ?? e.ts;
  return now - at < CONFIRM_WINDOW_MS;
}

/** The strip's sentence. Says what is happening and what will happen without
 *  it, because "confirming" alone reads as a spinner nobody can act on. */
export function confirmingLine(n: number): string {
  return n === 1
    ? "1 message typed — the desktop is confirming it ran, and types it again itself if it never did"
    : `${n} messages typed — the desktop is confirming they ran, and types one again itself if it never did`;
}

/** Why "try again" is not the move while this is true. The same fact as the
 *  strip, aimed at the one control a person reaches for. */
export const CONFIRMING_WHY =
  "the desktop is still confirming this one — it may be running, and it re-sends it itself if it never landed";
