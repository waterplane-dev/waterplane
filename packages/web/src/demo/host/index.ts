/**
 * The dispatcher: one `DemoHost` over the handler table, the ack ledger, the
 * fault rules and the scenario script. The rules it applies are argued in
 * types.ts (the three), verdict.ts (receipts), snapshot.ts (reload) and
 * faults.ts; this file only wires them.
 */
import { PROTOCOL_VERSION } from "@waterplane/shared";
import type { ClientMessage, HostMessage } from "@waterplane/shared";
import { fireDue, nextDue, openBox, runStep, schedule, updateSession } from "./desk.ts";
import { demoUsage, HANDLERS, helloFrames } from "./handlers.ts";
import { demoHttp, healthCounts } from "./demohttp.ts";
import { modelOf } from "./model.ts";
import type { Desk } from "./model.ts";
import type { Handler, HandlerCtx } from "./handlers.ts";
import type { DemoFaultMatch, DemoFaultRule } from "./faults.ts";
import type { DemoScenario } from "./scenario.ts";
import { readSnapshot, SNAPSHOT_V } from "./snapshot.ts";
import type { DemoSnapshot } from "./snapshot.ts";
import type { DemoClock, DemoHost, DemoHttpRequest, DemoHttpResponse, DemoOut, DemoSink } from "./types.ts";
import { ackIdOf, NOT_IN_DEMO, receiptFor, refuse } from "./verdict.ts";
import { tickWaiting } from "./waiting.ts";

export type { DemoClock, DemoConnection, DemoHost, DemoHttpRequest, DemoHttpResponse, DemoOut, DemoSink } from "./types.ts";
export type { DemoScenario } from "./scenario.ts";
export type { DemoSnapshot } from "./snapshot.ts";
export type { DemoFaultRule } from "./faults.ts";
export type { DemoModel, DemoReply, DemoStep, DemoTimedStep } from "./model.ts";
export { assertShippable } from "./faults.ts";
export { NOT_IN_DEMO, refuse, receiptFor, RECEIPTS, DURABLE_OPS } from "./verdict.ts";

/** JSON-plain copy: the snapshot rule's round trip, applied at every boundary
 *  so nothing held in memory differs from what a reload would restore. */
const plain = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** A fresh demo seeded from `scenario`. */
export function createDemoHost(scenario: DemoScenario, clock: DemoClock): DemoHost {
  return build(scenario, clock, {
    v: SNAPSHOT_V,
    protocol: PROTOCOL_VERSION,
    scenario: scenario.meta.id,
    stamp: scenario.meta.stamp,
    startedAt: clock.now(),
    scriptPos: 0,
    state: plain(scenario.state),
    acks: {},
    faults: plain(scenario.faults ?? []),
    faultHits: (scenario.faults ?? []).map(() => 0),
  });
}

/** The demo as `raw` left it — or fresh, when `raw` is not a snapshot of this
 *  scenario at this protocol (all or nothing; see snapshot.ts). */
export function restoreDemoHost(scenario: DemoScenario, clock: DemoClock, raw: unknown): DemoHost {
  const snap = readSnapshot(raw, { scenario: scenario.meta.id, stamp: scenario.meta.stamp, protocol: PROTOCOL_VERSION });
  return snap ? build(scenario, clock, plain(snap)) : createDemoHost(scenario, clock);
}

function build(scenario: DemoScenario, clock: DemoClock, s: DemoSnapshot): DemoHost {
  if (scenario.meta.protocol !== PROTOCOL_VERSION) {
    throw new Error(`demo scenario "${scenario.meta.id}" was recorded at protocol ${scenario.meta.protocol}, this build speaks ${PROTOCOL_VERSION}`);
  }
  // Every demo desktop holds a usage reading (see `demoUsage`); a scenario's own wins. Written into
  // the state so the snapshot, a reload and the `usage.*` handlers all see the one reading.
  const held = modelOf(s.state);
  if (held && !held.numbers?.usage) (held.numbers ??= {}).usage = demoUsage(s.startedAt);
  const sinks = new Set<DemoSink>();
  /** Per socket: the sessions it is attached to. Transient like the socket —
   *  a reconnecting client re-attaches, as it does against the real host. */
  const attached = new Map<DemoSink, Set<string>>();
  const listeners = new Set<() => void>();
  /** Transient on purpose: the reload it causes only happens once health is up. */
  let healthDown = false;

  const changed = () => { for (const fn of listeners) fn(); };
  /** Any `offline` rule refuses sockets; only one without `http` fails HTTP too. */
  const offline = () => s.faults.some((r) => r.kind === "offline");
  const httpDown = () => s.faults.some((r) => r.kind === "offline" && !r.http);

  /** Count a match of rule `i` against `t`; true when the rule applies now. */
  function hit(i: number, match: DemoFaultMatch, t: string): boolean {
    if (match.t && match.t !== t) return false;
    const n = s.faultHits[i]++;
    const from = match.from ?? 0;
    return n >= from && (match.times == null || n < from + match.times);
  }

  function emit(sink: DemoSink, msg: HostMessage): void {
    let copies = 1;
    let afterMs: number | undefined;
    s.faults.forEach((r, i) => {
      if (r.kind === "drop" && hit(i, r.match, msg.t)) copies = 0;
      else if (r.kind === "duplicate" && hit(i, r.match, msg.t)) copies = copies && 2;
      else if (r.kind === "latency" && hit(i, r.match, msg.t)) afterMs = (afterMs ?? 0) + r.ms;
    });
    const out: DemoOut = afterMs == null ? { kind: "frame", msg } : { kind: "frame", msg, afterMs };
    for (let k = 0; k < copies; k++) sink(out);
  }

  /** How far `clock` steps have moved the demo ahead of the injected clock. */
  const shift = () => modelOf(s.state).clockShift ?? 0;
  /** The demo's time: the injected clock plus every jump a script made. */
  const now = () => clock.now() + shift();
  const desk: Desk = {
    get m() { return modelOf(s.state); },
    now,
    get bootId() { return s.state.bootId; },
    broadcast: (m) => { for (const k of sinks) emit(k, m); },
    toSession: (id, m) => { for (const k of sinks) if (attached.get(k)?.has(id)) emit(k, m); },
  };

  function welcome(): HostMessage {
    const delta = s.faults.reduce((d, r) => (r.kind === "protocol" ? d + r.delta : d), 0);
    return {
      t: "welcome", protocol: PROTOCOL_VERSION + delta, bootId: s.state.bootId,
      tailscaleIp: null, tailscaleBin: null, tailscaleDns: null, httpsUrl: null, lanIps: [], port: 0,
      root: "demo", tmux: false, clientKind: "loopback",
      auth: { enabled: false, gateTailscale: false, canManage: false }, hostName: "Demo",
    };
  }

  function dispatch(sink: DemoSink, msg: ClientMessage): void {
    if (msg.t === "hello") {
      emit(sink, welcome());
      for (const f of helloFrames(desk.m)) emit(sink, f);
      return;
    }
    const entry = (HANDLERS as Record<string, Handler<ClientMessage["t"]> | undefined>)[msg.t];
    // Unknown `t`: ignored, as the real router does — a newer client is not an error.
    if (!entry) return;

    const ackId = ackIdOf(msg);
    const seen = ackId ? s.acks[ackId] : undefined;
    if (seen) { emit(sink, seen); return; }

    let out: HostMessage | null;
    if (entry.tier === "A") {
      const ctx: HandlerCtx<ClientMessage["t"]> = {
        msg, now: now(), state: s.state, desk,
        reply: (m) => emit(sink, m),
        broadcast: desk.broadcast,
        attach: (id) => { attached.get(sink)?.add(id); },
        detach: (id) => { attached.get(sink)?.delete(id); },
      };
      out = receiptFor(msg, entry.run(ctx) ?? { ok: true });
    } else {
      out = refuse(msg, entry.tier === "B" ? entry.reason ?? NOT_IN_DEMO : NOT_IN_DEMO);
      if (out.t === "toast") { emit(sink, out); return; }
    }
    if (out) {
      out = plain(out);
      if (ackId) s.acks[ackId] = out;
      emit(sink, out);
    }
    // Steps a handler laid out for "now" (a reply's first line) go out now.
    fireDue(desk);
    // A cap raised, a turn begun: the waiting rows a person sent are re-asked.
    tickWaiting(desk);
    changed();
  }

  /** Incoming-side faults, after the message was handled. */
  function afterReceive(sink: DemoSink, msg: ClientMessage): void {
    s.faults.forEach((r: DemoFaultRule, i) => {
      if (r.kind === "disconnect" && hit(i, r.match, msg.t)) {
        if (r.health === false) healthDown = true;
        if (r.stayDown) { s.faults.push({ kind: "offline", http: true }); s.faultHits.push(0); }
        sinks.delete(sink);
        attached.delete(sink);
        sink({ kind: "close", code: 1006, reason: "demo fault: disconnect" });
      } else if (r.kind === "limit" && hit(i, r.match, msg.t)) {
        const at = now();
        const resetAt = at + r.resetsInMs;
        updateSession(desk, r.sessionId, {
          limit: { blocked: true, blockedSince: at, resetAt, nextAttemptAt: resetAt, attempts: 0, weekly: false, autoContinue: true, autoContinueOverride: null, queuePos: null, resuming: false, first: false },
        });
        schedule(desk, r.sessionId, [{ kind: "session", patch: {}, unset: ["limit"], afterMs: r.resetsInMs }]);
        changed();
      } else if (r.kind === "prompt" && hit(i, r.match, msg.t)) {
        openBox(desk, r.sessionId);
        changed();
      }
    });
  }

  return {
    scenario: scenario.meta.id,
    connect(sink) {
      if (offline()) {
        sink({ kind: "close", code: 1006, reason: "demo fault: offline" });
        return { receive() {}, close() {} };
      }
      healthDown = false;
      sinks.add(sink);
      attached.set(sink, new Set());
      return {
        receive(msg) {
          if (!sinks.has(sink)) return;
          dispatch(sink, msg);
          afterReceive(sink, msg);
        },
        close() { sinks.delete(sink); attached.delete(sink); },
      };
    },
    request(req: DemoHttpRequest): DemoHttpResponse {
      if (httpDown()) return { status: 503, contentType: "text/plain", body: "offline" };
      if (req.path === "/api/health") {
        if (healthDown) return { status: 503, contentType: "text/plain", body: "unreachable" };
        return { status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, protocol: PROTOCOL_VERSION, root: "demo", ...healthCounts(desk.m) }) };
      }
      const res = demoHttp(desk.m, now(), req);
      if (req.method !== "GET" && res.status < 300) changed();
      return res;
    },
    advance() {
      const elapsed = now() - s.startedAt;
      let fired = false;
      while (s.scriptPos < scenario.script.length && scenario.script[s.scriptPos].at <= elapsed) {
        runStep(desk, scenario.script[s.scriptPos++].event);
        fired = true;
      }
      if (fireDue(desk)) fired = true;
      if (fired) { tickWaiting(desk); changed(); }
    },
    nextAt() {
      const script = s.scriptPos < scenario.script.length ? s.startedAt + scenario.script[s.scriptPos].at : null;
      const due = nextDue(desk.m);
      const next = script == null ? due : due == null ? script : Math.min(script, due);
      // Promised on the INJECTED clock's scale, which the transport's timer reads.
      return next == null ? null : next - shift();
    },
    clockShift: shift,
    snapshot: () => plain(s),
    onChange(fn) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    faults: {
      set(rules) {
        s.faults = plain(rules);
        s.faultHits = rules.map(() => 0);
        // Going offline drops the sockets that are open now, not only the next ones.
        if (offline()) {
          for (const k of [...sinks]) { sinks.delete(k); attached.delete(k); k({ kind: "close", code: 1006, reason: "demo fault: offline" }); }
        }
        changed();
      },
      fired: () => s.faults.map((r, i) => {
        const m = "match" in r ? r.match : {};
        const n = Math.max(0, s.faultHits[i] - (m.from ?? 0));
        return { rule: i, count: m.times == null ? n : Math.min(n, m.times) };
      }),
    },
  };
}
