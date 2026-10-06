/**
 * DemoHost — the fake desktop the demo, the docs media and the UI journeys run
 * against. This file is the INTERFACE (WP2a of docs/analysis/demo-mode-plan.md):
 * what the swap point (WP1) may call and what the core (WP2b) must answer.
 *
 * The core is DOM-free and node-runnable without a build: no `window`, no
 * storage, no timers, no `Date.now()`. eslint holds that boundary
 * (`packages/web/src/demo/host/**` in eslint.config.js). Everything the core
 * needs from the outside world comes IN through this interface:
 *
 *   - time        → `DemoClock`, handed in; the transport advances it
 *   - sockets     → `connect(sink)`; the core pushes frames into `sink`
 *   - HTTP        → `request(req)`; plain data in, plain data out
 *   - persistence → `snapshot()` out, `restoreDemoHost()` in; the TRANSPORT
 *                   writes it to sessionStorage, never the core
 *
 * The three rules this interface exists to fix, each one a way the real queue
 * hangs or a reload loses the demo:
 *
 * 1. **A refusal is a wire verdict, never a toast** (`verdict.ts`). Durable ops
 *    wait for `op.ack`/`input.ack`/`backlog.ack` and armed answers never expire,
 *    so a message the demo cannot do is answered with the receipt its sender is
 *    waiting for, `ok:false` and a sentence. A toast instead of that receipt is
 *    a queue row retried until its give-up budget runs out.
 * 2. **At-most-once by ackId, like the real host** (`acks.ts`'s contract). A
 *    repeat ackId is re-acked with the STORED receipt and nothing runs twice.
 * 3. **State survives the watchdog reload** (`snapshot.ts`). A disconnect makes
 *    `maybeForceReload` probe `/api/health` and reload on success; in-memory
 *    state would be gone. Every handled message may change state, so the
 *    transport snapshots after each `onChange` and restores on boot.
 */
import type { ClientMessage, HostMessage } from "@waterplane/shared";
import type { DemoFaultRule } from "./faults.ts";
import type { DemoSnapshot } from "./snapshot.ts";

/** The demo's only notion of time. Never `Date.now()` in the core: tests and
 *  docs pin the instant (Playwright `page.clock`) and hand the same one here. */
export interface DemoClock {
  now(): number;
}

/**
 * One thing the core hands the transport. The core never sleeps: `afterMs` is
 * a request for the TRANSPORT to deliver later (latency faults, a scripted
 * turn that "takes" two seconds), and absent means now.
 */
export type DemoOut =
  | { kind: "frame"; msg: HostMessage; afterMs?: number }
  /** Close the socket as a dead tunnel would. The client's own reconnect and
   *  `maybeForceReload` take it from there — the demo exercises them, it does
   *  not simulate their outcome. */
  | { kind: "close"; code: number; reason: string; afterMs?: number };

/** Where a connection's frames go. One per socket. */
export type DemoSink = (out: DemoOut) => void;

/** One open socket. `receive` is what `ws.send(JSON)` becomes in demo mode. */
export interface DemoConnection {
  receive(msg: ClientMessage): void;
  close(): void;
}

/** An `/api/*` request as the transport saw it — fetch, XHR `send` or
 *  `sendBeacon`, all three reduced to this. `path` excludes the query. */
export interface DemoHttpRequest {
  method: string;
  path: string;
  query?: Record<string, string>;
  /** Already parsed when the content type was JSON; a string otherwise;
   *  absent for a bodyless request. Uploads arrive as their byte length only —
   *  the demo keeps no bytes it did not ship with. */
  body?: unknown;
  bodyBytes?: number;
  /** Request headers the transport saw set, lower-cased names — only XHR
   *  carries them (the inbox upload names its file in `x-file-name`). */
  headers?: Record<string, string>;
}

/** Plain data, so the transport builds a `Response`, an XHR state machine or
 *  nothing (a beacon) from it. Bundled media is NOT served here: `abs()` maps
 *  artifact URLs to `public/demo/…` and they never reach the core. */
export interface DemoHttpResponse {
  status: number;
  contentType: string;
  body: string;
  afterMs?: number;
}

/** The fake desktop. Built by `createDemoHost` / `restoreDemoHost` (index.ts). */
export interface DemoHost {
  readonly scenario: string;
  /** Open a socket. The core sends nothing until `hello`, like the real host. */
  connect(sink: DemoSink): DemoConnection;
  request(req: DemoHttpRequest): DemoHttpResponse;
  /** Fire whatever the scenario script has due at `clock.now()`. The transport
   *  calls it from its own timer; tests call it after moving the clock. */
  advance(): void;
  /** When `advance()` next has something to fire (a script event or a step
   *  of a scripted turn), on `DemoClock`'s scale; null = nothing pending.
   *  The transport may arm one timer for it instead of polling. */
  nextAt(): number | null;
  /** How far the scenario's `clock` steps have moved the demo ahead of
   *  `DemoClock`, ms (0 until one fires). The transport shifts the page's
   *  `Date` by it, so what the phone counts down agrees with the desktop. */
  clockShift(): number;
  /** JSON-plain, round-trips through `JSON.stringify`. See snapshot.ts. */
  snapshot(): DemoSnapshot;
  /** Called after every state change, so the transport can persist. */
  onChange(fn: () => void): () => void;
  /** Tests only. A shipped scenario carrying faults is refused at load. */
  readonly faults: DemoFaults;
}

export interface DemoFaults {
  /** Replace the active rules. `[]` clears. */
  set(rules: DemoFaultRule[]): void;
  /** What each rule has done so far, for a test to assert it fired. */
  fired(): { rule: number; count: number }[];
}
