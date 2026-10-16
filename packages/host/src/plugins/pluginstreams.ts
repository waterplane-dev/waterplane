/**
 * Plugin streams, the host half (`api.stream`, plugin API 1.4; the contract is
 * `@waterplane/shared`'s `stream.ts`, the reasoning docs/notes/plugins.md, "Streams").
 *
 * Two maps and a state machine:
 * - per plugin, `name → handlers` (what `api.stream` registered while the plugin runs);
 * - per socket, `streamId → sub` (what that socket opened; ids minted per socket, u16, non-zero);
 * - per sub, the backpressure state: `needsKey` after any skipped frame, `keyAsked` so the
 *   producer is asked for a keyframe once per drain, not once per skipped frame.
 *
 * Nothing here is durable. A stream is never queued, never in the ack ledger, never retried:
 * a dead socket ends its subs (`socketGone`), and the phone reopens on reconnect. Binary frames
 * go only to the socket that opened the stream, so a socket that never sent `stream.open` (an
 * old APK bundle) never receives one.
 *
 * PTY first. One TCP connection carries the terminal and the video, so a frame of video never
 * stands between a PTY frame and the phone:
 * - while the socket's PTY is held back (`ptyHeld`: its buffer is past `WS_PTY_BACKLOG_BYTES`,
 *   or a terminal on it is torn and waiting for its replay while bytes are still queued), EVERY
 *   stream frame is skipped, a keyframe too. A skipped keyframe is "deferred" the simplest way:
 *   the sub needs a key, and the producer is asked again for one once the PTY is no longer held
 *   (on the next frame it offers, or the next `stream.ack`, whichever comes first). No timer, no
 *   frame held in memory, nothing that can be sent late.
 * - otherwise a `droppable` frame is skipped while the socket's buffer is past the sub's backlog
 *   limit (`streamBacklogLimit` of the params' `bitrateKbps`, else the default), and a non-key
 *   frame is skipped while the sub needs a key.
 * - a key that ENDS an episode (the sub needs one) waits for the buffer to be back under the line,
 *   and so does the ASK for it: the producer is asked only once the backlog has drained (on the
 *   next frame it offers, or the next `stream.ack`). Before, a skip asked at once and the key went
 *   out past the line regardless, so on a link slower than the bitrate every other frame was an
 *   IDR into a socket already over its line — the buffer climbed to `WS_PTY_BACKLOG_BYTES`, and
 *   the PTY was held: late, then torn. Now a recovery key costs one drain, and the buffer stays
 *   near the line (the line, plus a frame).
 * - a key in a healthy run (no episode: the producer's own GOP, a re-aim) may go out past the
 *   line, but not once the buffer is past `STREAM_KEY_OVERSHOOT` × the line: that far behind it
 *   is skipped, which starts an episode like any skip.
 * - a frame marked BOTH key and droppable (a still the next still replaces) is droppable first: it
 *   is skipped like any droppable frame, and when sent it clears the need for a key.
 */
import {
  encodeStreamFrame, jsonBytes, logTag, streamBacklogLimit,
  STREAM_FLAG_DROPPABLE, STREAM_FLAG_KEY, STREAM_INPUT_MAX, STREAM_MAX_PER_SOCKET, STREAM_NAME_RE,
  STREAM_PARAMS_MAX, STREAM_PAYLOAD_MAX, STREAM_STATUS_MAX,
} from "@waterplane/shared";
import type { HostMessage, PluginStreamHandlers, PluginStreamSendResult, PluginStreamSub, StreamEndCause } from "@waterplane/shared";

/** The part of a `ws` socket the stream core touches. A test hands a fake. */
export interface StreamSocket {
  readonly bufferedAmount: number;
  readonly readyState: number;
  send(data: Uint8Array, opts: { binary: boolean; compress: boolean }): void;
}
const WS_OPEN = 1;

/** How the stream core reaches the sockets. Read at CALL time; absent ⇒ every open is refused. */
export interface StreamSink {
  /** The core's own JSON send (`clients.ts`'s `send`). */
  sendJson(ws: StreamSocket, msg: HostMessage): void;
  /** True while the socket's PTY is held back (`server/sessionEvents.ts`'s `ptyHeld`). */
  ptyHeld(ws: StreamSocket): boolean;
}

export interface StreamDeps {
  /** A plugin by id: its display name and why it cannot serve right now (null when it can).
   *  Null for no such plugin. */
  plugin(id: string): { name: string; refusal: string | null } | null;
  /** A handler threw: the plugin's status line, never the daemon's problem. */
  failed(pluginId: string, what: string, err: unknown): void;
  sink(): StreamSink | null;
  log?(line: string): void;
  now?(): number;
  /** How long `handlers.open` may take before the open is refused. */
  openMs?: number;
}

/** How far past the backlog line (a factor of it) a key that starts no episode may still go out. */
export const STREAM_KEY_OVERSHOOT = 2;

/** What one frame does, given the sub's and the socket's state. Pure; see the header. */
export function streamFrameAction(f: {
  key: boolean; droppable: boolean; needsKey: boolean; ptyHeld: boolean; buffered: number; limit: number;
}): "send" | "skip" {
  if (f.ptyHeld) return "skip";
  if (f.needsKey && !f.key) return "skip";
  if (f.buffered > f.limit) {
    if (f.droppable) return "skip";
    // A recovery key waits for the drain; a mid-run key may overshoot the line, but not far.
    if (f.key && (f.needsKey || f.buffered > f.limit * STREAM_KEY_OVERSHOOT)) return "skip";
  }
  return "send";
}

/** Whether the producer may be asked for a key now: the PTY is not held and the socket's buffer is
 *  back under the line. Asking past the line is what made every other frame an IDR. Pure. */
export function streamMayAskKey(f: { ptyHeld: boolean; buffered: number; limit: number }): boolean {
  return !f.ptyHeld && f.buffered <= f.limit;
}

/** The backlog line for a sub's params: `bitrateKbps` when it is a positive number, else the default. */
export function backlogLimitFor(params: unknown): number {
  const kbps = params && typeof params === "object" && !Array.isArray(params) ? (params as { bitrateKbps?: unknown }).bitrateKbps : undefined;
  return streamBacklogLimit(typeof kbps === "number" && kbps > 0 ? kbps * 1000 : undefined);
}

interface Served { pluginId: string; pluginName: string; name: string; handlers: PluginStreamHandlers }

interface SubState {
  readonly id: number;
  readonly key: string;
  readonly ws: StreamSocket;
  readonly served: Served;
  params: unknown;
  seq: number;
  sentBytes: number;
  lastAck: { seq: number; rxBytes: number; at: number } | null;
  /** `handlers.open` has not settled yet: nothing is sent, the phone does not know the id. */
  opening: boolean;
  /** `handlers.open` accepted: `close` is owed when it ends. */
  accepted: boolean;
  ended: boolean;
  /** Why it ended, kept for an `open` that settles after the end. */
  endCause?: StreamEndCause;
  needsKey: boolean;
  keyAsked: boolean;
  facade: PluginStreamSub;
}

interface SocketState { nextId: number; subs: Map<number, SubState> }

const msgOf = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 300);
const bytes = (n: number): string => `${n} bytes`;

export class PluginStreams {
  private readonly served = new Map<string, Served>();
  private readonly sockets = new Map<StreamSocket, SocketState>();
  private serial = 0;

  constructor(private readonly deps: StreamDeps) {}

  private log(line: string): void { (this.deps.log ?? ((l: string) => console.log(l)))(`${logTag} stream ${line}`); }
  private now(): number { return (this.deps.now ?? Date.now)(); }
  private held(ws: StreamSocket): boolean {
    try { return !!this.deps.sink()?.ptyHeld(ws); } catch { return false; }
  }

  // ── the plugin side ────────────────────────────────────────────────────────

  /** `api.stream(name, handlers)`. THROWS a sentence on a bad name or one already served. */
  serve(pluginId: string, pluginName: string, name: string, handlers: PluginStreamHandlers): () => void {
    if (typeof name !== "string" || !STREAM_NAME_RE.test(name)) {
      throw new Error(`${pluginName}: ${JSON.stringify(name ?? null)} is not a stream name (lower-case letters, digits and dashes, starting with a letter, at most 32)`);
    }
    if (!handlers || typeof handlers.open !== "function") throw new Error(`${pluginName}: api.stream("${name}") needs an open handler`);
    const k = `${pluginId}\0${name}`;
    if (this.served.has(k)) throw new Error(`${pluginName} already serves a stream named "${name}"`);
    const rec: Served = { pluginId, pluginName, name, handlers };
    this.served.set(k, rec);
    return () => {
      if (this.served.get(k) !== rec) return;
      this.served.delete(k);
      this.endWhere((s) => s.served === rec, "plugin", `${pluginName} stopped serving "${name}"`, true);
    };
  }

  /** The plugin was switched off, failed, or unloaded: every name it served goes, and every sub with it. */
  dropPlugin(pluginId: string, reason: string): void {
    for (const [k, s] of this.served) if (s.pluginId === pluginId) this.served.delete(k);
    this.endWhere((s) => s.served.pluginId === pluginId, "plugin", reason, true);
  }

  /** The names a plugin serves right now (tests, diagnostics). */
  names(pluginId: string): string[] {
    return [...this.served.values()].filter((s) => s.pluginId === pluginId).map((s) => s.name);
  }

  // ── the socket side ────────────────────────────────────────────────────────

  /** `stream.open`. Answers `stream.opened` or `stream.refused`; never throws. */
  async open(ws: StreamSocket, msg: { reqId?: unknown; plugin?: unknown; name?: unknown; params?: unknown }): Promise<void> {
    const sink = this.deps.sink();
    if (typeof msg.reqId !== "string" || !msg.reqId || msg.reqId.length > 128) return; // nothing to address an answer to
    const reqId = msg.reqId;
    const plugin = String(msg.plugin ?? ""), name = String(msg.name ?? "");
    const refuse = (reason: string): void => {
      this.log(`refused plugin=${plugin} name=${name}: ${reason}`);
      sink?.sendJson(ws, { t: "stream.refused", reqId, reason });
    };
    if (!sink) return refuse("this host cannot send streams");
    if (ws.readyState !== WS_OPEN) return;
    const p = this.deps.plugin(plugin);
    if (!p) return refuse(`no plugin "${plugin}" is installed`);
    if (p.refusal) return refuse(p.refusal);
    const served = STREAM_NAME_RE.test(name) ? this.served.get(`${plugin}\0${name}`) : undefined;
    if (!served) return refuse(`${p.name} serves no stream "${name}"`);
    const params = msg.params ?? null;
    const n = jsonBytes(params);
    if (n < 0) return refuse("the stream's settings are not JSON");
    if (n > STREAM_PARAMS_MAX) return refuse(`the stream's settings are ${bytes(n)}, over the ${bytes(STREAM_PARAMS_MAX)} they may carry`);
    const sock = this.socket(ws);
    if (sock.subs.size >= STREAM_MAX_PER_SOCKET) return refuse(`this connection already has ${STREAM_MAX_PER_SOCKET} streams open; close one first`);
    const id = this.mint(sock);
    const sub = this.makeSub(ws, served, id, params);
    sock.subs.set(id, sub); // reserved now, so two opens in flight count against the cap

    let refusal: string | null = null;
    let timer: NodeJS.Timeout | undefined;
    const openMs = this.deps.openMs ?? 10_000;
    const late = Symbol("late");
    const run = Promise.resolve().then(() => served.handlers.open(sub.facade, params));
    try {
      const r = await Promise.race([run, new Promise<typeof late>((res) => { timer = setTimeout(() => res(late), openMs); })]);
      if (r === late) {
        refusal = `${p.name} did not open "${name}" within ${Math.max(1, Math.round(openMs / 1000))} s`;
        // A late yes still holds whatever the plugin started for it: close it the moment it lands.
        run.then((v) => { if (typeof v !== "string" || !v.trim()) this.callClose(sub, "error"); }, () => {});
      } else if (typeof r === "string" && r.trim()) refusal = r.trim().slice(0, 300);
    } catch (err) {
      refusal = msgOf(err) || `${p.name} refused "${name}"`;
    } finally {
      clearTimeout(timer);
    }
    sub.opening = false;
    if (refusal !== null) {
      this.forget(sub);
      sub.ended = true;
      if (sub.ws.readyState === WS_OPEN) refuse(refusal);
      return;
    }
    sub.accepted = true;
    if (sub.ended) { this.callClose(sub, sub.endCause ?? "socket"); return; } // ended while opening: the socket died or the plugin stopped
    this.log(`open plugin=${plugin} name=${name} id=${id}`);
    sink.sendJson(ws, { t: "stream.opened", reqId, streamId: id, plugin, name });
    this.maybeAskKey(sub);
  }

  /** `stream.params`: replaces the params, then tells the plugin. Unknown id ⇒ ignored. */
  params(ws: StreamSocket, streamId: unknown, params: unknown): void {
    const sub = this.live(ws, streamId);
    if (!sub) return;
    const n = jsonBytes(params ?? null);
    if (n < 0 || n > STREAM_PARAMS_MAX) { this.log(`params dropped plugin=${sub.served.pluginId} name=${sub.served.name} id=${sub.id}: ${n < 0 ? "not JSON" : bytes(n)}`); return; }
    sub.params = params ?? null;
    this.call(sub, "params", () => sub.served.handlers.params?.(sub.facade, sub.params));
  }

  /** `stream.input`: one upstream event, at most once (never retried, so never twice). */
  input(ws: StreamSocket, streamId: unknown, ev: unknown): void {
    const sub = this.live(ws, streamId);
    if (!sub) return;
    const n = jsonBytes(ev ?? null);
    if (n < 0 || n > STREAM_INPUT_MAX) { this.log(`input dropped plugin=${sub.served.pluginId} name=${sub.served.name} id=${sub.id}: ${n < 0 ? "not JSON" : `${n} bytes, over ${STREAM_INPUT_MAX}`}`); return; }
    this.call(sub, "input", () => sub.served.handlers.input?.(sub.facade, ev ?? null));
  }

  /** `stream.keyframe`: the phone needs a decodable frame now. */
  keyframe(ws: StreamSocket, streamId: unknown): void {
    const sub = this.live(ws, streamId);
    if (!sub) return;
    this.call(sub, "keyframe", () => sub.served.handlers.keyframe?.(sub.facade));
  }

  /** `stream.ack`: what the phone has received. Also the tick a deferred keyframe ask rides on. */
  ack(ws: StreamSocket, streamId: unknown, seq: unknown, rxBytes: unknown): void {
    const sub = this.live(ws, streamId);
    if (!sub) return;
    if (typeof seq !== "number" || !Number.isFinite(seq) || typeof rxBytes !== "number" || !Number.isFinite(rxBytes) || rxBytes < 0) return;
    sub.lastAck = { seq: seq >>> 0, rxBytes, at: this.now() };
    this.call(sub, "ack", () => sub.served.handlers.ack?.(sub.facade));
    this.maybeAskKey(sub);
  }

  /** `stream.close`: the phone is done with it. Nothing is sent back. */
  close(ws: StreamSocket, streamId: unknown): void {
    const sub = this.live(ws, streamId);
    if (sub) this.end(sub, "closed", "closed by the phone", false);
  }

  /** The socket closed or was terminated: every sub on it ends, nothing is sent. */
  socketGone(ws: StreamSocket): void {
    const sock = this.sockets.get(ws);
    if (!sock) return;
    for (const sub of [...sock.subs.values()]) this.end(sub, "socket", "the connection closed", false);
    this.sockets.delete(ws);
  }

  /** Host shutdown: everything ends, nothing is sent (the sockets are going too). */
  endAll(): void {
    for (const ws of [...this.sockets.keys()]) this.socketGone(ws);
  }

  /** Open subs on a socket (tests, diagnostics). */
  openOn(ws: StreamSocket): number { return this.sockets.get(ws)?.subs.size ?? 0; }

  // ── internals ──────────────────────────────────────────────────────────────

  private socket(ws: StreamSocket): SocketState {
    let s = this.sockets.get(ws);
    if (!s) { s = { nextId: 1, subs: new Map() }; this.sockets.set(ws, s); }
    return s;
  }

  /** A u16, non-zero, not in use on this socket. The cap keeps the search short. */
  private mint(sock: SocketState): number {
    let id = sock.nextId;
    while (sock.subs.has(id)) id = id >= 0xffff ? 1 : id + 1;
    sock.nextId = id >= 0xffff ? 1 : id + 1;
    return id;
  }

  /** An open (accepted, not ended) sub on THIS socket, or null — a stale id after a reconnect is normal. */
  private live(ws: StreamSocket, streamId: unknown): SubState | null {
    if (typeof streamId !== "number") return null;
    const sub = this.sockets.get(ws)?.subs.get(streamId);
    return sub && !sub.ended && !sub.opening ? sub : null;
  }

  private forget(sub: SubState): void {
    const sock = this.sockets.get(sub.ws);
    if (sock?.subs.get(sub.id) === sub) sock.subs.delete(sub.id);
  }

  private endWhere(pred: (s: SubState) => boolean, cause: StreamEndCause, reason: string, tell: boolean): void {
    for (const sock of this.sockets.values()) for (const sub of [...sock.subs.values()]) if (pred(sub)) this.end(sub, cause, reason, tell);
  }

  private end(sub: SubState, cause: StreamEndCause, reason: string, tell: boolean): void {
    if (sub.ended) return;
    sub.ended = true;
    sub.endCause = cause;
    this.forget(sub);
    if (sub.opening) return; // `open` settles it: no `stream.opened`, and `close` only if the plugin said yes
    this.log(`close plugin=${sub.served.pluginId} name=${sub.served.name} id=${sub.id} cause=${cause}`);
    if (tell && sub.ws.readyState === WS_OPEN) this.deps.sink()?.sendJson(sub.ws, { t: "stream.ended", streamId: sub.id, cause, reason: String(reason).slice(0, 300) });
    this.callClose(sub, cause);
  }

  private callClose(sub: SubState, cause: StreamEndCause): void {
    this.call(sub, "close", () => sub.served.handlers.close?.(sub.facade, cause), true);
  }

  /** Run one handler; a throw (or a rejected promise) is the plugin's status line. */
  private call(sub: SubState, what: string, fn: () => unknown, evenEnded = false): void {
    if (sub.ended && !evenEnded) return;
    const label = `stream "${sub.served.name}" ${what}`;
    try {
      const r = fn();
      if (r && typeof (r as Promise<unknown>).then === "function") (r as Promise<unknown>).catch((err) => this.deps.failed(sub.served.pluginId, label, err));
    } catch (err) {
      this.deps.failed(sub.served.pluginId, label, err);
    }
  }

  /** Ask the producer for a keyframe, once per drain: never while the PTY is held, and never while
   *  the socket is past the sub's line (the key would be skipped, or pile onto a full pipe). The
   *  next offered frame and the next `stream.ack` both come back here, so the ask follows the drain. */
  private maybeAskKey(sub: SubState): void {
    if (sub.ended || sub.opening || !sub.needsKey || sub.keyAsked) return;
    if (!streamMayAskKey({ ptyHeld: this.held(sub.ws), buffered: sub.ws.bufferedAmount, limit: backlogLimitFor(sub.params) })) return;
    sub.keyAsked = true;
    this.call(sub, "keyframe", () => sub.served.handlers.keyframe?.(sub.facade));
  }

  private send(sub: SubState, payload: Uint8Array, o: { kind: number; key?: boolean; droppable?: boolean }): PluginStreamSendResult {
    if (!(payload instanceof Uint8Array)) throw new Error(`${sub.served.pluginName}: sub.send needs a Uint8Array payload`);
    if (payload.byteLength > STREAM_PAYLOAD_MAX) {
      throw new Error(`${sub.served.pluginName}: a frame of ${bytes(payload.byteLength)} is over the ${bytes(STREAM_PAYLOAD_MAX)} one frame may carry`);
    }
    if (sub.ended) return "ended";
    const key = !!o?.key, droppable = !!o?.droppable;
    const flags = (key ? STREAM_FLAG_KEY : 0) | (droppable ? STREAM_FLAG_DROPPABLE : 0);
    // Before `stream.opened` the phone cannot place a frame: skipped, and a key is asked for once it is open.
    if (sub.opening) { sub.needsKey = true; sub.keyAsked = false; return "skipped"; }
    if (sub.ws.readyState !== WS_OPEN) return "skipped"; // closing: `socketGone` ends it
    const ptyHeld = this.held(sub.ws);
    const action = streamFrameAction({ key, droppable, needsKey: sub.needsKey, ptyHeld, buffered: sub.ws.bufferedAmount, limit: backlogLimitFor(sub.params) });
    if (action === "skip") {
      // A key we drop is a key the producer has to send again: the ask is spent, re-made after the drain.
      if (key || !sub.needsKey) { sub.needsKey = true; sub.keyAsked = false; }
      this.maybeAskKey(sub);
      return "skipped";
    }
    const seq = sub.seq;
    const buf = encodeStreamFrame({ streamId: sub.id, seq, kind: o.kind, flags }, payload); // throws on a bad kind
    try {
      sub.ws.send(buf, { binary: true, compress: false });
    } catch (err) {
      this.end(sub, "error", `the frame could not be sent: ${msgOf(err)}`, false);
      return "ended";
    }
    sub.seq = (seq + 1) >>> 0;
    sub.sentBytes += payload.byteLength;
    if (key) { sub.needsKey = false; sub.keyAsked = false; }
    return "sent";
  }

  private status(sub: SubState, data: unknown): string | null {
    if (sub.ended) return "the stream has ended";
    if (sub.opening) return "the stream is not open yet";
    const n = jsonBytes(data ?? null);
    if (n < 0) return "a stream status must be JSON";
    if (n > STREAM_STATUS_MAX) return `a status of ${bytes(n)} is over the ${bytes(STREAM_STATUS_MAX)} one may carry`;
    if (sub.ws.readyState !== WS_OPEN) return "the connection is closing";
    this.deps.sink()?.sendJson(sub.ws, { t: "stream.status", streamId: sub.id, data: data ?? null });
    return null;
  }

  private makeSub(ws: StreamSocket, served: Served, id: number, params: unknown): SubState {
    const self = this;
    const sub = {
      id, key: `${served.pluginId}:${++this.serial}`, ws, served, params, seq: 1, sentBytes: 0, lastAck: null,
      opening: true, accepted: false, ended: false, needsKey: false, keyAsked: false,
    } as SubState;
    // The plugin's view: read-only getters over the state, so nothing a plugin writes moves the machine.
    sub.facade = Object.freeze({
      get id() { return sub.id; },
      get key() { return sub.key; },
      get params() { return sub.params; },
      get backlogBytes() { return sub.ws.bufferedAmount; },
      get sentBytes() { return sub.sentBytes; },
      get lastAck() { return sub.lastAck ? { ...sub.lastAck } : null; },
      send: (payload: Uint8Array, o: { kind: number; key?: boolean; droppable?: boolean }) => self.send(sub, payload, o),
      status: (data: unknown) => self.status(sub, data),
      end: (reason: string, cause?: "plugin" | "replaced") => self.end(sub, cause === "replaced" ? "replaced" : "plugin",
        typeof reason === "string" && reason.trim() ? reason : `${served.pluginName} ended the stream`, true),
    });
    return sub;
  }
}
