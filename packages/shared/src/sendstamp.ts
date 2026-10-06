/**
 * **When was this ackId FIRST put on the wire?** — the one fact that lets a host
 * whose at-most-once ledger was lost fail CLOSED instead of open.
 *
 * The host's ack ledger (`host/acks.ts`) is what turns a re-send into a re-ack.
 * When that file is unreadable at boot it is kept aside and the host knows it
 * has forgotten — but an ackId is random, so a retry of an op first sent BEFORE
 * the loss and a brand-new op were the same bytes, and for one ack TTL a
 * pre-loss retry could run a second time. Refusing every unknown ackId instead
 * would refuse every new send for 45 minutes.
 *
 * So every ackId-carrying durable message may say when its FIRST attempt went
 * out (`firstSentAt`, stamped once by the phone's queue and never changed on a
 * retry) and when THIS attempt went out (`sentAt`, stamped at the socket
 * write). Both are optional and additive — `PROTOCOL_VERSION` stays where it is:
 * an older host ignores them, and a message without `firstSentAt` (an older
 * client, a plain script) gets exactly the old behaviour, i.e. it runs.
 *
 * **Clock skew is why there are TWO stamps.** Both are the PHONE's clock, and
 * the loss instant is the DESKTOP's. Comparing `firstSentAt` to it directly
 * would be wrong by however far the two clocks disagree, in either direction —
 * and in the unsafe direction (phone ahead) a pre-loss retry would look new and
 * run twice. The difference `sentAt - firstSentAt` is an AGE measured on one
 * clock, so the host places the first send on its OWN clock as
 * `receivedAt - age`, and skew drops out entirely. What is left is the transit
 * time of this one attempt (stamp → receipt), which makes the estimate LATER
 * than the truth — the unsafe direction — so `LOST_LEDGER_MARGIN_MS` is added to
 * the loss instant to cover it. `sentAt` is stamped where the frame actually
 * leaves (`web/ws.ts`), not when it is queued, so a frame the socket held in
 * RAM across a reconnect does not count its wait as transit.
 *
 * Without `sentAt` (a client that sends only the first stamp), the raw
 * `firstSentAt` is compared with the much wider `LOST_LEDGER_RAW_MARGIN_MS`:
 * failing closed means a fresh send in the first two minutes after a lossy boot
 * may be refused (and says so) rather than an old one run twice.
 *
 * Pure: the host owns `lost` and the receipt clock, this owns the rule.
 */

/** The two optional stamps a durable message may carry. Epoch ms, phone clock. */
export interface SendStamp {
  /** When the phone's queue FIRST put this ackId on the wire (phone clock, epoch ms); never changes on a retry — a host that lost its ack ledger reads it (with `sentAt`) to refuse a retry of a send from before the loss. */
  firstSentAt?: number;
  /** When THIS attempt went on the wire — stamped at the socket write. */
  sentAt?: number;
}

/** Transit allowance on the skew-free (age) estimate — see the header. */
export const LOST_LEDGER_MARGIN_MS = 5_000;
/** Allowance on a bare `firstSentAt` compared across two clocks. */
export const LOST_LEDGER_RAW_MARGIN_MS = 120_000;

/** What a refused pre-loss re-send is told. The one wording, both ends. */
export const LOST_LEDGER_REFUSAL =
  "the desktop lost its delivery record; this may already have run — check, then send it again as a new message";

const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

/**
 * Where the first send of this ackId falls on the RECEIVER's clock, and how
 * much slack that estimate needs. Null when the message cannot say (no
 * `firstSentAt`) — which is never a reason to refuse.
 */
export function firstSentOnHostClock(stamp: SendStamp | undefined, receivedAt: number): { at: number; margin: number } | null {
  if (!stamp || !finite(stamp.firstSentAt)) return null;
  if (finite(stamp.sentAt) && stamp.sentAt >= stamp.firstSentAt) {
    return { at: receivedAt - (stamp.sentAt - stamp.firstSentAt), margin: LOST_LEDGER_MARGIN_MS };
  }
  return { at: stamp.firstSentAt, margin: LOST_LEDGER_RAW_MARGIN_MS };
}

/**
 * The verdict for an ackId the ledger does NOT know (the caller checks that
 * first: a known one is re-acked, never judged here). A sentence when the
 * ledger was lost at `lost.at`, we are still inside the window a pre-loss
 * retry could arrive in (`lost.until`), and this message says it was first
 * sent before the loss — else null, and the op runs as it always did.
 */
export function preLossRefusal(
  lost: { at: number; until: number } | null | undefined,
  stamp: SendStamp | undefined,
  receivedAt: number,
): string | null {
  if (!lost || receivedAt > lost.until) return null;
  const first = firstSentOnHostClock(stamp, receivedAt);
  if (!first) return null;
  return first.at < lost.at + first.margin ? LOST_LEDGER_REFUSAL : null;
}

/**
 * The frame as it leaves the socket: `sentAt` restamped to NOW on a message
 * that carries `firstSentAt`, every other message returned untouched (same
 * object). Called at the write itself (`web/ws.ts`), never at queue time, so
 * a frame held in RAM across a reconnect does not count its wait as transit.
 */
export function withSentAt<M extends object>(msg: M, now: number): M {
  const first = (msg as SendStamp).firstSentAt;
  return finite(first) ? { ...msg, sentAt: now } : msg;
}

/**
 * A queued frame with its first-send stamp: `firstSentAt` added to a message
 * that carries an `ackId` (only those are judged against a lost ledger), every
 * other message returned untouched. An existing stamp is KEPT — it is the
 * first send, and a later one overwriting it is the bug this field prevents.
 */
export function withFirstSentAt<M extends object>(msg: M, firstSentAt: number): M {
  const m = msg as SendStamp & { ackId?: unknown };
  if (typeof m.ackId !== "string" || finite(m.firstSentAt)) return msg;
  return { ...msg, firstSentAt };
}
