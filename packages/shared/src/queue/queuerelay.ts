// The background relay's half of the send queue: WHICH queued frames a sender
// with no page may put on the wire while the app is hidden, and in what order.
// Plan: .claude/outbox/bg-link-send/PLAN.md ("Design").
//
// THE RELAY IS THE QUEUE'S OWN FRAMES, NOT A SEND PATH. It never mints an
// ackId, never edits or deletes a row; every frame it carries is `entryFrame`
// output for a row the page's own flusher would send UNASKED on its next pass;
// its verdicts re-enter through the queue's receipt handlers when the page
// claims the queue back. The localStorage queue stays the source of truth and
// this plan is replaced on every queue change.
//
// Pure: no clock, no storage. The page (`useQueue`'s `writeOutboxImpl`) and the
// PWA service worker both fill `RelayFacts` from what they know, and an
// unknown fact HOLDS — a lane the relay cannot vouch for is the page's.
// The one door stays `./queue.js`; this slice imports its siblings directly, never the barrel.

import type { ClientMessage, RelayAckFrame } from "../wire/messages.js";
import type { SendQueueEntry } from "./queueentry.js";
import { entryFrame, type QueueFrameEntry } from "./queueframe.js";
import { sendEligible } from "./queueserial.js";

/**
 * The durable ops a relay may carry: each is at-most-once by ackId on the host
 * (`durable: true` / `durableOp`) and is something a person queued to run
 * unattended. Deliberately NOT here: `updates.apply` (restarts the host),
 * `signin.continue`, `assess.*`, `capture.run`, `backlog.name` — a spender or
 * a machine action nobody should get from a phone in a pocket.
 */
export const RELAY_OPS: ReadonlySet<string> = new Set([
  "session.create",
  "fanout.run", "fanout.followup",
  "build.run",
  "schedule.save", "schedule.run",
  "intent.post", "intent.update", "intent.run", "intent.retarget", "intent.requeue", "intent.waive",
]);

/** A receipt the relay earned: the host's ack frame, verbatim. The page replays
 *  it through `core/queue/wire.ts`'s `onInputAck`/`onBacklogAck`/`onOpAck`. */
export type RelayReceipt = RelayAckFrame;

/** What a claim hands back to the page: every receipt not yet claimed, and the
 *  rows the relay WROTE (with the `firstSentAt` it stamped) that have no
 *  receipt yet — the page marks those `pending`, never re-decides them. */
export interface RelayClaim {
  receipts: RelayReceipt[];
  written: { ackId: string; firstSentAt: number }[];
}

/** A queue row as the relay reads it — the phone's `OutboxEntry` fits. */
export type RelayEntry = SendQueueEntry & QueueFrameEntry & {
  /** Typed while the link was down (the reconnect question's subject). */
  offline?: boolean;
};

/**
 * What the caller knows that the rows do not. Every field is plain data (arrays,
 * booleans) so it survives a bridge or IndexedDB; an absent optional fact is
 * the safe answer for the relay (no budget hold known ⇒ none).
 */
export interface RelayFacts {
  /** The desktop these rows belong to; the relay sends only to it. */
  hostId: string;
  now: number;
  /** Settings: auto-send queued messages (`sendEligible`). */
  autoSend: boolean;
  /** "Ask on reconnect" (`confirmQueue`). */
  confirmQueue: boolean;
  /** The page's own reconnect hold ("Hold" was answered). */
  holdQueue: boolean;
  /**
   * Session ids on the last session list known to be RUNNING. An `input` row's
   * lane must be in it — a session the relay cannot vouch for is the page's
   * (and the host's rescue) to handle. Empty = no input rows relayed.
   */
  running: readonly string[];
  /** Lanes the page has decided are gone (`goneLanes`). */
  goneLanes?: readonly string[];
  /** The account usage budget holds automatic work (`budget.verdict.blocked`). */
  budgetBlocked?: boolean;
  /** Sessions over their own budget (`sessionBudgetHeld`). */
  budgetHeldLanes?: readonly string[];
  /** The give-up bound (`MAX_SEND_ATTEMPTS`): a row past it is the page's next
   *  round, never the relay's. Absent ⇒ no bound applied here. */
  maxAttempts?: number;
  /** …measured only past this long of trying (`MIN_TRY_MS`), as `selectSendable`. */
  minTryMs?: number;
}

export interface RelayItem {
  ackId: string;
  /** `entryFrame` output. `firstSentAt` ABSENT when the row was never attempted:
   *  the relay stamps it at its first write and hands it back on claim. */
  frame: ClientMessage;
  /** Passes every rule but the reconnect question: sent only after a person
   *  releases it ("Send N"). Rows behind it in its lane wait for it. */
  needsRelease?: true;
}

export interface RelayLane {
  lane: string;
  items: RelayItem[];
}

export interface RelayPlan {
  hostId: string;
  v: 1;
  issuedAt: number;
  /** Lanes with at least one item, in the order of their first row in the queue. */
  lanes: RelayLane[];
  /** Undelivered rows in the queue (not `failed`), relayable or not — the
   *  number `reportShellQueueDepth` already reports. */
  depth: number;
}

/**
 * Per lane, in queue order, the longest LEADING run of rows the page would send
 * unasked. The first row that fails a rule ends its lane — nothing behind it may
 * overtake it. `failed` rows are skipped, as `selectSendable` skips them.
 * A row ends its lane when it is: an upload (an HTTP POST of IndexedDB bytes),
 * or a prompt naming the path of any upload still in the queue; `pendingCreate`;
 * `holdUntilIdle` (the relay cannot see a turn); `serial`; backing off
 * (`retryAt` in the future); past the attempts bound; budget-held (an armed row
 * and an answer are exempt, as `selectSendable`); an `input` whose lane is gone
 * or not on the running list; an op whose `t` is not in `RELAY_OPS`; a row
 * `sendEligible` refuses even with the reconnect question answered yes.
 * A row refused ONLY by the reconnect question is included with `needsRelease`.
 */
export function relayPlan(entries: readonly RelayEntry[], facts: RelayFacts): RelayPlan {
  const running = new Set(facts.running);
  const gone = new Set(facts.goneLanes ?? []);
  const laneHeld = new Set(facts.budgetHeldLanes ?? []);
  const uploadPaths = entries
    .filter((e) => e.mode === "upload" && e.upload?.relPath)
    .map((e) => e.upload!.relPath);
  const stopped = new Set<string>();
  const lanes = new Map<string, RelayItem[]>();
  const stop = (e: RelayEntry) => { stopped.add(e.sessionId); };
  for (const e of entries) {
    if (e.status === "failed") continue;
    if (stopped.has(e.sessionId)) continue;
    const mode = e.mode ?? "input";
    if (mode === "upload") { stop(e); continue; }
    if (uploadPaths.length && uploadPaths.some((p) => e.text?.includes(p))) { stop(e); continue; }
    if (e.pendingCreate || e.holdUntilIdle || e.serial) { stop(e); continue; }
    if (e.retryAt != null && e.retryAt > facts.now) { stop(e); continue; }
    if (facts.maxAttempts != null && (e.attempts ?? 0) >= facts.maxAttempts) {
      const tryingFor = e.firstTryAt == null ? Infinity : facts.now - e.firstTryAt;
      if (tryingFor >= (facts.minTryMs ?? 0)) { stop(e); continue; }
    }
    const exempt = !!e.armed || !!e.answer;
    if (!exempt && (facts.budgetBlocked || laneHeld.has(e.sessionId))) { stop(e); continue; }
    if (mode === "input" && (gone.has(e.sessionId) || !running.has(e.sessionId))) { stop(e); continue; }
    if (mode === "op" && !(e.op && RELAY_OPS.has(e.op.t))) { stop(e); continue; }
    let needsRelease = false;
    const asked = facts.holdQueue || (facts.confirmQueue && !!e.offline && !e.armed);
    if (!sendEligible(e, { autoSend: facts.autoSend, hold: asked })) {
      if (!sendEligible(e, { autoSend: facts.autoSend, hold: facts.holdQueue })) { stop(e); continue; }
      needsRelease = true;
    }
    const frame = relayFrame(e);
    if (!frame || relayRefusal(frame) != null) { stop(e); continue; }
    const items = lanes.get(e.sessionId) ?? [];
    items.push({ ackId: e.ackId, frame, ...(needsRelease ? { needsRelease: true as const } : {}) });
    lanes.set(e.sessionId, items);
  }
  return {
    hostId: facts.hostId,
    v: 1,
    issuedAt: facts.now,
    lanes: [...lanes].map(([lane, items]) => ({ lane, items })),
    depth: entries.filter((e) => e.status !== "failed").length,
  };
}

/** `entryFrame`, with `firstSentAt` left ABSENT (not `undefined`) for a row
 *  never attempted: the relay stamps its own first write. */
function relayFrame(e: RelayEntry): ClientMessage | null {
  const frame = entryFrame(e);
  if (!frame || e.firstTryAt != null) return frame;
  if (!("firstSentAt" in frame)) return frame;
  const rest: Record<string, unknown> = { ...frame };
  delete rest.firstSentAt;
  return rest as unknown as ClientMessage;
}

/**
 * The one rule for which frames a relay may carry, asked by the plan here and
 * by the host's `POST /api/relay` — null = accepted, else the sentence why not.
 * Accepted: `session.input` with an ackId that submits (`submit`) or answers a
 * named question (`expectPrompt`); `backlog.add` with an ackId; an op in
 * `RELAY_OPS` with an ackId. Never raw keys, never a frame without an ackId.
 */
export function relayRefusal(frame: unknown): string | null {
  if (!frame || typeof frame !== "object" || Array.isArray(frame)) return "not a frame";
  const f = frame as { t?: unknown; ackId?: unknown; submit?: unknown; expectPrompt?: unknown };
  if (typeof f.t !== "string") return "not a frame";
  if (typeof f.ackId !== "string" || !f.ackId) return `${f.t} without an ackId cannot be relayed — a retry could run it twice`;
  if (f.t === "session.input") {
    if (f.submit === true || typeof f.expectPrompt === "string") return null;
    return "raw keys are never relayed — only a prompt that submits or an answer naming its question";
  }
  if (f.t === "backlog.add" || RELAY_OPS.has(f.t)) return null;
  return `${f.t} is not something the background relay sends`;
}

/** A key that changes exactly when the plan's content does (`issuedAt` left
 *  out), so a bridge is crossed only on a change. */
export function relayPlanKey(plan: RelayPlan): string {
  return JSON.stringify([plan.hostId, plan.v, plan.depth, plan.lanes]);
}
