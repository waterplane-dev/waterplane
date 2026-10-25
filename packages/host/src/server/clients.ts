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
  type NotifyOpen,
  type PeerKind,
  type ClientRole,
  roleAllows,
} from "@waterplane/shared";
import type { ServerCtx } from "./ctx.js";
import { WIRE, recordWireFrame } from "../wirerecord.js";

/** What `createClients` needs — the managers constructed ahead of it in main. */
export type ClientsDeps = Pick<ServerCtx, "auth" | "notifyPrefs" | "push" | "sessions"> & {
  /** How long a distrusted socket may answer the close frame before `terminate()` (default 1 s; a test seam). */
  closeGraceMs?: number;
};

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
  /** A socket's declared role (`shared/wire/notifylink.ts`): set at the upgrade
   *  off the User-Agent, overridden by `hello.role`. Absent ⇒ a full client. */
  const wsRole = new WeakMap<WebSocket, ClientRole>();

  function authStateFor(kind: PeerKind): AuthState {
    return { enabled: auth.isEnabled(), gateTailscale: auth.gateTailscale(), canManage: auth.canManage(kind) };
  }

  /** How long a socket the host no longer trusts gets to answer the close frame
   *  before it is torn down. `ws.close()` alone keeps parsing and dispatching
   *  the peer's frames until the handshake completes — or for 30 s if the peer
   *  never answers it. */
  const CLOSE_GRACE_MS = deps.closeGraceMs ?? 1000;

  /** Close a socket the host no longer trusts: the close frame first (the phone
   *  reads its reason), then `terminate()` whatever the peer did with it. */
  function drop(ws: WebSocket): void {
    try { ws.close(); } catch { /* already closing */ }
    const t = setTimeout(() => { try { ws.terminate(); } catch { /* already gone */ } }, CLOSE_GRACE_MS);
    t.unref?.();
  }

  /**
   * Is this socket still one the host would accept a frame from? Decided at the
   * upgrade once; asked again for every frame (`server/wsops.ts`), because a
   * revoke, a relock or a password change happens while the socket is open and
   * its close is asynchronous. The same two questions `enforceAuth` asks, so
   * the two never disagree: the token it presented must still be valid WHERE
   * ONE IS NEEDED (on a trusted kind a vanished row changes nothing — the same
   * phone could reconnect tokenless and be accepted, so refusing its frames
   * would only freeze the owner's phone after a password change), and the
   * device it is must not be a locked passive row.
   */
  function socketAuthorized(ws: WebSocket): boolean {
    const kind = wsKind.get(ws);
    if (kind && auth.needsToken(kind) && !auth.checkToken(wsToken.get(ws) ?? null)) return false;
    const id = wsDevice.get(ws);
    const row = id ? auth.devices.get(id) : null;
    return !(row && auth.passive.restricted(row));
  }

  /** Kick any currently-open socket that is no longer authorized (e.g. the password
   *  was just set/changed, invalidating its token). Sent authRequired, then closed. */
  function enforceAuth(): void {
    for (const ws of [...clients]) {
      const kind = wsKind.get(ws);
      if (kind && auth.needsToken(kind) && !auth.checkToken(wsToken.get(ws) ?? null)) {
        send(ws, { t: "authRequired", enabled: auth.isEnabled(), kind });
        drop(ws);
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
      drop(ws);
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
   * The exemption that matters for the automatic close (`lingerSweep`): a session with a socket on it is a session somebody has on
   * screen, and nothing this host does on its own initiative may close one. Asked
   * fresh each time rather than cached — attachments change with every tap.
   */
  function isAttachedToSomeone(id: string): boolean {
    return attachedIds().has(id);
  }

  /** THE filter for a notify link: every frame to every socket passes here, so
   *  the background link is sent its allow-list and nothing else — no call site
   *  has to remember it. Each frame dropped is a radio wakeup the phone keeps. */
  function send(ws: WebSocket, msg: HostMessage): void {
    if (!roleAllows(wsRole.get(ws), msg.t)) return;
    if (ws.readyState === ws.OPEN) { if (WIRE) recordWireFrame("out", msg); ws.send(encode(msg)); }
  }

  function broadcast(msg: HostMessage): void {
    for (const ws of clients) send(ws, msg);
  }

  /** In-app notification feed (newest first), so alerts work without OS push. */
  const notifications: NotificationItem[] = [];
  /** Fire a notification: record it in-app, broadcast it, AND send an OS push.
   *  The in-app feed is the source of truth; OS push is best-effort on top. */
  function notify(kind: NotificationKind, p: { title: string; body: string; sessionId?: string; tag?: string; image?: { repoId: string; relPath: string }; file?: { repoId: string; relPath: string; name: string; size: number; mtime?: number }; pull?: string; backlog?: { cwd: string; ids: string[] }; plugin?: string; open?: NotifyOpen }): void {
    // A muted kind is dropped WHOLE: no feed row, no broadcast, no push. Recording
    // it and hiding it client-side would still buzz the phone, and would still
    // bury the two kinds a person actually has to answer.
    //
    // One exception, and it is not an alert at all: a payload carrying `pull` is
    // the TRANSPORT for auto-download — the service worker starts a Background
    // Fetch from the push handler with the app closed, so dropping it would
    // silently turn auto-pull off for anyone who muted "artifact".
    if (!p.pull && !notifyPrefs.enabled(kind)) return;
    const item: NotificationItem = { id: randomUUID().slice(0, 8), ts: Date.now(), kind, title: p.title, body: p.body, sessionId: p.sessionId, tag: p.tag, image: p.image, file: p.file, backlog: p.backlog, plugin: p.plugin, open: p.open };
    notifications.unshift(item);
    if (notifications.length > 100) notifications.length = 100;
    broadcast({ t: "notification", item });
    // The push carries the item's identity and targets too, so a tap on the OS
    // notification can land where a tap on the feed row does (`sw.js`).
    void push.notify({ ...p, id: item.id, kind, ts: item.ts });
  }

  // A passive device's PIN unlock ending (expiry, "Lock now") closes its
  // sockets, so an open WebSocket never outlives the unlock (`passive.ts`).
  auth.passive.onRelock = (id) => { closeDevice(id); };

  return {
    attached, clients, wsKind, wsToken, wsDevice, wsRole, closeDevice, socketAuthorized,
    authStateFor, enforceAuth, broadcastAuthState, recomputeWatched,
    attachedIds, isAttachedToSomeone,
    send, broadcast,
    notifications, notify,
  };
}
