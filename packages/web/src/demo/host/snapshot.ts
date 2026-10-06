/**
 * The persisted-state / reload rule.
 *
 * A dropped socket makes `maybeForceReload` (ws.ts) probe `/api/health` and
 * reload the page when it answers — and the demo answers. Without this, every
 * tap the person made (a backlog row, an answered box, an armed schedule) is
 * gone after the reload, and so is the ack ledger, which means a queued op
 * replayed after the reload would RUN AGAIN: the exact double-run the ledger
 * exists to prevent.
 *
 * The rule:
 *   - Everything that must survive is in `DemoSnapshot`, and it is JSON-plain
 *     (no Map, no Date, no undefined-as-meaning, no functions): a round trip
 *     through `JSON.stringify`/`JSON.parse` is the identity.
 *   - The CORE never stores it. `DemoHost.onChange` fires after each state
 *     change; the transport (WP1) writes `snapshot()` to sessionStorage under
 *     a per-scenario key registered in `storage.ts`, and hands the parsed value
 *     to `restoreDemoHost` on boot. sessionStorage, not localStorage: a new tab
 *     is a fresh demo, a reload of this one is not.
 *   - Restore is all or nothing. `readSnapshot` returns null on any mismatch —
 *     schema `v`, `PROTOCOL_VERSION`, scenario id or scenario stamp — and the
 *     caller seeds fresh from the scenario. A half-restored demo is worse than
 *     a fresh one: it answers with a ledger that does not match its state.
 */
import type { HostMessage } from "@waterplane/shared";
import type { DemoFaultRule } from "./faults.ts";

export const SNAPSHOT_V = 1;

/** Any JSON value — the bound on what the model may hold. */
export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

/**
 * The model the handlers mutate: a tap changes what the next screen shows.
 * WP2b owns the fields inside `model` (repos, sessions, PTY screens, backlog,
 * schedules, gallery, numbers); this file fixes only that they are JSON.
 */
export interface DemoState {
  /** `welcome.bootId`. Stable across a reload: a CHANGED boot id tells the
   *  client the host restarted and forces a full PTY replay. */
  bootId: string;
  model: { [k: string]: Json };
}

export interface DemoSnapshot {
  v: typeof SNAPSHOT_V;
  protocol: number;
  scenario: string;
  /** `meta.stamp` of the scenario this was seeded from; a re-shipped scenario
   *  with the same id but different content must not restore old state. */
  stamp: string;
  /** `clock.now()` when the demo started; the script's `at` counts from it. */
  startedAt: number;
  /** How many script events have fired. */
  scriptPos: number;
  state: DemoState;
  /** The ack ledger: ackId → the receipt sent. Never evicted — evicting a
   *  verdict is what lets a late replay run twice, and a demo is short. */
  acks: { [ackId: string]: HostMessage };
  faults: DemoFaultRule[];
  /** Per rule index: how many times it matched (drives `from` / `times`). */
  faultHits: number[];
}

/** `raw` as a snapshot of THIS scenario at THIS protocol, or null. */
export function readSnapshot(raw: unknown, expect: { scenario: string; stamp: string; protocol: number }): DemoSnapshot | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as Partial<DemoSnapshot>;
  if (s.v !== SNAPSHOT_V) return null;
  if (s.protocol !== expect.protocol || s.scenario !== expect.scenario || s.stamp !== expect.stamp) return null;
  if (typeof s.startedAt !== "number" || typeof s.scriptPos !== "number") return null;
  if (!s.state || typeof s.state.bootId !== "string" || !s.state.model || typeof s.state.model !== "object") return null;
  if (!s.acks || typeof s.acks !== "object" || !Array.isArray(s.faults) || !Array.isArray(s.faultHits)) return null;
  return s as DemoSnapshot;
}
