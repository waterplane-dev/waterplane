/**
 * Connectivity + delivery telemetry — "where do my prompts actually go?".
 *
 * Everything else in this daemon reports the CURRENT state of the link:
 * `speedtest.ts` measures throughput when you ask it to, `NetActivity` shows a
 * request that is on the wire right now, the reconnect banner shows a socket
 * that is down right now. None of it survives the moment, and the failures that
 * matter here are the ones you only notice afterwards — "I typed that twenty
 * minutes ago and nothing happened". A question about the past needs a record of
 * the past, so this is the record.
 *
 * Two populations, deliberately kept apart:
 *
 *   • HOST-side facts, counted here as they happen: sockets opening and closing
 *     (with the close code and the peer's trust tier — a tailnet peer dropping
 *     is a tunnel problem, a LAN peer dropping is not), and — the load-bearing
 *     one — the outcome of every VERIFIED compose delivery. `deliver.ts` already
 *     knows the difference between "the turn started", "the Return was
 *     swallowed" and "I typed it but never saw it echo"; nothing was keeping
 *     score, so a phone that loses a prompt a day had no way to show that it
 *     was happening at all, let alone which of the three it was.
 *
 *   • ACK REPLAYS, which are the single most useful number in the file. A replay
 *     means the client re-sent an ackId the host had already handled: the work
 *     was done, and the phone never saw the receipt. That is a pure measure of
 *     the tunnel eating return traffic, and it is invisible from either end
 *     alone — the host thinks it answered, the client thinks it was ignored.
 *
 *   • CLIENT roll-ups, POSTed by the phone (see web/netlog.ts). The host cannot
 *     see socket RTT as the phone experiences it, how long text sat queued, or
 *     how often the app was reloaded by the watchdog. The client computes a
 *     small summary and ships it; we store the newest one per device and never
 *     merge them, because two phones on one host have genuinely different links
 *     and averaging them would hide the bad one.
 *
 * Bounded and best-effort throughout, exactly like `uistats.ts`: capped device
 * count, debounced atomic writes, and every I/O failure degrades to in-memory
 * counting rather than throwing into a request path. Nothing here leaves the
 * machine — the point of the file is that you (or a coding agent) can read it.
 */
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { hostStateDir } from "./branddirs.js";
import { readJsonGuarded, writeJsonAtomic } from "./jsonstore.js";

/** How far a verified compose delivery got — mirrors deliver.ts's result. */
export type DeliveryOutcome = "ok" | "retry" | "unconfirmed" | "unsubmitted";

/** What one phone reported about its own side of the link. Free-form-ish on
 *  purpose: the client owns these definitions, and a host that validated their
 *  meaning would have to be edited every time the client learns to measure one
 *  more thing. Numbers only, and sanity-capped on the way in. */
export interface ClientReport {
  /** When the phone sent it. */
  at: number;
  /** Start of the window these numbers cover. */
  since: number;
  /** Socket round-trip (ws ping→pong), milliseconds. */
  rttP50?: number;
  rttP95?: number;
  /** Socket lifecycle over the window. */
  reconnects?: number;
  /** Fraction of the window with no open socket, 0..1. */
  offlineShare?: number;
  /** Watchdog hard-reloads (ws.ts's last resort). */
  reloads?: number;
  /** Sends: queued → confirmed, milliseconds. */
  sendP50?: number;
  sendP95?: number;
  /** Send outcomes over the window. */
  sent?: number;
  failed?: number;
  expired?: number;
  /** Receipt deadlines that passed with nothing back. */
  ackTimeouts?: number;
  /** Longest a message sat in the queue, milliseconds. */
  queuedMaxMs?: number;
  /** Whatever the client calls itself — a label, not an identity. */
  ua?: string;
}

export interface NetStatsDoc {
  updatedAt: number;
  /** Start of the counting window; `reset()` moves it. */
  since: number;
  sockets: {
    opened: number;
    closed: number;
    /** Close codes seen, `{ "1006": 12 }`. 1006 (abnormal) is the tunnel dying. */
    closeCodes: Record<string, number>;
    /** Opens per trust tier, `{ tailscale: 40, loopback: 3 }` (see net.peerKind). */
    byPeer: Record<string, number>;
    /** Most sockets open at once — a phone that keeps orphaning them shows here. */
    peakConcurrent: number;
    /** Summed lifetime of every CLOSED socket, ms (÷ closed = mean session). */
    totalOpenMs: number;
    /** Shortest-lived socket, ms. A handful of sub-second opens means the
     *  handshake itself is failing, which looks nothing like a slow link. */
    minOpenMs: number | null;
  };
  /** Verified compose deliveries, by how far they got. */
  delivery: Record<DeliveryOutcome, number>;
  /** Retries that found the work already done — receipts the phone never saw. */
  ackReplays: number;
  /** Newest report per device, keyed by the id the client mints for itself. */
  clients: Record<string, ClientReport>;
}

const MAX_CLIENTS = 12;
const MAX_CLOSE_CODES = 24;
const SAVE_DEBOUNCE_MS = 3000;

function emptyDoc(now: number): NetStatsDoc {
  return {
    updatedAt: now,
    since: now,
    sockets: { opened: 0, closed: 0, closeCodes: {}, byPeer: {}, peakConcurrent: 0, totalOpenMs: 0, minOpenMs: null },
    delivery: { ok: 0, retry: 0, unconfirmed: 0, unsubmitted: 0 },
    ackReplays: 0,
    clients: {},
  };
}

/** Clamp an incoming number into something a buggy or hostile client cannot use
 *  to grow the file or poison the readout. Non-finite ⇒ dropped entirely. */
function num(v: unknown, max: number): number | undefined {
  if (typeof v !== "number" || !Number.isFinite(v)) return undefined;
  return Math.max(0, Math.min(max, Math.round(v)));
}

export class NetStats {
  private path: string;
  private doc: NetStatsDoc;
  private timer: NodeJS.Timeout | null = null;
  /** Open sockets → when they opened, so a close can price its lifetime. */
  private open = new Map<object, number>();

  constructor(root: string) {
    this.path = join(hostStateDir(root), "netstats.json");
    const now = Date.now();
    let loaded: NetStatsDoc | null = null;
    try {
      if (existsSync(this.path)) loaded = readJsonGuarded<any>(this.path, null) as NetStatsDoc;
    } catch { /* unreadable/corrupt → start fresh, same as never having run */ }
    this.doc = loaded && typeof loaded.since === "number" ? { ...emptyDoc(now), ...loaded } : emptyDoc(now);
    // A doc written by an older build may be missing whole sections; fill them
    // in rather than letting a `++` land on undefined.
    const blank = emptyDoc(now);
    this.doc.sockets = { ...blank.sockets, ...this.doc.sockets };
    this.doc.delivery = { ...blank.delivery, ...this.doc.delivery };
    this.doc.clients = this.doc.clients ?? {};
  }

  snapshot(): NetStatsDoc {
    // Report the sockets that are open RIGHT NOW too — otherwise a host that has
    // been up for a week with one healthy phone reads as "0 concurrent".
    return { ...this.doc, sockets: { ...this.doc.sockets, peakConcurrent: Math.max(this.doc.sockets.peakConcurrent, this.open.size) } };
  }

  /** Reset the window. The file stays, so "since" is honest about what it covers. */
  reset(): NetStatsDoc {
    this.doc = emptyDoc(Date.now());
    this.persist();
    return this.doc;
  }

  noteSocketOpen(key: object, peerKind: string): void {
    this.open.set(key, Date.now());
    const s = this.doc.sockets;
    s.opened++;
    s.byPeer[peerKind] = (s.byPeer[peerKind] ?? 0) + 1;
    s.peakConcurrent = Math.max(s.peakConcurrent, this.open.size);
    this.schedule();
  }

  noteSocketClose(key: object, code: number): void {
    const at = this.open.get(key);
    this.open.delete(key);
    const s = this.doc.sockets;
    s.closed++;
    const c = String(code || 0);
    // Cap the code map: codes are a small fixed set in practice, but a client
    // closing with arbitrary application codes must not grow the file forever.
    if (s.closeCodes[c] !== undefined || Object.keys(s.closeCodes).length < MAX_CLOSE_CODES) {
      s.closeCodes[c] = (s.closeCodes[c] ?? 0) + 1;
    }
    if (at != null) {
      const life = Math.max(0, Date.now() - at);
      s.totalOpenMs += life;
      s.minOpenMs = s.minOpenMs == null ? life : Math.min(s.minOpenMs, life);
    }
    this.schedule();
  }

  noteDelivery(outcome: DeliveryOutcome): void {
    this.doc.delivery[outcome] = (this.doc.delivery[outcome] ?? 0) + 1;
    this.schedule();
  }

  /** A client re-sent an ackId we had already handled (or were still handling).
   *  The work was done and the receipt never made it back — see the header. */
  noteAckReplay(): void {
    this.doc.ackReplays++;
    this.schedule();
  }

  /** Store one phone's roll-up. Newest wins; devices beyond the cap are dropped
   *  oldest-report-first, so an occasional visitor can't evict the daily driver. */
  putClientReport(deviceId: string, raw: unknown): void {
    const id = String(deviceId || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 32);
    if (!id) return;
    const r = (raw ?? {}) as Record<string, unknown>;
    const now = Date.now();
    const rep: ClientReport = {
      at: now,
      since: num(r.since, now) ?? now,
      rttP50: num(r.rttP50, 600_000),
      rttP95: num(r.rttP95, 600_000),
      reconnects: num(r.reconnects, 1e6),
      offlineShare: typeof r.offlineShare === "number" && Number.isFinite(r.offlineShare)
        ? Math.max(0, Math.min(1, Math.round(r.offlineShare * 1000) / 1000))
        : undefined,
      reloads: num(r.reloads, 1e6),
      sendP50: num(r.sendP50, 86_400_000),
      sendP95: num(r.sendP95, 86_400_000),
      sent: num(r.sent, 1e7),
      failed: num(r.failed, 1e7),
      expired: num(r.expired, 1e7),
      ackTimeouts: num(r.ackTimeouts, 1e7),
      queuedMaxMs: num(r.queuedMaxMs, 86_400_000),
      ua: typeof r.ua === "string" ? r.ua.slice(0, 120) : undefined,
    };
    this.doc.clients[id] = rep;
    const ids = Object.keys(this.doc.clients);
    if (ids.length > MAX_CLIENTS) {
      ids.sort((a, b) => (this.doc.clients[a].at ?? 0) - (this.doc.clients[b].at ?? 0));
      for (const drop of ids.slice(0, ids.length - MAX_CLIENTS)) delete this.doc.clients[drop];
    }
    this.schedule();
  }

  flush(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.persist();
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.persist(); }, SAVE_DEBOUNCE_MS);
    this.timer.unref?.(); // never hold the daemon open for a stats file
  }

  /** tmp + rename, same as acks.ts: a kill mid-write must not leave truncated
   *  JSON that the constructor's catch turns into a silently empty window. */
  private persist(): void {
    this.doc.updatedAt = Date.now();
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writeJsonAtomic(this.path, this.doc, { space: 2 });
    } catch { /* best effort — counting continues in memory */ }
  }
}
