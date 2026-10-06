/**
 * The fault hooks — how a test makes the demo misbehave the way a real tunnel
 * does. Tests and fault journeys only: `assertShippable` refuses a scenario
 * that carries any, so a shipped demo can never drop an ack on a reviewer.
 *
 * A rule is DATA (it rides in a scenario file and in a snapshot), matched
 * against each outgoing frame or incoming message. The core applies them; the
 * transport only honours `afterMs` and `close`.
 */
import type { ClientMessage, HostMessage } from "@waterplane/shared";

/** Which frames a rule applies to. All present fields must match. */
export interface DemoFaultMatch {
  /** Outgoing (`HostMessage`) or incoming (`ClientMessage`) type. */
  t?: HostMessage["t"] | ClientMessage["t"];
  /** Skip the first `from` matches (0-based): "the 3rd input.ack" is `from: 2`. */
  from?: number;
  /** Apply at most this many times; absent = every match from `from` on. */
  times?: number;
}

export type DemoFaultRule =
  /** Swallow a host frame: the client's ack window expires and it retries
   *  with the same ackId — which must re-ack, not re-run. */
  | { kind: "drop"; match: DemoFaultMatch }
  /** Send a host frame twice — a duplicated delivery must change nothing. */
  | { kind: "duplicate"; match: DemoFaultMatch }
  /** Delay a host frame. */
  | { kind: "latency"; match: DemoFaultMatch; ms: number }
  /** Close the socket after the matching INCOMING message is handled (so
   *  "mid-send" is `{ t: "session.input" }`). With `health: false` the
   *  `/api/health` probe also fails until the next `connect`, which is the
   *  reload path `maybeForceReload` takes. With `stayDown: true` the socket
   *  path stays down afterwards — the disconnect appends `{ kind: "offline",
   *  http: true }` to the rules, so every reconnect is refused while
   *  `/api/health` answers: the wedged-socket case the watchdog reload exists
   *  for. Being a rule, it survives that reload (it is in the snapshot) and
   *  ends at the next `faults.set`. */
  | { kind: "disconnect"; match: DemoFaultMatch; health?: boolean; stayDown?: boolean }
  /** Every request fails as if the device were offline: live sockets close
   *  when the rule is set, sockets close on connect, HTTP answers 503.
   *  `http: true` keeps HTTP answering (only the socket path is down).
   *  Cleared by `faults.set([])`. */
  | { kind: "offline"; http?: boolean }
  /** `welcome.protocol` lies by this much — the version-mismatch screen. */
  | { kind: "protocol"; delta: number }
  /** Session `sessionId` enters a usage-limit pause at the matching message. */
  | { kind: "limit"; match: DemoFaultMatch; sessionId: string; resetsInMs: number }
  /** A choice box appears on `sessionId` at the matching message — the
   *  "box arrives while the person is typing" case `expectPrompt` exists for. */
  | { kind: "prompt"; match: DemoFaultMatch; sessionId: string };

/** Throws when a scenario meant to ship carries fault rules. */
export function assertShippable(scenario: { meta: { id: string }; faults?: DemoFaultRule[] }): void {
  if (scenario.faults && scenario.faults.length > 0) {
    throw new Error(`demo scenario "${scenario.meta.id}" carries ${scenario.faults.length} fault rule(s); faults are for tests only`);
  }
}
