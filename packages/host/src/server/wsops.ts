/**
 * The socket's side of at-most-once: the in-flight maps, `durableOp` and its
 * `op.ack`, the ONE gate on a directory a client named (`containRepoDir`), and
 * each `/ws` server's connection handler.
 *
 * Moved verbatim out of `main.ts` (M2 of the host split, see
 * docs/notes/host-architecture.md). Every main-scope name is read as
 * `ctx.<name>` at CALL time. `new AckLedger`/`new NetStats` and the
 * `new WebSocketServer(…)` stay in `main.ts`; the two in-flight maps are this
 * factory's closure state (memory only, on purpose — see each).
 *
 * `durableOp`: thrown ⇒ NOT remembered (a host fault gets a real second
 * attempt), `ok: false` ⇒ remembered. `containRepoDir`: never loosen it.
 */
import type { IncomingMessage } from "node:http";
import { existsSync } from "node:fs";
import type { WebSocket, WebSocketServer } from "ws";
import { PROTOCOL_VERSION, decode, type ClientMessage, type SendStamp, logTag, envName } from "@waterplane/shared";
import { WIRE, recordWireFrame } from "../wirerecord.js";
import { peerKind } from "../net.js";
import { checkRequestOrigin } from "../origin.js";
import { tokenFromRequest } from "../auth.js";
import { lanIdentity } from "../lanid.js";
import { hostName } from "../net.js";
import { discoverTargets } from "../repos.js";
import { inRoot, realResolve } from "../scaffold.js";
import { backendInfos, recheckUnavailableBackends } from "../backends/index.js";
import type { InputVerdict, OpVerdict } from "../routes/types.js";
import type { ServerCtx } from "./ctx.js";

/** What `main()` learned about this machine's addresses before binding, and
 *  hands every socket in `welcome`. */
export interface WelcomeNet {
  ip: string | null;
  tsBin: string | null;
  tsDns: string | null;
  httpsUrl: string | null;
  boundLan: string[];
}

export function createWsOps(ctx: ServerCtx) {
  /** In-flight durable ops, keyed by ackId. The ledger only learns the verdict
   *  once the op settles, so without this a retry arriving DURING an async op
   *  (a fan-out spends a while validating dirs and spawning) would find nothing
   *  remembered and start the whole thing a second time. Memory only — a crash
   *  mid-op must not leave a persisted "already did it" for work that never ran. */
  const opsInFlight = new Map<string, Promise<OpVerdict>>();

  /**
   * Verified compose deliveries in flight, keyed by ackId — the `session.input`
   * twin of `opsInFlight`, and load-bearing for exactly the same reason.
   *
   * A raw input write is synchronous, so a duplicate ackId could never race it. A
   * `submit` delivery takes SECONDS (boot wait, echo check, Return proof), which
   * opens a window the phone's retry lands in constantly: the client's receipt
   * deadline can expire while the host is still typing. Without this a retry would
   * find nothing remembered (the ledger only learns the verdict once delivery
   * settles) and start a SECOND deliverPrompt — two copies of the same prompt, the
   * one outcome the whole ack scheme exists to prevent. A repeat joins the
   * delivery already running and gets its verdict.
   *
   * Memory only, like `opsInFlight`: a crash mid-delivery must not leave a
   * persisted "already did it" for a prompt that never ran.
   */
  const inputsInFlight = new Map<string, Promise<InputVerdict>>();

  function sendOpAck(ws: WebSocket, ackId: string, v: OpVerdict): void {
    ctx.send(ws, { t: "op.ack", ackId, ok: v.ok, reason: v.reason, sessionId: v.sessionId, runId: v.runId, launchId: v.launchId, intentId: v.intentId, filed: v.filed });
  }

  /**
   * Run a durable action AT MOST ONCE per ackId, and always answer the caller.
   *
   * The phone queues these the same way it queues text (web/outbox.ts) and
   * re-sends the SAME ackId when it never saw the receipt — so "start a session
   * here", "fan out to these 12 repos" and "run this build" need exactly the
   * guarantee session.input already had. A repeat of a known ackId is re-ACKed
   * with the STORED verdict and `exec` is not run again.
   *
   * Without an ackId nothing changes: `exec` runs, no receipt goes out, and a
   * synchronous throw still surfaces as { t: "error" } via the socket's handler.
   *
   * A THROWN op is deliberately not remembered — that's a host fault, not a
   * completed action, and a client retry should get a real second attempt rather
   * than a permanent "no".
   */
  function durableOp(ws: WebSocket, ackId: string | undefined, exec: () => OpVerdict | Promise<OpVerdict>, stamp?: SendStamp): void {
    if (!ackId) { void Promise.resolve(exec()); return; }
    const seen = ctx.acks.get(ackId);
    if (seen) { ctx.netstats.noteAckReplay(); sendOpAck(ws, ackId, { ok: seen.ok, reason: seen.reason, sessionId: seen.sessionId, runId: seen.runId, launchId: seen.launchId, intentId: seen.intentId, filed: seen.filed }); return; }
    const already = opsInFlight.get(ackId);
    if (already) { ctx.netstats.noteAckReplay(); void already.then((v) => sendOpAck(ws, ackId, v)); return; }
    // The ledger was lost at boot and this unknown ackId says it was first sent
    // BEFORE that: it may already have run, and nothing here can tell. Refused,
    // never run, and remembered so every retry hears the same (acks.ts).
    const lostRefusal = ctx.acks.preLossRefusal(stamp);
    if (lostRefusal) {
      const v: OpVerdict = { ok: false, reason: lostRefusal };
      ctx.acks.remember(ackId, { ...v, op: true });
      sendOpAck(ws, ackId, v);
      return;
    }
    let started: Promise<OpVerdict>;
    try {
      started = Promise.resolve(exec());
    } catch (e) {
      sendOpAck(ws, ackId, { ok: false, reason: String((e as Error)?.message || e) });
      return;
    }
    const settled = started.then(
      // `op: true` marks this as an expensive verdict: acks.ts persists it
      // synchronously (a restart must not land inside a debounce window) and
      // protects it from cap eviction by keystroke-frequency input receipts.
      (v) => { ctx.acks.remember(ackId, { ...v, op: true }); return v; },
      (e) => ({ ok: false, reason: String((e as Error)?.message || e) }) as OpVerdict,
    );
    opsInFlight.set(ackId, settled);
    void settled.then((v) => sendOpAck(ws, ackId, v));
    void settled.finally(() => opsInFlight.delete(ackId));
  }

  /**
   * The one gate on a directory a CLIENT named.
   *
   * `session.create` spawns `claude` in this path and `build.run` executes a
   * shell command in it — both are arbitrary code execution, which is exactly why
   * the Tailscale boundary exists (SECURITY.md). But that boundary is about WHO
   * may talk to the daemon and says nothing about WHERE: past `origin.ts` and
   * `auth.ts` the cwd arrived as an opaque string and went straight to
   * `sessions.create()`, so a LAN peer holding a token — or simply a client bug
   * that sent a stale path — could start an agent in any directory on the
   * machine. Every other path a client names is contained (`files.ts`, `git.ts`,
   * `scaffold.ts`, and `fanout.run`, which validates its dirs against
   * `discoverTargets()`); this was the one asymmetry.
   *
   * Two ways to pass, cheapest first:
   *   • inside `ROOT` — one realpath compare, the ordinary case, costing nothing;
   *   • otherwise a DISCOVERED worktree. `git worktree add /somewhere/else` is
   *     legitimate and the repo listing already offers it, so refusing it outright
   *     would break a path the app itself hands the user. The scan runs only for
   *     the out-of-root minority.
   *
   * Returns the resolved directory, or null. Callers refuse rather than guess:
   * the only safe answer to "I do not know where this is" is to start nothing
   * there.
   */
  async function containRepoDir(dir: unknown): Promise<string | null> {
    if (typeof dir !== "string" || !dir.trim()) return null;
    const within = inRoot(ctx.ROOT, dir);
    if (within && existsSync(within)) return within;
    const resolved = realResolve(dir);
    try {
      const known = await discoverTargets(ctx.ROOT);
      if (known.some((t) => realResolve(t.worktreePath) === resolved)) return resolved;
    } catch { /* no listing ⇒ no exception to the root rule */ }
    return null;
  }

  /** The `connection` handler of each `/ws` server. The `new WebSocketServer(…)`
   *  (and its permessage-deflate options) stays in `main()`'s `attachWs`, which
   *  calls this right after constructing it; `net` is the facts `main()` read
   *  about this machine's addresses before binding, handed out in `welcome`. */
  function wireWsConnections(wss: WebSocketServer, net: WelcomeNet): void {
    const { ip, tsBin, tsDns, httpsUrl, boundLan } = net;
    wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
      // A WebSocket is exempt from the same-origin policy, so without this any
      // web page open in a browser that can reach us could drive the daemon —
      // and the daemon spawns `claude`. Refuse anything not from our own origin.
      const originOk = checkRequestOrigin(req.headers);
      if (!originOk.ok) {
        console.warn(`${logTag} refused ws upgrade: ${originOk.reason}. If this is your own hostname, set ${envName("ALLOWED_HOSTS")}.`);
        try { ws.close(1008, "origin not allowed"); } catch { /* already closing */ }
        return;
      }
      const kind = peerKind(req.socket.remoteAddress);
      // Cookie (browser), else the `waterplane-tok.<tok>` subprotocol (the Android
      // shell, whose cross-site cookie is withheld) — `tokenFromRequest`.
      const tok = tokenFromRequest(req.headers);
      const device = ctx.auth.deviceFor(tok, kind);
      // Gate untrusted (LAN, or Tailscale when that toggle is on) sockets: without
      // a valid token, tell the client it needs the password and drop the socket.
      if (ctx.auth.needsToken(kind) && !device) {
        ctx.send(ws, { t: "authRequired", enabled: ctx.auth.isEnabled(), kind });
        try { ws.close(); } catch { /* already closing */ }
        return;
      }
      ctx.clients.add(ws);
      ctx.netstats.noteSocketOpen(ws, kind);
      ctx.attached.set(ws, new Set());
      ctx.wsKind.set(ws, kind);
      if (tok) ctx.wsToken.set(ws, tok);
      if (device) ctx.wsDevice.set(ws, device.id);
      // `hostId` is the LAN identity's, so a phone can tell which desktop a
      // socket landed on; `deviceId` only when this socket IS a ledger device.
      let hostId: string | undefined;
      try { hostId = lanIdentity(ctx.ROOT).hostId; } catch { /* unwritable root ⇒ absent, never a made-up id */ }
      ctx.send(ws, { t: "welcome", protocol: PROTOCOL_VERSION, bootId: ctx.BOOT_ID, tailscaleIp: ip, tailscaleBin: tsBin, tailscaleDns: tsDns, httpsUrl, lanIps: boundLan, port: ctx.PORT, root: ctx.ROOT, tmux: true, clientKind: kind, auth: ctx.authStateFor(kind), hostId, hostName: hostName(), deviceId: device?.id });
      // Which binaries this host can drive, and what each of them can be ASKED.
      // It rides beside `welcome` rather than in the `hello` arm because it is a
      // fact about the HOST, like every field of that frame — and because the
      // client's backend picker is GATED on this frame having arrived: a phone
      // talking to an older host never receives it and therefore does not draw
      // the picker at all (not greyed — absent). That gate is what stops a new
      // phone asking an old host for a backend it cannot spawn, so the frame
      // must not be conditional on anything the client sends first.
      // Additive: `PROTOCOL_VERSION` did not move for it, and a client that has never heard
      // of `backends` ignores an unknown `t` exactly as the wire requires.
      ctx.send(ws, { t: "backends", list: backendInfos() });
      // A backend that said "unavailable" at boot is asked again when a phone
      // connects (at most every 10 s) and the list re-sent only if it changed.
      void recheckUnavailableBackends(10_000).then((changed) => { if (changed) ctx.broadcast({ t: "backends", list: backendInfos() }); });
      ws.on("message", (raw) => {
        try {
          const msg = decode<ClientMessage>(raw.toString());
          if (WIRE) recordWireFrame("in", msg);
          ctx.handleClientMessage(ws, msg);
        } catch (err) {
          ctx.send(ws, { t: "error", message: String(err), context: "message" });
        }
      });
      // Close code first: 1006 (abnormal, no close frame) is the tunnel dying
      // under the socket, 1001 is the phone backgrounding it. They look the same
      // from the app and mean opposite things about the link.
      ws.on("close", (code: number) => { ctx.netstats.noteSocketClose(ws, code); ctx.clients.delete(ws); ctx.recomputeWatched(); });
      ws.on("error", () => { ctx.clients.delete(ws); ctx.recomputeWatched(); });
    });
  }

  return { opsInFlight, inputsInFlight, sendOpAck, durableOp, containRepoDir, wireWsConnections };
}
