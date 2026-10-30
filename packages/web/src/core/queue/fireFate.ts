/**
 * **What became of a fired durable op** — the ONE owner, for every sheet that
 * fires something and then waits for it (a build, a fan-out sweep).
 *
 * A sheet used to keep this itself: BuildSheet tracked its fire's receipt and
 * queue row (design round 4), and FanoutSheet guessed its run from "the first
 * run id not known at the tap" with no ackId at all — so a `fanout.run` row
 * that failed or was dismissed spun *Sent — waiting for the desktop…* for
 * ever, and a run another device started in that window was taken as this
 * tap's (design review 2026-10-30 W2). Now the queue tracks the fire
 * (`queueOp(…, { ackId, track: true })`), `wire.ts`'s `onOpAck` records the
 * receipt here BEFORE it retires the row, and `useFireFate(ackId)` answers.
 *
 * Pure (node-tested by `fireFate.test.mjs`) except for the store itself.
 */
import { createStore } from "../../sdk/store.ts";

/** The host's `op.ack` for one tracked fire: `runId` absent = a host that does not name it. */
export type FireAck = { ok: boolean; runId?: string; reason?: string };

/** Tracked fires by ackId — `null` until the receipt arrives. */
export type FireAcks = ReadonlyMap<string, FireAck | null>;

/** What became of a fire. `acked` carries the run the receipt named, when it named one. */
export type FireFate =
  | { kind: "pending" }
  | { kind: "acked"; runId?: string }
  | { kind: "refused"; reason?: string }
  | { kind: "dropped"; reason?: string };

/**
 * Start tracking a fire, by the ackId its queue row carries — `null` until the
 * receipt. Settled fires beyond the newest `cap` are forgotten; an unsettled one never is.
 */
export function trackFire(prev: FireAcks, ackId: string, cap = 20): FireAcks {
  const next = new Map(prev);
  next.delete(ackId);
  next.set(ackId, null);
  // Only a SETTLED fire is forgotten: one still waiting on its receipt is a sheet's
  // live fate, and evicting it would make that sheet's strip vanish without a word.
  for (const [id, ack] of next) {
    if (next.size <= cap) break;
    if (ack !== null && id !== ackId) next.delete(id);
  }
  return next;
}

/** An `op.ack` landing: recorded only for a tracked ackId (every other ack returns `prev` itself). */
export function fireAckIn(prev: FireAcks, ackId: string, ok: boolean, runId: string | undefined, reason?: string): FireAcks {
  if (!prev.has(ackId)) return prev;
  const next = new Map(prev);
  next.set(ackId, { ok, ...(runId ? { runId } : {}), ...(!ok && reason ? { reason } : {}) });
  return next;
}

/**
 * `ack`: the host's receipt (absent = none yet). `row`: the queue row minted for
 * the fire (`undefined` = no such row now); `rowSeen`: the row was in the queue
 * at some earlier point — a row missing before it was ever listed is only not
 * there yet, a row missing AFTER was dismissed. A receipt wins over any row
 * state; without one, a failed or vanished row will never get one: `dropped`.
 */
export function fireFate(ack: FireAck | undefined, row: { status: string; reason?: string } | undefined, rowSeen: boolean): FireFate {
  if (ack) return ack.ok ? { kind: "acked", ...(ack.runId ? { runId: ack.runId } : {}) } : { kind: "refused", ...(ack.reason ? { reason: ack.reason } : {}) };
  if (row?.status === "failed") return { kind: "dropped", reason: row.reason };
  if (!row && rowSeen) return { kind: "dropped" };
  return { kind: "pending" };
}

/**
 * The fate of the fire `ackId`, read off the tracked receipts and the queue.
 * A TRACKED fire's row was in the queue when it was tracked (`queueOp` adds the
 * row before it tracks), so tracked IS "row seen" — no per-sheet ref. An
 * untracked id (never fired here, or evicted by the cap) is `null`: no claim.
 */
export function fireFateOf(acks: FireAcks, rows: readonly { ackId: string; status: string; reason?: string }[], ackId: string | null): FireFate | null {
  if (!ackId || !acks.has(ackId)) return null;
  return fireFate(acks.get(ackId) ?? undefined, rows.find((e) => e.ackId === ackId), true);
}

/** The run a fire started, by IDENTITY: the run its receipt names — never "the first run not known before the tap". */
export function firedRun<R>(runs: readonly R[], fate: FireFate | null, idOf: (r: R) => string): R | null {
  if (fate?.kind !== "acked" || !fate.runId) return null;
  return runs.find((r) => idOf(r) === fate.runId) ?? null;
}

/** The sentence for a fire that will never get a receipt. Never says it ran. */
export function droppedWords(what: string, reason?: string): string {
  return `The ${what} was not sent${reason ? ` — ${reason}` : " — its queue row is gone"}. Run it again when you want it.`;
}

/** This tab's tracked fires. Written by `queueOp` (track) and `onOpAck` alone. */
export const fireAcksStore = createStore<FireAcks>(new Map());

/** `queueOp`'s half: the row is in the queue, so start waiting for its receipt. */
export function noteFired(ackId: string): void {
  fireAcksStore.set(trackFire(fireAcksStore.get(), ackId));
}

/** `onOpAck`'s half — called BEFORE the row is retired, so no render sees "row gone, no receipt". */
export function noteFireAck(ackId: string, ok: boolean, runId: string | undefined, reason?: string): void {
  fireAcksStore.set(fireAckIn(fireAcksStore.get(), ackId, ok, runId, reason));
}
