// Send-queue scheduling — the pure half of the phone's offline outbox.
//
// Lives in `shared` (not in `web`) for one reason: it is the rule that keeps
// queued text from being mangled, and a rule that matters needs a test. The web
// bundle has no node-runnable build, `shared/dist` does — so `e2e-queue.mjs`
// pins the ordering guarantees here directly instead of trusting a comment.
//
// ONE SEND PER SESSION AT A TIME. The queue is flat and global, but a PTY
// composer is not: two messages written to the same session back-to-back are
// concatenated into a single line ("fix the testsadd a changelog"), and the two
// submitting Returns that follow then submit the mush plus a stray blank. That
// is what happens whenever more than one message is typed while the tunnel is
// down and the reconnect flush drains the queue at once. So a session is a
// LANE: at most one entry in flight, the next released only once the previous
// one is acked and its Return has gone out. Different sessions still drain
// concurrently — they are independent terminals.
//
// Order within a lane is array order, which is queue order: a message typed
// second must never overtake the one typed first.
//
// WHAT THIS IS NOT, SINCE THE INTENT STORE.
// This module used to own *when* deferred work ran. It no longer does. The
// host holds a durable Intent for every piece of work that waits (`intent.ts`,
// `host/intents/`), keeps the full text for ever, and re-asks one ladder
// (`intentVerdict`) about it. What is left here is a TRANSPORT: lanes, the
// order within one, and the retry contract that makes an ackId safe to re-send.
//
// The one deletion that matters is the CLOCK. There is no `ttlMs` any more,
// and nothing in this file expires anything. "queued too long" was a sentence
// about a thirty-minute timer told for a failure that was never about time,
// and it is what shredded prompts somebody had spent an evening on. Safe to
// delete because at-most-once moved off the ack ledger's 45 minutes and onto a
// store row that lives as long as the work does: an entry that cannot reach
// the host is not expired, it is *waiting*, and its row says `offline` —
// honestly, for as long as that stays true.

// The one door. The code lives in `./queue/` (a slice per subject, listed below);
// importers keep saying `./queue.js`. docs/notes/shared-architecture.md.

export type {
  SendStatus,
  SendMode,
  SendQueueEntry,
} from "./queue/queueentry.js";
export {
  RETRY_BACKOFF_MS,
  RETRY_BACKOFF_MAX_MS,
  retryDelay,
  MIN_TRY_MS,
  RETRY_ROUND_MS,
  RETRY_ROUND_MAX_MS,
  roundDelay,
  uploadAttemptWasted,
} from "./queue/queueretry.js";
export {
  adoptReferencedUploads,
  danglingUploadRefs,
  answerInsertAt,
} from "./queue/queueuploads.js";
export {
  laneBusy,
  sessionWall,
} from "./queue/queuelane.js";
export type {
  LaneSessionState,
  SessionWall,
} from "./queue/queuelane.js";
export {
  selectSendable,
} from "./queue/queueplan.js";
export type {
  SelectSendableOpts,
  SendBlockReason,
  BlockedEntry,
  SendPlan,
} from "./queue/queueplan.js";
export {
  bindPendingSession,
  ownedPendingCreates,
  applyRelease,
} from "./queue/queuebind.js";
export {
  serialGroup,
  SERIAL_STARTUP_MS,
  busySerialGroups,
  sendEligible, serialHolders, serialLead, serialWaitText, SERIAL_WAIT_TEXT,
} from "./queue/queueserial.js";
export type {
  SerialSessionState,
  SerialWatch, SerialHolder,
} from "./queue/queueserial.js";
export {
  blockedReasonText,
  queueIdleReason,
} from "./queue/queuewords.js";
export {
  laneEntries,
  canRetarget,
  retargetEntry,
  moveInLane,
} from "./queue/queueretarget.js";
export type {
  RetargetableEntry,
} from "./queue/queueretarget.js";
