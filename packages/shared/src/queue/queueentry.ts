// Cut from queue.ts (move only): the entry record
// The one door stays `./queue.js`; this slice imports its siblings directly, never the barrel.

export type SendStatus = "queued" | "pending" | "failed";

/**
 * What an entry DOES when it is delivered.
 *   input   — type it into the live session (the default).
 *   backlog — add it as a work item for the repo (`backlog.add`).
 *   op      — a durable one-shot action (`fanout.run`, `build.run`, …) acked by
 *             `op.ack`. An op is NOT text and must never be retargeted at
 *             another session: its payload names its own subject.
 *   upload  — an IMAGE waiting to reach the repo inbox. The only mode that does
 *             not travel over the socket (it is an HTTP POST), and it is in this
 *             queue for the ordering: a prompt that names
 *             `.claude/inbox/<file>` must not be delivered before the file is
 *             actually there, so the upload takes the lane ahead of it. Its
 *             bytes live in IndexedDB, keyed by ackId.
 */
export type SendMode = "input" | "backlog" | "op" | "upload";

/** The scheduler only needs these fields; the client's entry carries more. */
export interface SendQueueEntry {
  ackId: string;
  /** Lane key. Entries sharing it are strictly serialized. */
  sessionId: string;
  /** When it was queued (ms epoch). Ordering and display only — nothing here
   *  expires on it. */
  ts: number;
  status: SendStatus;
  attempts?: number;
  mode?: SendMode;
  /**
   * "Send it when the agent is done." The entry waits while its lane is busy
   * (a turn is in flight) instead of landing in the composer mid-answer — a
   * deliberate park, not a delivery failure. See `selectSendable`.
   *
   * It survives here for exactly one job the host cannot do: a CHAIN queued
   * behind a `session.create` (prompt 2 must not be typed while prompt 1's turn
   * is running, or the TUI concatenates them). "Wait until this repo is free"
   * as a piece of DEFERRED work is `trigger:{kind:"idle"}` on an intent, and
   * the host owns it.
   */
  holdUntilIdle?: boolean;
  /**
   * A prompt written for a session that DOES NOT EXIST YET — the follow-ups
   * queued behind a `session.create` op in the same `create:<cwd>` lane.
   *
   * Queuing "open a CLI here" on its own is close to pointless: what you
   * actually wanted was the work that follows it, and offline there is no
   * session id for a `session.input` to name. So the first prompt rides INSIDE
   * the create op (the host types it through `deliverToNewSession`) and every
   * further one waits here until `op.ack` names the session it belongs to —
   * `bindPendingSession` then rewrites the lane and they drain in order like
   * any other queued text.
   *
   * While the flag is set the entry is UNSENDABLE and holds its lane: its
   * `sessionId` is the lane key, not a session, and writing it to the socket
   * would address a session id the host has never heard of. Its fate follows
   * the create ahead of it: the client fails these alongside a create that
   * could not be delivered.
   */
  pendingCreate?: boolean;
  /**
   * The ackId of the `session.create` this parked prompt belongs to.
   *
   * The lane (`create:<cwd>`) is per REPO, not per create, and more than one
   * "open a session here and run these" can be queued for one repo — which is
   * the whole point of writing them offline. Without this, `bindPendingSession`
   * hands the SECOND create's chain to the FIRST session, and one create's
   * failure fails the other's prompts. Absent on entries written by an older
   * build; see `ownedByCreate`.
   */
  createAck?: string;
  /**
   * Set when this entry is an ANSWER to a question box (the client carries the
   * details; the scheduler only needs to know that it is one). Two rules here
   * depend on it: it is never retargetable (`canRetarget`), and it is queued by
   * `answerInsertAt` rather than appended.
   */
  answer?: unknown;
  /**
   * Explicitly released by the user (tapped Send with the link up, "Try now",
   * "Send all"). Read by `sendEligible` for the auto-send switch, and by the
   * usage-budget hold: a person choosing to spend the last of a window is the
   * one sender the budget was never meant to stop.
   */
  armed?: boolean;
  /**
   * The text this entry would deliver. The scheduler itself does not read it —
   * `adoptReferencedUploads`/`danglingUploadRefs` do, because "does this prompt
   * name a file that is still on its way?" is an ORDERING question and the
   * ordering rules live here.
   */
  text?: string;
  /** upload mode: the repo-relative path these bytes will land at (predicted at
   *  queue time — see the client's `plannedInboxPath`). */
  upload?: { relPath: string };
  /**
   * The repo these words were composed for.
   *
   * Read by the scheduler for exactly one decision: whether a lane whose session
   * has GONE may still be sent. With a `cwd` the host can rescue it into that
   * repo's work items, so it must be; without one there is nowhere to put it and
   * it is held (`goneLanes`). Everything else about it is the client's business.
   */
  cwd?: string;
  /**
   * Earliest ms-epoch this entry may be attempted again — the retry BACKOFF.
   *
   * It exists because the attempt counter deliberately does not bound every
   * failure. An attempt that nobody answered (a dead tunnel, an aborted stall,
   * a POST the browser never even made) is ROLLED BACK, so riding out an outage
   * costs no budget — which is right, and which also means a failure mode that
   * returns instantly and forever has nothing stopping it. The observed shape
   * was a CORS preflight the host refused: `xhr.onerror` fires in
   * milliseconds, the catch requeues with the attempt rolled back, the lane
   * release re-fires the flush ~450 ms later, and the entry re-attempted at
   * roughly 2 Hz for ever — hammering a request that could
   * not work, repainting every queue surface in the app twice a second, and
   * holding its lane the entire time so nothing queued behind it ever went out.
   *
   * So a requeued entry names when it may go again, and `selectSendable` skips
   * it until then. It still HOLDS its lane while it waits: anything behind it
   * was queued after it and must stay behind it.
   */
  retryAt?: number;
  /**
   * SERIALIZATION GROUP — "these must not run at the same time as each other".
   *
   * The lane rule already stops two messages being typed into one composer at
   * once, but it says nothing about the work they START. A queued
   * `session.create` is acked the moment the host has spawned the CLI and typed
   * the first prompt, so a lane full of them drains in seconds and leaves N
   * agents editing one repo in parallel — burning one account's usage limit N
   * times over while finishing none of it, and writing over each other's edits.
   *
   * An entry carrying a group waits until the work the PREVIOUS member started
   * has finished (`busySerial`), not merely until it was accepted. The group key
   * is the repo directory (`serialGroup()`), so sessions in different worktrees
   * — which is what `parallel` backlog mode makes worktrees FOR — stay
   * independent.
   *
   * Only ever set client-side, and always overridable per entry: "run this one
   * now" is a tap, not a code change.
   */
  serial?: string;
  /**
   * Attempts made, INCLUDING the ones rolled back out of `attempts`. Never
   * decremented. `attempts` answers "should we give up?"; this answers "how
   * long should we wait before trying again?", and the two must not be the same
   * number — the whole point of the rollback is that a dead link does not count
   * against giving up, while a dead link is exactly when backing off matters.
   */
  tries?: number;
  /**
   * When the FIRST delivery attempt for this entry went on the wire.
   *
   * `ts` is when it was queued, which on this app is routinely hours before
   * anything could be attempted at all (composed in a tunnel, held by the
   * auto-send switch, parked behind a create). What the give-up rule has to be
   * measured against is how long delivery has actually been TRIED — see
   * `minTryMs`.
   *
   * Absent on entries written by an older build, and absent means "no floor to
   * apply": there is nothing to measure and the attempts cap stands alone.
   */
  firstTryAt?: number;
  /**
   * How many give-up ROUNDS this entry has already served.
   *
   * Running out of attempts is no longer terminal for a delivery nobody
   * answered (see `MIN_TRY_MS`): the entry goes back to the queue on a long
   * backoff and tries the whole ladder again. This counts those rounds, and is
   * what sizes the wait between them (`roundDelay`). Never decremented.
   */
  round?: number;
}
