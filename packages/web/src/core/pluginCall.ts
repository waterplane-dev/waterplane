/**
 * `plugin.call` from the phone: a LIVE question over the one socket, never a queue entry.
 *
 * The retry rule (docs/notes/plugins.md): a call is answered now or not at all. The host's ledger
 * (`host/plugins/pluginrpc.ts`) de-duplicates a repeated ackId, so this module may re-send ONE kind of
 * call after a reconnect — a `read`, with the IDENTICAL frame (same ackId). A write is never re-sent:
 * if the link drops while one is pending it resolves "it may have run", and the caller looks before
 * trying again. A read is re-asked only of the host that was asked (the welcome's `hostId`).
 * Frames go out by `trySend` — never the socket's RAM queue, which would replay a write on the next open.
 * A write that must be at-most-once across a host restart uses `handToAgent`'s `key`.
 *
 * Resolves, never rejects. Pure over its deps so `pluginCall.test.mjs` drives it with fakes; the lazy
 * singleton is `pluginCalls.ts` (the real socket, `newAckId`, `setTimeout`).
 */
import type { ClientMessage, HostMessage, PluginCallResult } from "@waterplane/shared";

export const PLUGIN_CALL_TIMEOUT_MS = 100_000;

export interface PluginCallDeps {
  status(): string;
  /** Write now or not at all (`HostConnection.trySend`): false = nothing went out, nothing is queued. */
  trySend(frame: ClientMessage): boolean;
  mintId(): string;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(t: unknown): void;
}

interface Pending {
  plugin: string;
  method: string;
  read: boolean;
  /** The host that answered the last welcome when this went out (null: none seen / an old host). */
  hostId: string | null;
  /** Reads only: re-sent on reconnect. A write's frame (its args may be a secret) is dropped once sent. */
  frame: ClientMessage | null;
  timer: unknown;
  resolve(r: PluginCallResult): void;
}

export function createPluginCalls(d: PluginCallDeps, timeoutMs = PLUGIN_CALL_TIMEOUT_MS) {
  let hostId: string | null = null; // the last welcome's host — a read is re-asked of THAT host only
  const pending = new Map<string, Pending>();
  const settle = (ackId: string, r: PluginCallResult) => {
    const p = pending.get(ackId);
    if (!p) return;
    pending.delete(ackId);
    d.clearTimer(p.timer);
    p.resolve(r);
  };
  return {
    call(plugin: string, method: string, args: unknown, read: boolean): Promise<PluginCallResult> {
      const noConn: PluginCallResult = { ok: false, error: "no connection — the desktop can't be asked from here" };
      if (d.status() !== "open") return Promise.resolve(noConn);
      return new Promise((resolve) => {
        const ackId = d.mintId();
        const frame: ClientMessage = { t: "plugin.call", plugin, method, ...(args === undefined ? {} : { args }), ackId };
        const timer = d.setTimer(() => settle(ackId, { ok: false, error: `${plugin} did not answer within ${Math.round(timeoutMs / 1000)} s` }), timeoutMs);
        pending.set(ackId, { plugin, method, read, hostId, frame, timer, resolve });
        // trySend, never send(): the socket's own queue would replay a frame written while it was
        // closing on the NEXT open — a write re-run after the caller was told "it may have run".
        let sent = false;
        try { sent = d.trySend(frame); } catch (e) {
          settle(ackId, { ok: false, error: `could not reach the desktop: ${e instanceof Error ? e.message : String(e)}` });
          return;
        }
        if (!sent) { settle(ackId, noConn); return; }
        // A write is never re-sent, so nothing needs its args any more: don't keep them in memory.
        if (!read) { const p = pending.get(ackId); if (p) p.frame = null; }
      });
    },
    onFrame(msg: HostMessage): void {
      if (msg.t === "plugin.reply") {
        const p = pending.get(msg.ackId);
        if (!p || p.plugin !== msg.plugin || p.method !== msg.method) return;
        settle(msg.ackId, msg.ok ? { ok: true, result: msg.result } : { ok: false, error: msg.error ?? `${msg.plugin} failed` });
      } else if (msg.t === "welcome") {
        // A new connection: a read is re-asked with the SAME frame of the SAME host (the ledger makes a repeat
        // harmless; another host is a different question);  a write is not re-sent — it may have run, and only the caller can look.
        hostId = msg.hostId ?? null;
        for (const [ackId, p] of [...pending]) {
          if (p.read && p.hostId !== hostId) settle(ackId, { ok: false, error: "the desktop changed before it answered — ask again" });
          else if (p.read && p.frame) { try { d.trySend(p.frame); } catch { /* the timeout still answers it */ } }
          else settle(ackId, { ok: false, error: `the link dropped before ${p.plugin} answered — it may have run; look before trying again` });
        }
      }
    },
    pending: () => pending.size,
    /** How many pending calls still hold their frame (reads only; a sent write holds none). */
    framesHeld: () => [...pending.values()].filter((p) => p.frame !== null).length,
  };
}

export type PluginCalls = ReturnType<typeof createPluginCalls>;
