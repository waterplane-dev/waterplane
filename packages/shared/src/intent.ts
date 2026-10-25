/**
 * The Intent — one durable "do this, there, when that is true", owned by the
 * HOST, and the single pure rule that decides whether it may run yet.
 *
 * ── Why this file exists ───────────────────────────────────────────────────
 *
 * Deferred work in this app is currently decided in six places, each with its
 * own store, its own tick, its own lifecycle words and its own failure ladder:
 * the backlog (per-repo JSON, 2 s tick), the schedule (host-wide JSON, 20 s),
 * the launch gate (host-wide JSON, 5 s), fan-out and builds (in-memory rings
 * that die with the daemon), and the phone's send queue (localStorage, capped
 * at 50 entries, expiring anything older than 30 minutes). Five of the six say
 * "queued" and mean five different things; the sixth deletes work on a clock.
 *
 * That last one is what actually cost the user prompts. The phone was the OWNER
 * of undelivered work while being the least reliable component in the system —
 * a browser tab on a bad tunnel, which reloads at exactly the worst moment, and
 * which shreds an unsent prompt to a 200-character gravestone an hour later.
 *
 * So the ownership moves: an intent is posted to the desktop, written to disk
 * BEFORE it is acked, and from that moment the phone may forget it. The desktop
 * is awake, has a disk, and is where the work happens.
 *
 * ── What is in here, and what is deliberately not ──────────────────────────
 *
 * This module is the MODEL and the RULE, nothing else. No filesystem, no
 * `Date.now()`, no host imports — time and every fact about the world arrive as
 * parameters, exactly as `nextFireAt` already takes them.
 * That is what lets `packages/shared/test/intent.test.mjs` pin the whole ladder
 * from literals in ~90 ms with no daemon booted and no `packages/host/dist` in
 * existence, which in turn is what lets the rule be settled before there is
 * anything to run it.
 *
 * The manager (persistence, the tick, the executors, the broadcast) is the
 * host's. Everything it decides, it decides by asking `intentVerdict`.
 *
 * ── The one rule that is not negotiable ────────────────────────────────────
 *
 * An intent is never deleted by a clock. It waits, it fails loudly, or the user
 * cancels it. `payload.steps` is kept in FULL, forever, un-clipped, until the
 * row reaches a terminal state a person has actually seen. Every cap in
 * `cleanIntentRow` below is on a COUNT or on a label — never on the words.
 *
 * ── Where it lives ─────────────────────────────────────────────────────────
 *
 * This file is the BARREL: the one door into the intent model. The code is in
 * `intent/` — `types`, `row`, `facts`, `words`, `budgetpass`, `kind`, `target`,
 * `verdict`, `clean`, `slot` — and every importer names `./intent.js` (or
 * `@waterplane/shared`), never a slice. The lists below are explicit because a
 * slice also exports helpers its siblings need (the ladder's own sentences,
 * `budgetHold`, `targetVerdict`) that are not part of this module's surface,
 * which `test/intentsurface.test.mjs` pins. Layout, import order and caps:
 * docs/notes/shared-architecture.md.
 */

export type {
  AssessPayload, BlockReason, BudgetPass, BudgetWaiver, BuildPayload, CapturePayload,
  IntentPayload, IntentRequeue, IntentResult, IntentTarget, IntentTrigger, Lifecycle,
} from "./intent/types.js";
export { REQUEUE_KEEP } from "./intent/types.js";

export type { Intent } from "./intent/row.js";
export { HELD_MAX_MS, INTENT_MAX_ATTEMPTS, INTENT_MAX_DIRS, INTENT_MAX_NEEDS, INTENT_MAX_STEPS, ON_TIME_MS } from "./intent/row.js";

export type { IntentFacts, IntentSettlement, IntentVerdict } from "./intent/facts.js";
export { busyIntentGroups, intentSerialHolders } from "./intent/facts.js";

export { intentVerdict } from "./intent/verdict.js";

export { liveConvSession, needsSlot, reopensConversation } from "./intent/target.js";

export {
  AFTER_RESET_LEFTOVER_MS, BUDGET_NOT_HOLDING, RESET_MATCH_MS, budgetAfterResetOf, budgetLeftoverOf, budgetPassAt, budgetPassOf, budgetWaived, budgetWaiverPeriod, budgetWaiverUntil, cleanBudgetWaiver,
} from "./intent/budgetpass.js";

export type { AutoSlotFacts, LocalSlotFacts } from "./intent/words.js";
export { INTENT_BLOCK_ORDER, autoSlotsBusy, autoSlotsWaitText, closeWhenDoneOf, intentReasonText, localSlotOverText, localSlotWaitText } from "./intent/words.js";

export { cleanIntentRow } from "./intent/clean.js";
export { type ClockMember, type Slot, type SlotRow, findSlot, latestClock, parseSlotKey, slotMates, slotOf, slotOthersText, slotRowOfIntent, slotRowOfItem, slotsOf } from "./intent/slot.js";

export type { IntentKind } from "./intent/kind.js";
export {
  AGENT_POSTED_WORDS, MANUAL_HOLD_TEXT,
  ORIGIN_AGENT, ORIGIN_FANOUT_FOLLOWUP, ORIGIN_FANOUT_RUN, ORIGIN_FANOUT_TARGET, ORIGIN_PEER_PREFIX,
  ORIGIN_SCHEDULE_BUILD, ORIGIN_SCHEDULE_PREFIX, ORIGIN_SCHEDULE_SWEEP, ORIGIN_SCHEDULE_WORK,
  clockKey, intentKind, isAgentPosted, isAssessRow, isBacklogRow, isBuildRow, isCaptureRow,
  isFanoutRow, isLaunchRow, isPeerPosted, isScheduleRow, isTimedWorkRow, peerOfOrigin,
  postsScheduledBuild, queuesBacklogItem, scheduleIdFromOrigin, scheduleItemOrigin, timedWorkKey,
} from "./intent/kind.js";
