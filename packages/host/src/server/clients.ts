/**
 * Who is connected, and how anything reaches them: the socket bookkeeping,
 * `send`/`broadcast`, the auth re-evaluation of open sockets, the "watched"
 * union, and the notification feed with `notify()`.
 *
 * Moved verbatim out of `main.ts` (M1 of the host split, see
 * docs/notes/host-architecture.md). The bodies close over the four managers
 * below exactly as they closed over main's module-level `const`s. Taking them
 * by value at construction is safe — and is the one exception to `ServerCtx`'s
 * call-time rule — because all four are constructed in `main.ts` BEFORE
 * `createClients` is called, and none is ever reassigned.
 */
import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import {
  encode,
  type AuthState,
  type HostMessage,
  type NotificationItem,
  type NotificationKind,
  type PeerKind,
} from "@waterplane/shared";
import type { ServerCtx } from "./ctx.js";
import { WIRE, recordWireFrame } from "../wirerecord.js";

/** What `createClients` needs — the managers constructed ahead of it in main. */
export type ClientsDeps = Pick<ServerCtx, "auth" | "notifyPrefs" | "push" | "sessions">;

/** Everything `createClients` built; `main.ts` assigns each into `ctx`. */
export type Clients = ReturnType<typeof createClients>;

export function createClients(deps: ClientsDeps) {
  const { auth, notifyPrefs, push, sessions } = deps;

  /** Each socket tracks which sessions it is viewing, so we only stream those. */
  const attached = new WeakMap<WebSocket, Set<string>>();
  const clients = new Set<WebSocket>();
  /** Per-socket trust tier + the token it presented, for auth re-evaluation when
   *  the password changes (the socket is already open by then). */
  const wsKind = new WeakMap<WebSocket, PeerKind>();
  const wsToken = new WeakMap<WebSocket, string>();
  /** The ledger device a socket authenticated as (only when it presented a
   *  valid token), so a revoke can close exactly that device's sockets. */
  const wsDevice = new WeakMap<WebSocket, string>();

  function authStateFor(kind: PeerKind): AuthState {
    return { enabled: auth.isEnabled(), gateTailscale: auth.gateTailscale(), canManage: auth.canManage(kind) };
  }

  /** Kick any currently-open socket that is no longer authorized (e.g. the password
   *  was just set/changed, invalidating its token). Sent authRequired, then closed. */
  function enforceAuth(): void {
    for (const ws of [...clients]) {
      const kind = wsKind.get(ws);
      if (kind && auth.needsToken(kind) && !auth.checkToken(wsToken.get(ws) ?? null)) {
        send(ws, { t: "authRequired", enabled: auth.isEnabled(), kind });
        try { ws.close(); } catch { /* already closing */ }
      }
    }
  }

  /** A device was revoked: tell each of its sockets and close it, whatever route
   *  it came in on (a Tailscale socket that presented the token is that device
   *  too). Returns how many were closed. */
  function closeDevice(id: string): number {
    let n = 0;
    for (const ws of [...clients]) {
      if (wsDevice.get(ws) !== id) continue;
      const kind = wsKind.get(ws) ?? "unknown";
      send(ws, { t: "authRequired", enabled: auth.isEnabled(), kind });
      try { ws.close(); } catch { /* already closing */ }
      n++;
    }
    return n;
  }

  /** Push fresh auth state to every still-connected socket (their Settings UI). */
  function broadcastAuthState(): void {
    for (const ws of clients) {
      const kind = wsKind.get(ws);
      if (kind) send(ws, { t: "auth.state", auth: authStateFor(kind) });
    }
  }

  /** Recompute the union of all clients' attachments and tell the SessionManager
   *  which sessions are "watched" (a plugin reads it as `PluginSession.watched`). Call after
   *  any attach/detach/create/disconnect. */
  function recomputeWatched(): void {
    sessions.setWatched(attachedIds());
  }

  /** Every session some client currently has open. */
  function attachedIds(): Set<string> {
    const union = new Set<string>();
    for (const ws of clients) for (const id of attached.get(ws) ?? []) union.add(id);
    return union;
  }

  /**
   * Is anybody looking at this session right now?
   *
   * The exemption that matters for both automatic closes (`reapAutoSession`,
   * `lingerSweep`): a session with a socket on it is a session somebody has on
   * screen, and nothing this host does on its own initiative may close one. Asked
   * fresh each time rather than cached — attachments change with every tap.
   */
  function isAttachedToSomeone(id: string): boolean {
    return attachedIds().has(id);
  }

  function send(ws: WebSocket, msg: HostMessage): void {
    if (ws.readyState === ws.OPEN) { if (WIRE) recordWireFrame("out", msg); ws.send(encode(msg)); }
  }

  function broadcast(msg: HostMessage): void {
    for (const ws of clients) send(ws, msg);
  }

  /** In-app notification feed (newest first), so alerts work without OS push. */
  const notifications: NotificationItem[] = [];
  /** Fire a notification: record it in-app, broadcast it, AND send an OS push.
   *  The in-app feed is the source of truth; OS push is best-effort on top. */
  function notify(kind: NotificationKind, p: { title: string; body: string; sessionId?: string; tag?: string; image?: { repoId: string; relPath: string }; file?: { repoId: string; relPath: string; name: string; size: number; mtime?: number }; pull?: string; backlog?: { cwd: string; ids: string[] } }): void {
    // A muted kind is dropped WHOLE: no feed row, no broadcast, no push. Recording
    // it and hiding it client-side would still buzz the phone, and would still
    // bury the two kinds a person actually has to answer.
    //
    // One exception, and it is not an alert at all: a payload carrying `pull` is
    // the TRANSPORT for auto-download — the service worker starts a Background
    // Fetch from the push handler with the app closed, so dropping it would
    // silently turn auto-pull off for anyone who muted "artifact".
    if (!p.pull && !notifyPrefs.enabled(kind)) return;
    const item: NotificationItem = { id: randomUUID().slice(0, 8), ts: Date.now(), kind, title: p.title, body: p.body, sessionId: p.sessionId, image: p.image, file: p.file, backlog: p.backlog };
    notifications.unshift(item);
    if (notifications.length > 100) notifications.length = 100;
    broadcast({ t: "notification", item });
    void push.notify(p);
  }

  return {
    attached, clients, wsKind, wsToken, wsDevice, closeDevice,
    authStateFor, enforceAuth, broadcastAuthState, recomputeWatched,
    attachedIds, isAttachedToSomeone,
    send, broadcast,
    notifications, notify,
  };
}
