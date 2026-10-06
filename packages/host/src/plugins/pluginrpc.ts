/**
 * The ledger behind `plugin.call` (docs/notes/plugins.md, "plugin.call is a live question").
 *
 * `plugin.call` is NOT durable and not in the ack ledger: a call is answered now or not at all.
 * What this covers is narrower — a DOUBLED frame, and a read the phone re-sent after a reconnect
 * with the SAME ackId. It keeps the PROMISE, so a repeat arriving mid-flight joins the run in
 * progress and a repeat after it finished gets the stored answer; the handler runs once either way.
 * In memory only, per boot: a write that must be at-most-once across a restart uses
 * `handToAgent`'s `key`, never a retried call.
 */
import type { PluginCallResult } from "@waterplane/shared";

export interface CallLedgerOpts { ttlMs?: number; max?: number; now?: () => number }

export function createCallLedger(opts: CallLedgerOpts = {}): {
  run(ackId: string, key: string, fn: () => Promise<PluginCallResult>): Promise<PluginCallResult>;
} {
  const ttl = opts.ttlMs ?? 10 * 60_000;
  const max = opts.max ?? 500;
  const now = opts.now ?? Date.now;
  // Keyed by ackId ALONE (not device + ackId): a client mints a 64-bit random id per call, so two
  // phones never collide in practice, and a repeat with a different `key` is refused by name below.
  const rows = new Map<string, { key: string; at: number; p: Promise<PluginCallResult> }>();
  return {
    run(ackId, key, fn) {
      const t = now();
      for (const [k, r] of rows) if (t - r.at > ttl) rows.delete(k);
      const hit = rows.get(ackId);
      if (hit) {
        if (hit.key !== key) return Promise.resolve({ ok: false, error: "that ackId already named a different call" });
        return hit.p;
      }
      const p = fn();
      rows.set(ackId, { key, at: t, p });
      while (rows.size > max) rows.delete(rows.keys().next().value as string);
      return p;
    },
  };
}
