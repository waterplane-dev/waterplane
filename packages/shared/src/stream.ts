/**
 * Live streams on the ONE socket (plugin API 1.4, `api.stream`). A plugin produces binary
 * frames (video, stills, anything) for the sockets that asked for them. The `stream.*` JSON
 * messages open, steer and close a stream. The bytes ride as binary WebSocket frames, each
 * with the 12-byte header below. There is never a second socket (`local/no-second-socket`).
 *
 * None of this is durable. A stream is never queued offline, never ackId'd, never retried. A
 * stream opened an hour late is for a screen nobody is watching, and an input event delivered
 * late (a click) lands on a different screen. That is `intent.cancel`'s reasoning, and it is what
 * makes input at-most-once: it is sent once or not at all. A dead socket ends its streams. The
 * client reopens them on reconnect.
 *
 * The frame layout is little-endian:
 *
 *   0  u8   magic 0x57 ('W')
 *   1  u8   version (1)
 *   2  u16  streamId (host-minted, non-zero, per socket)
 *   4  u32  seq (per stream, wraps)
 *   8  u8   kind (the plugin's own vocabulary; the core never reads it)
 *   9  u8   flags (STREAM_FLAG_*)
 *  10  u16  reserved (0)
 *  12  ...  payload
 *
 * Plan: docs/analysis/desktop-stream-plan.md.
 */

export const STREAM_FRAME_MAGIC = 0x57;
export const STREAM_FRAME_VERSION = 1;
export const STREAM_HEADER_BYTES = 12;

/** A frame that starts a decodable sequence (an H.264 IDR, any self-contained still). In a
 *  healthy run it may go out past the socket's backlog line (but not past twice the line); a key
 *  that ends a skip episode waits until the backlog is back under the line. A key that is ALSO
 *  droppable (a still the next still replaces) is skipped like any droppable frame: droppable
 *  wins. Every frame, a key too, waits while the socket's PTY is held back (PTY first). */
export const STREAM_FLAG_KEY = 1;
/** A frame the host may skip when the socket is backed up (an H.264 P-frame, a still that the
 *  next still replaces). After a skip, the producer is asked for a keyframe once the backlog has
 *  drained under the line and the PTY is not held — never into the backlog itself. */
export const STREAM_FLAG_DROPPABLE = 2;

/** `name` in `stream.open` / `api.stream(name)`. */
export const STREAM_NAME_RE = /^[a-z][a-z0-9-]{0,31}$/;
/** Caps on the JSON that steers a stream, in bytes of its JSON text. */
export const STREAM_PARAMS_MAX = 8 * 1024;
export const STREAM_INPUT_MAX = 4 * 1024;
export const STREAM_STATUS_MAX = 8 * 1024;
/** A payload past this is refused by `sub.send`. It is a WS frame, not a file transfer. */
export const STREAM_PAYLOAD_MAX = 4 * 1024 * 1024;
/** Open streams per socket. A second view of the same desktop is a bug, not a feature. */
export const STREAM_MAX_PER_SOCKET = 2;
/** How often the client reports what it has received (`stream.ack`). */
export const STREAM_ACK_EVERY_MS = 250;

/** The default socket backlog past which droppable frames are skipped. */
export const STREAM_BACKLOG_DEFAULT = 256 * 1024;

/**
 * The backlog past which droppable frames are skipped, for a stream running at `bitrateBps`:
 * about 0.4 s of that stream, clamped to 64 KB–1 MiB. No bitrate given (or not a positive
 * number) gives the default. Video must never stand between a PTY frame and the phone, so the
 * line is a fraction of a second of video, never a buffer size.
 */
export function streamBacklogLimit(bitrateBps?: number): number {
  if (typeof bitrateBps !== "number" || !Number.isFinite(bitrateBps) || bitrateBps <= 0) return STREAM_BACKLOG_DEFAULT;
  const bytes = Math.round((bitrateBps * 0.4) / 8);
  return Math.min(1024 * 1024, Math.max(64 * 1024, bytes));
}

export interface StreamFrameHeader {
  streamId: number;
  seq: number;
  kind: number;
  flags: number;
}

export interface StreamFrame extends StreamFrameHeader {
  /** A view into the received buffer, not a copy. */
  payload: Uint8Array;
}

/** One binary WS frame: header + payload, as a single buffer for `ws.send`. Throws on a header
 *  field out of range. That is a programming error in the host, never input from a phone. */
export function encodeStreamFrame(h: StreamFrameHeader, payload: Uint8Array): Uint8Array {
  if (!Number.isInteger(h.streamId) || h.streamId < 1 || h.streamId > 0xffff) throw new Error(`streamId out of range: ${h.streamId}`);
  if (!Number.isInteger(h.kind) || h.kind < 0 || h.kind > 0xff) throw new Error(`kind out of range: ${h.kind}`);
  if (!Number.isInteger(h.flags) || h.flags < 0 || h.flags > 0xff) throw new Error(`flags out of range: ${h.flags}`);
  const out = new Uint8Array(STREAM_HEADER_BYTES + payload.byteLength);
  const dv = new DataView(out.buffer);
  dv.setUint8(0, STREAM_FRAME_MAGIC);
  dv.setUint8(1, STREAM_FRAME_VERSION);
  dv.setUint16(2, h.streamId, true);
  dv.setUint32(4, h.seq >>> 0, true);
  dv.setUint8(8, h.kind);
  dv.setUint8(9, h.flags);
  dv.setUint16(10, 0, true);
  out.set(payload, STREAM_HEADER_BYTES);
  return out;
}

/** Read one binary WS frame, or null when it is not one of ours (wrong magic or version, or too
 *  short). The client drops a null in silence: an unknown binary frame is never an error the
 *  person can act on. */
export function decodeStreamFrame(data: ArrayBuffer | Uint8Array): StreamFrame | null {
  const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (u8.byteLength < STREAM_HEADER_BYTES) return null;
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (dv.getUint8(0) !== STREAM_FRAME_MAGIC || dv.getUint8(1) !== STREAM_FRAME_VERSION) return null;
  const streamId = dv.getUint16(2, true);
  if (streamId === 0) return null;
  return {
    streamId,
    seq: dv.getUint32(4, true),
    kind: dv.getUint8(8),
    flags: dv.getUint8(9),
    payload: u8.subarray(STREAM_HEADER_BYTES),
  };
}

/** The JSON text length of `v`, or -1 when it does not serialise. The caps above are on this. */
export function jsonBytes(v: unknown): number {
  try {
    const s = JSON.stringify(v ?? null);
    return typeof s === "string" ? new TextEncoder().encode(s).byteLength : -1;
  } catch {
    return -1;
  }
}

/** Why a stream ended, as the host says it in `stream.ended`. `reason` is the sentence. */
export type StreamEndCause = "closed" | "plugin" | "socket" | "replaced" | "error";

// ── the plugin side (`HostPluginApi.stream`, since plugin API 1.4) ──────────

/** What `sub.send` did with one frame. `skipped`: the socket was backed up and the frame was
 *  droppable. `ended`: the subscription is over, so stop producing for it. */
export type PluginStreamSendResult = "sent" | "skipped" | "ended";

/** One socket's open view of a plugin stream. */
export interface PluginStreamSub {
  /** The `streamId` on the wire. Unique per socket, not per host. */
  readonly id: number;
  /** A host-unique key for this subscription. Use it to key per-subscriber state. */
  readonly key: string;
  /** The params it was opened or last re-steered with (validated JSON, ≤ STREAM_PARAMS_MAX). */
  readonly params: unknown;
  /** Bytes queued on the socket right now. Reading it is cheap. */
  readonly backlogBytes: number;
  /** Payload bytes sent so far. With `lastAck` this gives what is in flight. */
  readonly sentBytes: number;
  /** The newest `stream.ack`, or null before the first one. `at` is the host's clock. */
  readonly lastAck: { seq: number; rxBytes: number; at: number } | null;
  /** Send one frame. `kind` is the plugin's own (0–255). A `key` frame is skipped when also
   *  `droppable` and past the line, while the PTY is held, while it would end a skip episode with
   *  the backlog still past the line, or past twice the line (`STREAM_FLAG_KEY`). */
  send(payload: Uint8Array, o: { kind: number; key?: boolean; droppable?: boolean }): PluginStreamSendResult;
  /** JSON to this subscriber only (`stream.status`), ≤ STREAM_STATUS_MAX. Null when sent, else
   *  the refusal in words. */
  status(data: unknown): string | null;
  /** End it, with the sentence the phone shows. `cause` is `plugin` unless the plugin says
   *  `replaced`: it ended this view so a newer one could open (a cap on views, where the person
   *  opening one now beats a view nobody may be looking at). A phone must not reopen a `replaced`
   *  view by itself, or two screens take it from each other for ever. Additive: a host before it
   *  ignores the argument and says `plugin`. */
  end(reason: string, cause?: "plugin" | "replaced"): void;
}

export interface PluginStreamHandlers {
  /** A phone opened it. Return (or resolve) a sentence to refuse it, and nothing is sent. Throwing
   *  refuses it with the error's message. */
  open(sub: PluginStreamSub, params: unknown): void | string | Promise<void | string>;
  /** The phone re-steered it. `sub.params` already holds `params`. */
  params?(sub: PluginStreamSub, params: unknown): void;
  /** One upstream event, at most once, already size-checked JSON. The plugin validates it. */
  input?(sub: PluginStreamSub, ev: unknown): void;
  /** The phone asked for, or the core needs, a decodable frame now (after a skip — asked once the
   *  backlog has drained, never into it — or a decoder error). */
  keyframe?(sub: PluginStreamSub): void;
  /** A `stream.ack` arrived (`sub.lastAck` is updated). This is where a rate controller lives. */
  ack?(sub: PluginStreamSub): void;
  /** It ended: closed by the phone, the socket died, the plugin stopped, or `sub.end`. */
  close?(sub: PluginStreamSub, cause: StreamEndCause): void;
}
