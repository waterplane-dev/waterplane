/**
 * `POST /api/relay` — the background relay's way in (plan:
 * .claude/outbox/bg-link-send/PLAN.md, WP2).
 *
 * A sender with no page (the APK's `ShellLinkService` while the WebView is
 * frozen, later the PWA's service worker) hands the host ONE frame the phone's
 * send queue built (`entryFrame`) and waits for the verdict. It is NOT a send
 * path: the frame goes through the same `handleClientMessage` → router →
 * handler as a page socket's, so the ack ledger, `inputsInFlight`, `durableOp`,
 * `containRepoDir` and the lost-ledger rule all apply unchanged. What makes it
 * possible without a socket is a STAND-IN socket:
 *
 *   • registered in `attached`/`wsKind`/`wsToken`/`wsDevice` (the router reads
 *     `attached`; the identity maps say who sent it, exactly as for a socket),
 *     and `wsRole` = `"relay"`, which `roleAllows` passes only `input.ack`,
 *     `backlog.ack`, `op.ack` — no toast, no snapshot, no PTY byte;
 *   • NEVER in `clients`: nothing is broadcast to it, and since the "watched"
 *     union is built over `clients` only, an attach a handler makes on it
 *     (`session.create` attaches the asker) never counts as somebody watching.
 *
 * Which frames it may carry is `relayRefusal` (shared), the ONE accept rule:
 * refused ⇒ nothing ran, nothing remembered. Accepted ⇒ the ackId is marked
 * for a long keep FIRST (`acks.keepLong`, 24 h): the page that owns the row may
 * re-send the same ackId hours later, when it wakes, and must be re-acked, not
 * re-run. The keep only lengthens a record still inside its ordinary 45 min:
 * an UNKNOWN ackId whose `firstSentAt` is older than that may have run and been
 * forgotten (the page sent it first, the ack was lost), so it is never typed a
 * second time: it is answered with a refusing ACK ("may already have run") that
 * the ledger REMEMBERS for the long keep, exactly as a lost-ledger refusal is
 * (`routes/session.ts`) — the relay stores it as the row's receipt, and the
 * page's own re-send of the same ackId hears the same sentence instead of typing
 * it. A request that says `firstByRelay` (the page never attempted the row; the
 * relay stamped it) skips the check: its first POST either reached the host,
 * which then holds the ackId for 24 h, or never did, and unknown means never ran. A repeat in either direction is the ledger's ordinary job — a page
 * re-send of a relayed ackId is re-acked or joins the in-flight delivery, and
 * a relayed frame whose ackId the page already sent does the same.
 *
 * The answer: the ack frame verbatim, or `pending` once `waitMs` passed (the
 * work keeps running; its verdict lands in the ledger with the long keep, and
 * the next send of the same ackId — relay or page — is answered from there).
 */
import type { WebSocket } from "ws";
import {
  firstSentOnHostClock,
  relayRefusal,
  RELAY_STALE_REFUSAL,
  RELAY_LINK_FRAMES,
  RELAY_WAIT_MAX_MS,
  type ClientMessage,
  type ClientRole,
  type PeerKind,
  type RelayAckFrame,
  type RelayResponse,
} from "@waterplane/shared";
import { ACK_TTL_MS } from "../acks.js";

/** The sentence answering an unknown ackId first sent longer ago than the ledger remembers
 *  (worded in shared, so the phone can tell it from a refusal that proves nothing ran). */
export { RELAY_STALE_REFUSAL };

/** The `waitMs` a request that names none gets. */
export const RELAY_WAIT_DEFAULT_MS = 20_000;

/** What the relay reads, at CALL time (the factory rule of `server/`). */
export interface RelayDeps {
  readonly attached: WeakMap<WebSocket, Set<string>>;
  readonly clients: Set<WebSocket>;
  readonly wsKind: WeakMap<WebSocket, PeerKind>;
  readonly wsToken: WeakMap<WebSocket, string>;
  readonly wsDevice: WeakMap<WebSocket, string>;
  readonly wsRole: WeakMap<WebSocket, ClientRole>;
  readonly acks: {
    keepLong(ackId: string): void;
    get(ackId: string): unknown;
    remember(ackId: string, rec: { ok: boolean; reason?: string; op?: boolean }): void;
  };
  handleClientMessage(ws: WebSocket, msg: ClientMessage): void;
}

/** Who sent the request — what the token gate already admitted. */
export interface RelayWho {
  kind: PeerKind;
  tok: string | null;
  deviceId?: string;
}

/** The HTTP answer: 200 for an ack or pending, 422 for a refusal. */
export interface RelayResult {
  status: number;
  body: RelayResponse;
}

/** `waitMs` as the host honours it: a finite number clamped to 0..RELAY_WAIT_MAX_MS, else the default. */
export function relayWaitMs(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return RELAY_WAIT_DEFAULT_MS;
  return Math.min(RELAY_WAIT_MAX_MS, Math.max(0, Math.floor(raw)));
}

/**
 * A socket that is not one: what the handlers and `clients.ts`' `send` touch
 * (`readyState`, `OPEN`, `send`), the rest no-ops. `send` hands the decoded
 * frame to `onFrame` until `close()`, after which it drops everything.
 */
export function standInSocket(onFrame: (msg: { t?: unknown; ackId?: unknown }) => void): WebSocket {
  const sock = {
    OPEN: 1, CLOSED: 3, CONNECTING: 0, CLOSING: 2,
    readyState: 1,
    send(data: unknown) {
      if (sock.readyState !== 1) return;
      try { onFrame(JSON.parse(String(data))); } catch { /* not a frame we read */ }
    },
    close() { sock.readyState = 3; },
    terminate() { sock.readyState = 3; },
    ping() { /* no peer */ },
    on() { return sock; },
    once() { return sock; },
    off() { return sock; },
    removeListener() { return sock; },
  };
  return sock as unknown as WebSocket;
}

export function createRelay(ctx: RelayDeps) {
  /** One relayed frame, start to answer. Never throws. */
  async function relay(body: unknown, who: RelayWho): Promise<RelayResult> {
    const b = body && typeof body === "object" && !Array.isArray(body) ? body as { frame?: unknown; waitMs?: unknown; firstByRelay?: unknown } : {};
    const refused = relayRefusal(b.frame);
    if (refused) return { status: 422, body: { refused } };
    const frame = b.frame as ClientMessage & { ackId: string };
    const ackId = frame.ackId;
    const waitMs = relayWaitMs(b.waitMs);
    // A known ackId is re-acked whatever its age; an unknown one that the phone
    // says was first sent past the ledger's life cannot be told from never run
    // (the phone stamps the first socket WRITE, not an arrival) — unless the relay
    // itself was the first to send it, when unknown can only mean it never arrived.
    if (b.firstByRelay !== true && !ctx.acks.get(ackId)) {
      const first = firstSentOnHostClock(frame as { firstSentAt?: number; sentAt?: number }, Date.now());
      if (first && Date.now() - first.at > ACK_TTL_MS - first.margin) {
        ctx.acks.keepLong(ackId);
        ctx.acks.remember(ackId, { ok: false, reason: RELAY_STALE_REFUSAL, ...(frame.t === "session.input" || frame.t === "backlog.add" ? {} : { op: true }) });
        const reason = RELAY_STALE_REFUSAL;
        const ack: RelayAckFrame = frame.t === "session.input"
          ? { t: "input.ack", id: (frame as { id: string }).id, ackId, ok: false, reason, retryable: false }
          : frame.t === "backlog.add"
            ? { t: "backlog.ack", ackId, ok: false, reason }
            : { t: "op.ack", ackId, ok: false, reason };
        return { status: 200, body: { ack } };
      }
    }

    let settle!: (ack: RelayAckFrame | null) => void;
    const answered = new Promise<RelayAckFrame | null>((r) => { settle = r; });
    const sock = standInSocket((m) => {
      if (typeof m.t === "string" && RELAY_LINK_FRAMES.has(m.t) && m.ackId === ackId) settle(m as RelayAckFrame);
    });
    ctx.attached.set(sock, new Set());
    ctx.wsKind.set(sock, who.kind);
    if (who.tok) ctx.wsToken.set(sock, who.tok);
    if (who.deviceId) ctx.wsDevice.set(sock, who.deviceId);
    ctx.wsRole.set(sock, "relay");
    // Before the dispatch: a verdict that lands synchronously (a re-ack) or
    // long after `waitMs` must carry the long keep either way.
    ctx.acks.keepLong(ackId);
    const timer = setTimeout(() => settle(null), waitMs);
    timer.unref?.();
    try {
      ctx.handleClientMessage(sock, frame);
    } catch (e) {
      clearTimeout(timer);
      sock.close();
      return { status: 422, body: { refused: `the host could not take it: ${String((e as Error)?.message ?? e)}` } };
    }
    const ack = await answered;
    clearTimeout(timer);
    // A verdict after this point reaches the ledger, never this socket.
    sock.close();
    return ack ? { status: 200, body: { ack } } : { status: 200, body: { pending: true } };
  }
  return { relay };
}

export type Relay = ReturnType<typeof createRelay>;
