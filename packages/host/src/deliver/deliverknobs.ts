/**
 * Every timing constant of the one delivery implementation (`deliver.ts`, cut
 * into `deliver/` as a MOVE — docs/notes/host-architecture.md, "The deliver
 * slices"). Values and their reasons exactly as they stood in `deliver.ts`.
 */

/**
 * How long to keep re-reading the screen for the typed text before calling it
 * `"unconfirmed"`. Generous on purpose: the cost of waiting is seconds, the
 * cost of giving up early is a prompt reported as not delivered (and never
 * auto-retried) that is actually sitting in the composer.
 */
export const ECHO_WAIT_MS = 4000;
/**
 * How long the submitted-prompt hook is given to arrive after a Return.
 *
 * Longer than it usually needs (the pipe answers in milliseconds) because what
 * it buys is the difference between `ok` and a verdict a person is asked to act
 * on by hand, and it is only ever spent on a delivery that has already failed
 * every cheaper proof. Measured on the live host: a first hook landed 677 ms
 * into a loop of this shape, and a loaded desktop is slower than that.
 */
export const PROMPT_HOOK_WAIT_MS = 2500;
/**
 * How long one `sources.delivery.landed` subscription stays open.
 *
 * Not a wait — nothing here sleeps on it. It is armed ONCE, at the first
 * Return, and has to outlive the longest submit ladder below (five presses of
 * six 150 ms polls is 4.5 s) so a landing the hooked loop is polling for can
 * still arrive; past it the source answers false and the flag simply stays
 * down.
 */
export const SOURCE_LANDED_MS = 6000;
/** How long a send waits for a side channel that is still CONNECTING (a fresh
 *  opencode session: its server starting, the conversation being opened) before
 *  it is held with the sentence. A channel that was up and dropped holds at once. */
export const CHANNEL_CONNECT_WAIT_MS = 30_000;
/**
 * How long a local command's Return is given to show its effect, and how many
 * presses it gets at all.
 *
 * 10 polls (1.5 s) was too few: a view that had genuinely opened had not drawn
 * yet, so the press was judged swallowed and repeated into the open view, which
 * dismissed it. 33 polls is ~5 s — longer than this TUI has ever taken to paint
 * one — and two presses rather than three, because a third has never rescued
 * anything the second did not and every extra press is another chance to close
 * what the last one opened.
 */
export const LOCAL_MOVE_POLLS = 33;
export const LOCAL_SUBMIT_TRIES = 2;
/** The submit budget for a command that announces nothing (`/compact`): the
 *  screen-inferred turn is published a window after the CLI starts painting,
 *  so 3 s per press, and two presses rather than five. */
export const UNANNOUNCED_POLLS = 20;
export const UNANNOUNCED_TRIES = 2;

/**
 * How long to give the CLI's own conversation log to prove the prompt ran,
 * before answering an unconfirmable verdict.
 *
 * The echo window is a guess about a TUI that repaints on its own schedule, and
 * it is wrong often enough that a phone ended up displaying 67 rows reading
 * "typed into that session but never seen to run" — several of them prompts
 * that were, at that moment, visibly running. The screen is a rendering; the
 * conversation log is the CLI's own record of what it accepted, and it outranks
 * anything scraped off a terminal.
 *
 * 2.5 s, polled: the record is written when the prompt is ACCEPTED, so in the
 * ordinary case it is already on disk when this starts and the check costs one
 * read. The budget is for a log file that appears a moment late or a write not
 * yet flushed — the disorderly cases where one blind read is indistinguishable
 * from "no log at all", which is exactly the mistake that would file a running
 * prompt as a gravestone. It is spent only on a delivery that has ALREADY lost
 * its four-second echo window, i.e. one that was about to be reported as a
 * failure, so it lengthens nothing that was working.
 */
export const LOG_PROOF_MS = 2500;

/** The `sleep` `runDelivery` declared as its first local. */
export { sleep } from "../proc.js";
