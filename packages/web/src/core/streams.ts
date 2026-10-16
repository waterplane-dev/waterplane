/**
 * The phone's end of plugin streams (`shared/stream.ts`): which open view a binary frame belongs
 * to, the `stream.*` JSON that opens, steers, acks and closes one, and what survives a reconnect.
 *
 * **Never queued, never retried** — the reasoning is the contract's (`shared/stream.ts`): a stream
 * opened an hour late is for a screen nobody watches, and an input event delivered late lands on a
 * different screen. So every write here goes out by `trySend` (now or not at all, never the
 * socket's RAM queue that replays on the next open), and `input()` while the stream is not open is
 * DROPPED and says so by returning false. What does survive a reconnect is the VIEW's wish to see
 * the stream: on the next `welcome` it is opened again with the latest params, under a new
 * `streamId`, so the extension holding the handle never has to notice the socket died.
 *
 * Pure over its deps so `streams.test.mjs` drives it with a fake socket and a fake clock; the lazy
 * singleton wired to the real socket is `streamRouter.ts`.
 */
import {
  STREAM_ACK_EVERY_MS, STREAM_INPUT_MAX, STREAM_PARAMS_MAX, decodeStreamFrame, jsonBytes,
  type ClientMessage, type HostMessage, type StreamEndCause, type StreamFrame,
} from "@waterplane/shared";

/** How long a `stream.open` may go unanswered before the view is told why. An old host never
 *  answers one (it drops a message type it does not know), and "opening…" for ever is the one
 *  answer a person cannot act on. */
export const STREAM_OPEN_TIMEOUT_MS = 15_000;
/** The rolling window `kbps` and `fps` are measured over. */
export const STREAM_RATE_WINDOW_MS = 2_000;

export type StreamState = "opening" | "open" | "ended" | "refused";
/** Why `onEnded` ran: the host's `stream.ended` cause, or `refused` for a `stream.refused` (and an
 *  open nobody answered). Every one is final here — only a reconnect is reopened by this module.
 *  `replaced` (a newer view took the plugin's slot) must not be reopened by the VIEW by itself
 *  either, or two screens take it from each other for ever: a tap does it. */
export type StreamStopCause = StreamEndCause | "refused";

export interface StreamStats {
  /** Payload bytes received over the handle's whole life (every streamId it had). */
  rxBytes: number;
  /** Frames received over the handle's whole life. */
  frames: number;
  /** Payload kilobits per second over the last `STREAM_RATE_WINDOW_MS`. */
  kbps: number;
  /** Frames per second over the same window. */
  fps: number;
  /** When it was first opened (the phone's clock), null until then. */
  openedAt: number | null;
  /** The current wire id; null while (re)opening and once over. */
  streamId: number | null;
  state: StreamState;
  /** The sentence, once `ended` or `refused`. */
  reason?: string;
}

export interface StreamCallbacks {
  /** One frame for this stream. `payload` is a view into the received buffer — copy it to keep it. */
  onFrame(frame: StreamFrame): void;
  /** The plugin's own JSON about this stream (`sub.status`). */
  onStatus?(data: unknown): void;
  /** It is over: the host ended it, or refused to open it. Not called for the handle's own `close()`. */
  onEnded?(cause: StreamStopCause, reason: string): void;
  /** Opened (again, after a reconnect) under this wire id. */
  onOpened?(streamId: number): void;
}

export interface StreamHandle {
  /** Re-steer it. Remembered either way, so a reopen after a reconnect carries the latest. False
   *  (and nothing changed) when the params are past `STREAM_PARAMS_MAX` or do not serialise. */
  setParams(params: unknown): boolean;
  /** One upstream event, at most once. False — and DROPPED, never queued — unless the stream is
   *  open on a live socket right now, or when the event is past `STREAM_INPUT_MAX`. */
  input(ev: unknown): boolean;
  /** Ask the producer for a decodable frame now. A no-op unless open. */
  keyframe(): void;
  /** Stop it. Idempotent; an open still in flight is closed the moment it is answered. */
  close(): void;
  stats(): StreamStats;
}

export interface StreamDeps {
  /** Write now or not at all (`HostConnection.trySend`): false = nothing went out, nothing queued. */
  trySend(frame: ClientMessage): boolean;
  mintId(): string;
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(t: unknown): void;
  /** Where a throw in an extension's callback is reported. It never stops the routing. */
  report?(what: string, e: unknown): void;
}

interface Entry {
  plugin: string;
  name: string;
  params: unknown;
  cb: StreamCallbacks;
  state: StreamState;
  reason?: string;
  /** The `reqId` of the open in flight, null when none is. */
  reqId: string | null;
  /** The params that open carried — a `setParams` while it was in flight is re-sent on the bind. */
  sentParams: unknown;
  /** The socket epoch the open went out on; a new `welcome` is a new epoch. */
  sentEpoch: number;
  openTimer: unknown;
  streamId: number | null;
  /** `close()` was called while an open was in flight: close whatever it binds to. */
  closing: boolean;
  openedAt: number | null;
  boundAt: number;
  rxBytes: number;
  frames: number;
  /** Payload bytes since the CURRENT streamId was bound — what `stream.ack` reports, because the
   *  host's `sentBytes` belongs to that subscription and starts at zero with it. */
  idBytes: number;
  lastSeq: number;
  ackTimer: unknown;
  /** Rolling samples for kbps/fps, oldest first. */
  samples: { t: number; bytes: number }[];
}

export function createStreams(d: StreamDeps) {
  const entries = new Set<Entry>();
  const byReq = new Map<string, Entry>();
  const byId = new Map<number, Entry>();
  /** A `welcome` has been seen on the CURRENT socket. */
  let live = false;
  let epoch = 0;

  const report = (what: string, e: unknown) => {
    try { d.report?.(what, e); } catch { /* the reporter itself failed — nothing left to tell */ }
  };
  const call = (e: Entry, what: string, fn: () => void) => {
    try { fn(); } catch (err) { report(`${e.plugin}/${e.name} ${what}`, err); }
  };
  const send = (frame: ClientMessage): boolean => {
    try { return d.trySend(frame); } catch { return false; }
  };

  const clearOpen = (e: Entry) => {
    if (e.reqId) byReq.delete(e.reqId);
    e.reqId = null;
    if (e.openTimer != null) { d.clearTimer(e.openTimer); e.openTimer = null; }
  };
  const unbind = (e: Entry) => {
    if (e.streamId != null) byId.delete(e.streamId);
    e.streamId = null;
    if (e.ackTimer != null) { d.clearTimer(e.ackTimer); e.ackTimer = null; }
  };

  /** Over for good: the host said so, or refused it. */
  const finish = (e: Entry, state: "ended" | "refused", cause: StreamStopCause, reason: string) => {
    clearOpen(e);
    unbind(e);
    entries.delete(e);
    e.state = state;
    e.reason = reason;
    call(e, "onEnded", () => e.cb.onEnded?.(cause, reason));
  };

  const sendOpen = (e: Entry) => {
    clearOpen(e);
    const reqId = d.mintId();
    const frame: ClientMessage = { t: "stream.open", reqId, plugin: e.plugin, name: e.name, ...(e.params === undefined ? {} : { params: e.params }) };
    e.sentEpoch = epoch;
    if (!send(frame)) { e.sentEpoch = -1; return; } // the next welcome tries again
    e.reqId = reqId;
    e.sentParams = e.params;
    byReq.set(reqId, e);
    e.openTimer = d.setTimer(() => {
      e.openTimer = null;
      if (e.reqId !== reqId) return;
      finish(e, "refused", "refused", "the desktop did not answer — it may be running an older version without live streams");
    }, STREAM_OPEN_TIMEOUT_MS);
  };

  const sendAck = (e: Entry) => {
    e.ackTimer = null;
    if (e.streamId == null || e.state !== "open") return;
    send({ t: "stream.ack", streamId: e.streamId, seq: e.lastSeq, rxBytes: e.idBytes });
  };

  /** The socket died: every stream it carried is gone on the host, and waits for the next one. */
  const socketGone = () => {
    live = false;
    for (const e of entries) {
      clearOpen(e);
      unbind(e);
      e.state = "opening";
    }
    // Whatever was in flight belonged to the dead socket, a closed handle's open included.
    byReq.clear();
    byId.clear();
  };

  const prune = (e: Entry, now: number) => {
    const from = now - STREAM_RATE_WINDOW_MS;
    let i = 0;
    while (i < e.samples.length && e.samples[i]!.t <= from) i++;
    if (i) e.samples.splice(0, i);
  };

  return {
    open(plugin: string, name: string, params: unknown, cb: StreamCallbacks): StreamHandle {
      const e: Entry = {
        plugin, name, params, cb, state: "opening", reqId: null, sentParams: undefined, sentEpoch: -1, openTimer: null,
        streamId: null, closing: false, openedAt: null, boundAt: 0, rxBytes: 0, frames: 0, idBytes: 0, lastSeq: 0,
        ackTimer: null, samples: [],
      };
      entries.add(e);
      if (live) sendOpen(e);
      return {
        setParams(p) {
          const n = jsonBytes(p);
          if (n < 0 || n > STREAM_PARAMS_MAX) return false;
          e.params = p;
          if (e.state === "open" && e.streamId != null) {
            if (send({ t: "stream.params", streamId: e.streamId, params: p })) e.sentParams = p;
          }
          return true;
        },
        input(ev) {
          if (e.state !== "open" || e.streamId == null || !live) return false;
          const n = jsonBytes(ev);
          if (n < 0 || n > STREAM_INPUT_MAX) return false;
          return send({ t: "stream.input", streamId: e.streamId, ev });
        },
        keyframe() {
          if (e.state === "open" && e.streamId != null) send({ t: "stream.keyframe", streamId: e.streamId });
        },
        close() {
          if (e.closing || e.state === "ended" || e.state === "refused") return;
          e.closing = true;
          entries.delete(e);
          if (e.streamId != null) send({ t: "stream.close", streamId: e.streamId });
          unbind(e);
          // An open still in flight stays mapped by its reqId so the answer can be closed too.
          if (e.openTimer != null) { d.clearTimer(e.openTimer); e.openTimer = null; }
          e.state = "ended";
          e.reason = "closed";
        },
        stats() {
          const now = d.now();
          prune(e, now);
          const span = Math.max(1, Math.min(STREAM_RATE_WINDOW_MS, now - e.boundAt));
          const bytes = e.samples.reduce((a, s) => a + s.bytes, 0);
          return {
            rxBytes: e.rxBytes,
            frames: e.frames,
            kbps: e.state === "open" ? (bytes * 8) / span : 0, // bits per ms = kilobits per second
            fps: e.state === "open" ? (e.samples.length * 1000) / span : 0,
            openedAt: e.openedAt,
            streamId: e.streamId,
            state: e.state,
            ...(e.reason !== undefined ? { reason: e.reason } : {}),
          };
        },
      };
    },

    /** Every JSON frame the socket delivers (the stream messages, `welcome`, the status edge). */
    onText(msg: HostMessage): void {
      switch (msg.t) {
        case "welcome":
          live = true;
          epoch++;
          for (const e of entries) if (e.state === "opening" && e.sentEpoch !== epoch) sendOpen(e);
          return;
        case "error":
          if (msg.context === "__status" && msg.message !== "open") socketGone();
          return;
        case "stream.opened": {
          const e = byReq.get(msg.reqId);
          if (!e) {
            // Nobody asked (or it was answered already): never leave a producer streaming to no one.
            send({ t: "stream.close", streamId: msg.streamId });
            return;
          }
          clearOpen(e);
          if (e.closing) { send({ t: "stream.close", streamId: msg.streamId }); return; }
          unbind(e);
          e.streamId = msg.streamId;
          byId.set(msg.streamId, e);
          e.state = "open";
          const now = d.now();
          e.openedAt ??= now;
          e.boundAt = now;
          e.idBytes = 0;
          e.lastSeq = 0;
          e.samples = [];
          if (e.params !== e.sentParams && send({ t: "stream.params", streamId: msg.streamId, params: e.params })) e.sentParams = e.params;
          call(e, "onOpened", () => e.cb.onOpened?.(msg.streamId));
          return;
        }
        case "stream.refused": {
          const e = byReq.get(msg.reqId);
          if (!e) return;
          if (e.closing) { clearOpen(e); return; }
          finish(e, "refused", "refused", msg.reason);
          return;
        }
        case "stream.status": {
          const e = byId.get(msg.streamId);
          if (e) call(e, "onStatus", () => e.cb.onStatus?.(msg.data));
          return;
        }
        case "stream.ended": {
          const e = byId.get(msg.streamId);
          if (e) finish(e, "ended", msg.cause, msg.reason);
          return;
        }
        default:
          return;
      }
    },

    /** One binary WS frame. Not ours, or for no open stream ⇒ dropped in silence. */
    onBinary(data: ArrayBuffer | Uint8Array): void {
      const f = decodeStreamFrame(data);
      if (!f) return;
      const e = byId.get(f.streamId);
      if (!e || e.state !== "open") return;
      const n = f.payload.byteLength;
      const now = d.now();
      e.rxBytes += n;
      e.idBytes += n;
      e.frames++;
      e.lastSeq = f.seq;
      e.samples.push({ t: now, bytes: n });
      if (e.samples.length > 512) prune(e, now);
      if (e.ackTimer == null) e.ackTimer = d.setTimer(() => sendAck(e), STREAM_ACK_EVERY_MS);
      call(e, "onFrame", () => e.cb.onFrame(f));
    },

    /** Streams the phone wants open (opening or open). */
    count: () => entries.size,
  };
}

export type Streams = ReturnType<typeof createStreams>;
