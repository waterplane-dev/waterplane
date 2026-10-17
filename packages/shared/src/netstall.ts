/**
 * HTTP stalls, as the phone saw them — the evidence for WHY a request hung.
 *
 * Observed on the APK (plain HTTP/1.1 to `100.x:8770`): requests sat for
 * minutes while the one WebSocket answered pings in 14–52 ms. Two stories fit
 * that and they need different fixes:
 *
 *   (a) a HALF-OPEN keep-alive socket reused after Doze or a network change —
 *       the evidence is the WS healthy, few requests in flight, and the stall
 *       starting right after the page became visible again;
 *   (b) Chromium's six-sockets-per-host HTTP/1.1 pool FILLED by slow calls
 *       (180 s git/stats fuses, pulls, uploads), queueing everything behind
 *       them — the evidence is six or more requests in flight at the stall.
 *       A WebSocket does not count toward that pool, which is why it stays fine.
 *
 * So every stall records what was true at that moment: how many requests were
 * in flight and which, the socket's last pong, visibility, `navigator.onLine`,
 * and whether bytes had moved. This file is the shape, the ring, the merge and
 * the summary — pure, so both ends read one definition and node pins it.
 *
 * **Absent means nobody measured.** Every context field is optional and is
 * omitted, never zeroed, when the phone could not know it; the summary's shares
 * are absent when no event carried the fact they divide by. Diagnostics only:
 * nothing here changes how a request is made.
 */

/** Past this age an in-flight request is a stall — `NetActivity`'s chip says
 *  "the connection may be down" at the same moment. */
export const NET_STALL_MS = 12000;
/** Events kept per device, on the phone and in `netstats.json` alike. */
export const STALL_RING_CAP = 50;
/** Other requests listed beside a stall (the count is uncapped). */
export const STALL_PEERS_CAP = 8;
/** Chromium's HTTP/1.1 connections per host. At or past this many in flight, a
 *  new request queues inside the browser before it reaches any socket. */
export const HTTP1_POOL_PER_HOST = 6;
/** A socket whose last pong is younger than this is healthy: the heartbeat is
 *  12 s, so two missed beats plus slack. */
export const WS_HEALTHY_PONG_MS = 30000;
/** A stall that began within this long of the page becoming visible is a
 *  stall "after wake" — the Doze/network-change story. */
export const AFTER_WAKE_MS = 30000;

/**
 * How a stalled request ended.
 *  - `timeout` — its own fuse fired (`TimeoutError`, the upload's silence fuse,
 *    a JSON body that never finished).
 *  - `late`    — it got an answer (any status), after `NET_STALL_MS`.
 *  - `failed`  — a transport error or a caller's abort, after `NET_STALL_MS`.
 *  - `open`    — still in flight when the report was made.
 */
export type StallOutcome = "timeout" | "late" | "failed" | "open";
export const STALL_OUTCOMES: readonly StallOutcome[] = ["timeout", "late", "failed", "open"];

export interface StallPeer {
  label: string;
  ageMs: number;
}

/** The socket at the stall. `open` alone is known whenever there is a socket. */
export interface StallWs {
  open: boolean;
  /** Since the newest heartbeat pong. Absent: no pong yet on this page. */
  pongAgeMs?: number;
  /** That pong's round trip. */
  rttMs?: number;
}

export interface StallEvent {
  /** Unique per event (`<page>.<seq>`), so a re-sent ring merges idempotently. */
  k: string;
  /** Epoch ms the context below was read — the stall's onset where a timer
   *  could fire, else the moment it ended. */
  at: number;
  /** `labelForUrl`'s words for the request. */
  label: string;
  method: string;
  /** `fetch` or `xhr`. */
  via?: "fetch" | "xhr";
  /** Only for a JSON body that stalled after its headers. */
  phase?: "body";
  /** How old the request was when it ended (or at the report, for `open`). */
  ageMs: number;
  /** The fuse that was armed, when known. */
  fuseMs?: number;
  outcome: StallOutcome;
  /** HTTP requests in flight at `at`, this one included. */
  inflight?: number;
  /** The others, oldest first, capped at `STALL_PEERS_CAP`. */
  peers?: StallPeer[];
  ws?: StallWs;
  visible?: boolean;
  /** How long the page had been in its current visibility at `at`. Absent
   *  until the first visibility change on this page — a load is not a wake. */
  visForMs?: number;
  online?: boolean;
  /** Uploads: request-body bytes sent and expected. */
  sent?: number;
  total?: number;
}

/** What a phone sends over the socket (`net.stalls`). */
export interface StallReport {
  /** Finished stalls, newest last. Re-sent whole; the host merges on `k`. */
  events: StallEvent[];
  /** Requests stalled right now. Replaces the previous list, never merged. */
  open?: StallEvent[];
}

/** Per device in `netstats.json`: `clients[id].stalls`. */
export interface StallSummary {
  /** Newest event or open-list update. */
  updatedAt: number;
  /** Every distinct event ever merged in this window, by outcome — counts
   *  outlive the ring. */
  counts: Partial<Record<Exclude<StallOutcome, "open">, number>>;
  /** Stalled right now (from the newest report). */
  openNow: number;
  /** Over the ring: */
  ageP95Ms?: number;
  maxInflight?: number;
  /** Of the events that carried `inflight`: share at or past the HTTP/1.1 pool. */
  poolFullShare?: number;
  /** Of the events that carried `ws`: share with the socket healthy. */
  wsHealthyShare?: number;
  /** Of the events that carried `visForMs` while visible: share within `AFTER_WAKE_MS` of becoming visible. */
  afterWakeShare?: number;
  /** Of the uploads that carried `sent`: share where no byte had left. */
  zeroBytesShare?: number;
  /** How many events the shares are over. */
  sampled: number;
}

export interface ClientStalls extends StallSummary {
  open: StallEvent[];
  events: StallEvent[];
}

/** Push onto a bounded ring, dropping the oldest. Mutates and returns it. */
export function pushRing<T>(ring: T[], v: T, cap = STALL_RING_CAP): T[] {
  ring.push(v);
  if (ring.length > cap) ring.splice(0, ring.length - cap);
  return ring;
}

/**
 * The outcome of a request that ended, or null when it was not a stall.
 * A fuse that fired is always a stall, even under `NET_STALL_MS` (a 10 s fuse
 * is still a request that never answered); anything else must have been old.
 */
export function classifyStall(o: { ageMs: number; fuseFired: boolean; answered: boolean }): StallOutcome | null {
  if (o.fuseFired) return "timeout";
  if (!(o.ageMs >= NET_STALL_MS)) return null;
  return o.answered ? "late" : "failed";
}

/** Healthy socket: open, with a pong younger than `WS_HEALTHY_PONG_MS`.
 *  Null when that cannot be told (open, but no pong measured yet). */
export function wsHealthy(ws: StallWs | undefined): boolean | null {
  if (!ws) return null;
  if (!ws.open) return false;
  if (ws.pongAgeMs == null) return null;
  return ws.pongAgeMs <= WS_HEALTHY_PONG_MS;
}

function pct(arr: readonly number[], p: number): number | undefined {
  if (!arr.length) return undefined;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((s.length - 1) * p))];
}

function share(hits: number, of: number): number | undefined {
  return of > 0 ? Math.round((hits / of) * 1000) / 1000 : undefined;
}

/** The shares and maxima over a set of events. Each share is absent when no
 *  event carried the fact it needs — never a zero standing in for "unknown". */
export function stallStats(events: readonly StallEvent[]): Omit<StallSummary, "updatedAt" | "counts" | "openNow"> {
  const inflight = events.filter((e) => e.inflight != null);
  let wsKnown = 0, wsOk = 0;
  for (const e of events) {
    const h = wsHealthy(e.ws);
    if (h == null) continue;
    wsKnown++;
    if (h) wsOk++;
  }
  const woke = events.filter((e) => e.visible === true && e.visForMs != null);
  const ups = events.filter((e) => e.sent != null);
  const out: Omit<StallSummary, "updatedAt" | "counts" | "openNow"> = { sampled: events.length };
  const p95 = pct(events.map((e) => e.ageMs), 0.95);
  if (p95 != null) out.ageP95Ms = p95;
  if (inflight.length) out.maxInflight = Math.max(...inflight.map((e) => e.inflight!));
  const pool = share(inflight.filter((e) => e.inflight! >= HTTP1_POOL_PER_HOST).length, inflight.length);
  if (pool != null) out.poolFullShare = pool;
  const ws = share(wsOk, wsKnown);
  if (ws != null) out.wsHealthyShare = ws;
  const wake = share(woke.filter((e) => e.visForMs! <= AFTER_WAKE_MS).length, woke.length);
  if (wake != null) out.afterWakeShare = wake;
  const zero = share(ups.filter((e) => e.sent === 0).length, ups.length);
  if (zero != null) out.zeroBytesShare = zero;
  return out;
}

// ── cleaning (the host's way IN) ────────────────────────────────────────────

function n(v: unknown, max: number): number | undefined {
  if (typeof v !== "number" || !Number.isFinite(v)) return undefined;
  return Math.max(0, Math.min(max, Math.round(v)));
}
function s(v: unknown, max: number): string | undefined {
  return typeof v === "string" && v ? v.slice(0, max) : undefined;
}
const DAY = 86_400_000;

/**
 * One event, REBUILT from the fields it names — a field nobody named here is
 * dropped, which is the point: the file is read by people and agents, and a
 * client must not be able to grow it. Null when the event cannot say what it
 * is (no key, no label, no outcome, no age).
 */
export function cleanStallEvent(raw: unknown): StallEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const k = s(r.k, 40);
  const label = s(r.label, 60);
  const outcome = STALL_OUTCOMES.includes(r.outcome as StallOutcome) ? (r.outcome as StallOutcome) : undefined;
  const ageMs = n(r.ageMs, DAY);
  const at = n(r.at, 9e15);
  if (!k || !label || !outcome || ageMs == null || at == null) return null;
  const e: StallEvent = { k, at, label, method: s(r.method, 10)?.toUpperCase() ?? "GET", ageMs, outcome };
  if (r.via === "fetch" || r.via === "xhr") e.via = r.via;
  if (r.phase === "body") e.phase = "body";
  const fuse = n(r.fuseMs, DAY); if (fuse != null) e.fuseMs = fuse;
  const inf = n(r.inflight, 10_000); if (inf != null) e.inflight = inf;
  if (Array.isArray(r.peers)) {
    const peers: StallPeer[] = [];
    for (const p of r.peers.slice(0, STALL_PEERS_CAP)) {
      const pl = s((p as StallPeer)?.label, 60);
      const pa = n((p as StallPeer)?.ageMs, DAY);
      if (pl && pa != null) peers.push({ label: pl, ageMs: pa });
    }
    if (peers.length) e.peers = peers;
  }
  if (r.ws && typeof r.ws === "object") {
    const w = r.ws as Record<string, unknown>;
    if (typeof w.open === "boolean") {
      const ws: StallWs = { open: w.open };
      const pong = n(w.pongAgeMs, DAY); if (pong != null) ws.pongAgeMs = pong;
      const rtt = n(w.rttMs, 600_000); if (rtt != null) ws.rttMs = rtt;
      e.ws = ws;
    }
  }
  if (typeof r.visible === "boolean") e.visible = r.visible;
  const vis = n(r.visForMs, 30 * DAY); if (vis != null) e.visForMs = vis;
  if (typeof r.online === "boolean") e.online = r.online;
  const sent = n(r.sent, 1e10); if (sent != null) e.sent = sent;
  const total = n(r.total, 1e10); if (total != null) e.total = total;
  return e;
}

/**
 * Fold one report into what the host holds for a device. Idempotent on `k`:
 * the phone re-sends its whole ring, and a repeat neither duplicates a row nor
 * counts twice. `open` replaces. The ring keeps the newest `STALL_RING_CAP`.
 */
export function mergeStalls(prev: ClientStalls | undefined, raw: unknown, now: number): ClientStalls {
  const r = (raw ?? {}) as Record<string, unknown>;
  const known = new Map<string, StallEvent>();
  for (const e of prev?.events ?? []) known.set(e.k, e);
  const counts = { ...(prev?.counts ?? {}) };
  const incoming = Array.isArray(r.events) ? r.events.slice(-STALL_RING_CAP * 2) : [];
  for (const x of incoming) {
    const e = cleanStallEvent(x);
    if (!e || e.outcome === "open" || known.has(e.k)) continue;
    known.set(e.k, e);
    counts[e.outcome] = (counts[e.outcome] ?? 0) + 1;
  }
  const events = [...known.values()].sort((a, b) => a.at - b.at).slice(-STALL_RING_CAP);
  const open = Array.isArray(r.open)
    ? r.open.slice(0, STALL_RING_CAP).map(cleanStallEvent).filter((e): e is StallEvent => !!e).map((e) => ({ ...e, outcome: "open" as const }))
    : (prev?.open ?? []);
  return { updatedAt: now, counts, openNow: open.length, ...stallStats(events), open, events };
}

/** One line per device for the CLI readout (`scripts/netstalls.mjs`). Says
 *  only what the summary holds; an absent share is not printed. */
export function stallSummaryLines(id: string, st: ClientStalls): string[] {
  const c = st.counts ?? {};
  const pc = (v: number | undefined) => (v == null ? null : `${Math.round(v * 100)}%`);
  const sec = (ms: number | undefined) => (ms == null ? null : `${Math.round(ms / 1000)}s`);
  const parts = [
    `timeout ${c.timeout ?? 0}`, `late ${c.late ?? 0}`, `failed ${c.failed ?? 0}`, `open now ${st.openNow ?? 0}`,
  ];
  const facts = [
    sec(st.ageP95Ms) && `age p95 ${sec(st.ageP95Ms)}`,
    st.maxInflight != null && `max in flight ${st.maxInflight}`,
    pc(st.poolFullShare) && `>=${HTTP1_POOL_PER_HOST} in flight ${pc(st.poolFullShare)}`,
    pc(st.wsHealthyShare) && `ws healthy ${pc(st.wsHealthyShare)}`,
    pc(st.afterWakeShare) && `after wake ${pc(st.afterWakeShare)}`,
    pc(st.zeroBytesShare) && `uploads with 0 B sent ${pc(st.zeroBytesShare)}`,
  ].filter(Boolean);
  return [
    `${id}: ${parts.join(" · ")}`,
    facts.length ? `  over the last ${st.sampled}: ${facts.join(" · ")}` : `  no events in the ring`,
  ];
}
