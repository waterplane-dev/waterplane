/**
 * The verdict-shape rule: every message whose sender WAITS for an answer gets
 * that answer, including when the demo cannot do it.
 *
 * The client queue holds a durable op until its `op.ack`, a send until its
 * `input.ack`, a queued work item until its `backlog.ack`, and armed answers
 * never expire. A refusal that arrives as anything else — a toast, an
 * `error` frame, silence — leaves the row pending and the queue retries it
 * until its give-up budget runs out, with the same ackId, for ever after a
 * reload. So `RECEIPTS` names, per message type, the one frame that ends its
 * sender's wait, and `refuse()` answers through it with `ok:false` and a
 * sentence the UI shows as text.
 *
 * Only a message with NO receipt (nothing is waiting, nothing retries) is
 * refused with a toast — the person tapped something and must be told, and
 * there is no other frame that says it.
 *
 * A refusal never sets `input.ack.retryable`: that is the one auto-retried
 * failure, and "not in the demo" does not change with time.
 */
import type { ClientMessage, HostMessage } from "@waterplane/shared";

export type Msg<K extends ClientMessage["t"]> = Extract<ClientMessage, { t: K }>;

/** What a handler decides; `receiptFor` turns it into the matching frame.
 *  Fields beyond `ok`/`reason` are read only by the receipt that has them. */
export interface DemoVerdict {
  ok: boolean;
  reason?: string;
  /** `op.ack` */
  sessionId?: string;
  runId?: string;
  launchId?: string;
  intentId?: string;
  filed?: string[];
  /** `input.ack` */
  state?: "ok" | "notready" | "unconfirmed" | "unsubmitted" | "stale" | "rescued" | "forked";
  /** `backlog.ack` */
  itemId?: string;
  /** `session.named` */
  name?: string;
  /** `plugin.reply` */
  result?: unknown;
}

/** The sentence every tier-B refusal carries unless its entry names a better
 *  one. Says what would make it work, not just that it doesn't. */
export const NOT_IN_DEMO = "Not in the demo — this needs your own desktop running the host.";

/**
 * Messages answered by `op.ack` when they carry an ackId — the real host's
 * durable ops (`durable: true` in routes/*.ts, plus the two that call
 * `durableOp` themselves: `fanout.followup`, `schedule.save`). The parity test
 * (WP2b, packages/host/test) keeps this list equal to the host's.
 */
export const DURABLE_OPS = [
  "session.create",
  "fanout.run",
  "fanout.followup",
  "backlog.name",
  "build.run",
  "capture.run",
  "assess.run",
  "assess.apply",
  "schedule.run",
  "schedule.save",
  "intent.post",
  "intent.run",
  "intent.requeue",
  "intent.update",
  "intent.waive",
  "intent.retarget",
] as const satisfies readonly ClientMessage["t"][];

type DurableOp = (typeof DURABLE_OPS)[number];

type Receipt<K extends ClientMessage["t"]> = (msg: Msg<K>, v: DemoVerdict) => HostMessage | null;
type ReceiptTable = { [K in ClientMessage["t"]]?: Receipt<K> };

const opAck = (m: { ackId?: string }, v: DemoVerdict): HostMessage | null =>
  m.ackId
    ? { t: "op.ack", ackId: m.ackId, ok: v.ok, reason: v.reason, sessionId: v.sessionId, runId: v.runId, launchId: v.launchId, intentId: v.intentId, filed: v.filed }
    : null;

const durableReceipts = Object.fromEntries(DURABLE_OPS.map((t) => [t, opAck])) as unknown as { [K in DurableOp]: Receipt<K> };

/** The frame that ends each waiting sender's wait. A message absent here has
 *  no receipt: nothing on the client is holding a row for it. */
export const RECEIPTS: ReceiptTable = {
  ...durableReceipts,
  "session.input": (m, v) =>
    m.ackId ? { t: "input.ack", id: m.id, ackId: m.ackId, ok: v.ok, reason: v.reason, state: v.state } : null,
  "backlog.add": (m, v) =>
    m.ackId ? { t: "backlog.ack", ackId: m.ackId, ok: v.ok, itemId: v.itemId, reason: v.reason } : null,
  "plugin.call": (m, v) =>
    ({ t: "plugin.reply", ackId: m.ackId, plugin: m.plugin, method: m.method, ok: v.ok, result: v.result, error: v.ok ? undefined : v.reason }),
  "session.name": (m, v) => ({ t: "session.named", id: m.id, name: v.name, reason: v.reason }),
  "localrt.evict": (m, v) => ({ t: "localrt.evict", name: m.name, ok: v.ok, error: v.ok ? undefined : v.reason }),
  "shell.kill": (m, v) => ({ t: "shell.killed", id: m.id, pid: m.pid, ok: v.ok, reason: v.reason }),
};

/** The receipt for `msg` under verdict `v`, or null when `msg` has none (or
 *  carries no ackId where its receipt is addressed by one). */
export function receiptFor(msg: ClientMessage, v: DemoVerdict): HostMessage | null {
  const r = RECEIPTS[msg.t] as Receipt<ClientMessage["t"]> | undefined;
  return r ? r(msg as never, v) : null;
}

/** The ackId a stored receipt is keyed by, when `msg` has a receipt at all. */
export function ackIdOf(msg: ClientMessage): string | undefined {
  if (!(msg.t in RECEIPTS)) return undefined;
  const id = (msg as { ackId?: unknown }).ackId;
  return typeof id === "string" && id ? id : undefined;
}

/** What a refused `msg` sends back: its receipt with `ok:false`, or — only
 *  when it has none — a toast. Never both, never neither. */
export function refuse(msg: ClientMessage, reason: string = NOT_IN_DEMO): HostMessage {
  return receiptFor(msg, { ok: false, reason }) ?? { t: "toast", text: reason };
}
