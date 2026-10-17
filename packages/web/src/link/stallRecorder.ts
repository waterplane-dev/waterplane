import {
  NET_STALL_MS, STALL_PEERS_CAP, STALL_RING_CAP, classifyStall, pushRing,
  type StallEvent, type StallReport, type StallWs,
} from "@waterplane/shared";

/**
 * Every HTTP request this page has on the wire, and the stalls among them —
 * the phone's half of `shared/netstall.ts`. Pure (clock, timers and the
 * context reader are injected) so node pins it; `linkStalls.ts` wires it to
 * the global `fetch`/XHR patches, the socket and the document.
 *
 * Deliberately NOT `linkOps`' ledger: that one holds only the calls that
 * should blink the activity bar, while the HTTP/1.1 pool is filled by EVERY
 * request — polls, telemetry, pulls, uploads. The in-flight count at a stall is
 * the (b) evidence, so it must count them all.
 */

/** What the page knows at a given moment, each field absent when it cannot. */
export interface StallContext {
  ws?: StallWs;
  visible?: boolean;
  visForMs?: number;
  online?: boolean;
}

export interface StallDeps {
  now(): number;
  context(): StallContext;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(t: unknown): void;
  /** Something was added to the ring. */
  changed(): void;
}

interface Wire {
  id: number;
  label: string;
  method: string;
  via: "fetch" | "xhr";
  started: number;
  sent?: number;
  total?: number;
  timer: unknown;
  /** The context read when it crossed `NET_STALL_MS`. */
  snap?: Omit<StallEvent, "k" | "label" | "method" | "ageMs" | "outcome">;
}

export interface WireHandle {
  progress(sent: number, total?: number): void;
  /** `answered`: a response (any status) arrived. `fuseMs`: its fuse fired. */
  end(o: { answered: boolean; fuseMs?: number }): void;
}

export class StallRecorder {
  private seq = 0;
  private wires = new Map<number, Wire>();
  readonly ring: StallEvent[] = [];
  /** Unique per page load, so two loads' events never share a key. */
  private page: string;
  private deps: StallDeps;

  constructor(deps: StallDeps, page?: string) {
    this.deps = deps;
    this.page = page ?? deps.now().toString(36);
  }

  inflight(): number { return this.wires.size; }

  begin(label: string, method: string, via: "fetch" | "xhr"): WireHandle {
    const w: Wire = { id: ++this.seq, label, method: method.toUpperCase(), via, started: this.deps.now(), timer: null };
    this.wires.set(w.id, w);
    // Read the context AT the stall: that is when "how many were in flight"
    // means something. A timer a backgrounded page never ran falls back to
    // reading it when the request ends.
    w.timer = this.deps.setTimer(() => { if (this.wires.has(w.id)) w.snap = this.snapshot(w); }, NET_STALL_MS);
    let ended = false;
    return {
      progress: (sent, total) => { w.sent = sent; if (total != null) w.total = total; },
      end: ({ answered, fuseMs }) => {
        if (ended) return;
        ended = true;
        this.deps.clearTimer(w.timer);
        const ageMs = Math.max(0, this.deps.now() - w.started);
        const outcome = classifyStall({ ageMs, fuseFired: fuseMs != null, answered });
        const snap = outcome ? (w.snap ?? this.snapshot(w)) : null;
        this.wires.delete(w.id);
        if (!outcome || !snap) return;
        const e: StallEvent = { k: `${this.page}.${w.id}`, label: w.label, method: w.method, ageMs, outcome, ...snap };
        if (fuseMs != null) e.fuseMs = fuseMs;
        if (w.sent != null) { e.sent = w.sent; if (w.total != null) e.total = w.total; }
        this.add(e);
      },
    };
  }

  /** A JSON body that never finished after its headers did — the request's
   *  own record has already ended, so this is an event of its own. */
  bodyTimeout(label: string, method: string, fuseMs: number): void {
    const e: StallEvent = {
      k: `${this.page}.b${++this.seq}`, label, method: method.toUpperCase(), phase: "body",
      ageMs: fuseMs, fuseMs, outcome: "timeout", via: "fetch", ...this.snapshot(null),
    };
    this.add(e);
  }

  /** Requests stalled right now, oldest first. */
  openStalls(): StallEvent[] {
    const now = this.deps.now();
    const out: StallEvent[] = [];
    for (const w of this.oldestFirst()) {
      const ageMs = now - w.started;
      if (ageMs < NET_STALL_MS) continue;
      const e: StallEvent = { k: `${this.page}.${w.id}`, label: w.label, method: w.method, ageMs, outcome: "open", ...(w.snap ?? this.snapshot(w)) };
      if (w.sent != null) { e.sent = w.sent; if (w.total != null) e.total = w.total; }
      out.push(e);
    }
    return out;
  }

  report(): StallReport {
    return { events: this.ring.slice(), open: this.openStalls() };
  }

  private add(e: StallEvent): void {
    pushRing(this.ring, e, STALL_RING_CAP);
    this.deps.changed();
  }

  private oldestFirst(): Wire[] {
    return [...this.wires.values()].sort((a, b) => a.started - b.started);
  }

  private snapshot(self: Wire | null): NonNullable<Wire["snap"]> {
    const now = this.deps.now();
    const peers = this.oldestFirst().filter((w) => w !== self)
      .slice(0, STALL_PEERS_CAP)
      .map((w) => ({ label: w.label, ageMs: Math.max(0, now - w.started) }));
    const c = this.deps.context();
    const snap: NonNullable<Wire["snap"]> = { at: now, via: self?.via ?? "fetch", inflight: this.wires.size };
    if (peers.length) snap.peers = peers;
    if (c.ws) snap.ws = c.ws;
    if (c.visible != null) snap.visible = c.visible;
    if (c.visForMs != null) snap.visForMs = c.visForMs;
    if (c.online != null) snap.online = c.online;
    return snap;
  }
}
