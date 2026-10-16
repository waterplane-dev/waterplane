/**
 * Frames in, pictures on a canvas: WebCodecs `VideoDecoder` for H.264 (Annex-B), `createImageBitmap`
 * for JPEG. The bytes are read by `h264.ts` (pure, tested); this file is the browser half.
 *
 * Rules it keeps:
 * - **A decode starts only at a keyframe.** Until one arrives, frames are dropped and one is asked
 *   for (at most once a second).
 * - **Display never queues.** The decoder's newest output replaces any picture still waiting for the
 *   next animation frame, and the replaced one is closed. Every `VideoFrame` and `ImageBitmap` is
 *   closed exactly once.
 * - **An error resets.** The decoder is closed, a keyframe is asked for, and frames are dropped until
 *   it comes. Errors that keep coming before anything was ever drawn mean this decoder cannot play
 *   the stream: `onUnsupported`, and the view switches to stills.
 * - **Latency is measured, not guessed**: arrival on this phone to the draw, per frame.
 */
import { FRAME_H264, FRAME_JPEG } from "../shared/wire.mts";
import { PROBE_CODEC, codecOf, isKeyframe } from "./h264.ts";

export interface PlayerEvents<T> {
  /** A picture was drawn: how long after its frame arrived, its size, and the tag it was pushed with. */
  onDrawn(latencyMs: number, w: number, h: number, tag: T): void;
  /** The decoder needs a keyframe to (re)start. */
  onNeedKey(): void;
  /** H.264 cannot be played here; stills from now on. */
  onUnsupported(why: string): void;
}

/** WebCodecs H.264 here at all? Asked once per page. */
let support: Promise<boolean> | null = null;
export function videoSupported(): Promise<boolean> {
  support ??= (async () => {
    try {
      const VD = (globalThis as { VideoDecoder?: typeof VideoDecoder }).VideoDecoder;
      if (typeof VD !== "function") return false;
      const r = await VD.isConfigSupported({ codec: PROBE_CODEC, optimizeForLatency: true });
      return !!r.supported;
    } catch { return false; }
  })();
  return support;
}

interface Pending<T> { img: VideoFrame | ImageBitmap; arrival: number; tag: T }

const KEY_ASK_MS = 1000;
const BROKEN_ERRORS = 3;
/** Frames held while a new codec string is being checked; past this, wait for the next keyframe. */
const HOLD_MAX = 90;

export class Player<T> {
  private dec: VideoDecoder | null = null;
  private codec = "";
  private waitKey = true;
  private lastAsk = 0;
  private errors = 0;
  private drawnAny = false;
  private ts = 0;
  private meta = new Map<number, { arrival: number; tag: T }>();
  private pending: Pending<T> | null = null;
  private raf = 0;
  private jpegSeq = 0;
  private jpegShown = 0;
  /** Frames waiting for an async `isConfigSupported` of a new codec string. */
  private hold: { key: boolean; data: Uint8Array; arrival: number; tag: T }[] | null = null;
  private closed = false;

  constructor(private canvas: HTMLCanvasElement, private ev: PlayerEvents<T>) {}

  /** A reopened stream: forget the decoder's state and wait for a keyframe. */
  reset(): void {
    this.closeDecoder();
    this.waitKey = true;
    this.hold = null;
  }

  close(): void {
    this.closed = true;
    this.reset();
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    if (this.pending) { this.pending.img.close(); this.pending = null; }
    this.meta.clear();
  }

  push(kind: number, payload: Uint8Array, arrival: number, tag: T): void {
    if (this.closed) return;
    if (kind === FRAME_JPEG) { this.jpeg(payload, arrival, tag); return; }
    if (kind !== FRAME_H264) return;
    const key = isKeyframe(payload);
    if (this.hold) {
      if (this.hold.length < HOLD_MAX) this.hold.push({ key, data: payload.slice(), arrival, tag });
      else { this.hold = null; this.waitKey = true; }
      return;
    }
    if (this.waitKey && !key) { this.askKey(); return; }
    if (key) {
      const codec = codecOf(payload) ?? PROBE_CODEC;
      if (!this.dec || this.dec.state === "closed" || codec !== this.codec) {
        this.hold = [{ key, data: payload.slice(), arrival, tag }];
        void this.configure(codec);
        return;
      }
    }
    this.decode(key, payload, arrival, tag);
  }

  private askKey(): void {
    const now = performance.now();
    if (now - this.lastAsk < KEY_ASK_MS) return;
    this.lastAsk = now;
    this.ev.onNeedKey();
  }

  private async configure(codec: string): Promise<void> {
    // Hardware may refuse a profile the software path plays: ask with the preference, then without.
    const tries: VideoDecoderConfig[] = [
      { codec, optimizeForLatency: true, hardwareAcceleration: "prefer-hardware" },
      { codec, optimizeForLatency: true },
    ];
    let config: VideoDecoderConfig | null = null;
    for (const c of tries) {
      try { if ((await VideoDecoder.isConfigSupported(c)).supported) { config = c; break; } } catch { /* next */ }
    }
    if (this.closed) return;
    if (!config) { this.hold = null; this.ev.onUnsupported(`this phone cannot decode ${codec}`); return; }
    this.closeDecoder();
    try {
      const dec = new VideoDecoder({ output: (f) => this.output(f), error: (e) => this.failed(e) });
      dec.configure(config);
      this.dec = dec;
      this.codec = codec;
      this.waitKey = false;
    } catch (e) {
      this.hold = null;
      this.failed(e as Error);
      return;
    }
    const held = this.hold ?? [];
    this.hold = null;
    for (const h of held) this.decode(h.key, h.data, h.arrival, h.tag);
  }

  private decode(key: boolean, data: Uint8Array, arrival: number, tag: T): void {
    if (!this.dec || this.dec.state !== "configured") { this.waitKey = true; this.askKey(); return; }
    const timestamp = ++this.ts * 1000;
    this.meta.set(timestamp, { arrival, tag });
    if (this.meta.size > 120) { const first = this.meta.keys().next().value; if (first !== undefined) this.meta.delete(first); }
    try {
      this.dec.decode(new EncodedVideoChunk({ type: key ? "key" : "delta", timestamp, data }));
    } catch (e) {
      this.failed(e as Error);
    }
  }

  private output(f: VideoFrame): void {
    const m = this.meta.get(f.timestamp);
    this.meta.delete(f.timestamp);
    if (this.closed || !m) { f.close(); return; }
    this.show({ img: f, arrival: m.arrival, tag: m.tag });
  }

  private failed(_e: Error): void {
    this.closeDecoder();
    this.waitKey = true;
    this.errors++;
    if (!this.drawnAny && this.errors >= BROKEN_ERRORS) {
      this.ev.onUnsupported("the video decoder failed on every keyframe");
      return;
    }
    this.lastAsk = 0;
    this.askKey();
  }

  private closeDecoder(): void {
    if (this.dec && this.dec.state !== "closed") { try { this.dec.close(); } catch { /* already closing */ } }
    this.dec = null;
    this.codec = "";
  }

  private jpeg(payload: Uint8Array, arrival: number, tag: T): void {
    const seq = ++this.jpegSeq;
    createImageBitmap(new Blob([payload as BlobPart], { type: "image/jpeg" })).then((bmp) => {
      // An older picture finishing after a newer one is never shown over it.
      if (this.closed || seq < this.jpegShown) { bmp.close(); return; }
      this.jpegShown = seq;
      this.show({ img: bmp, arrival, tag });
    }, () => { /* a corrupt still: the next one replaces it */ });
  }

  /** Newest wins: a picture still waiting for the next animation frame is replaced and closed. */
  private show(p: Pending<T>): void {
    if (this.pending) this.pending.img.close();
    this.pending = p;
    if (!this.raf) this.raf = requestAnimationFrame(() => this.draw());
  }

  private draw(): void {
    this.raf = 0;
    const p = this.pending;
    this.pending = null;
    if (!p || this.closed) { p?.img.close(); return; }
    const w = "displayWidth" in p.img ? p.img.displayWidth : p.img.width;
    const h = "displayHeight" in p.img ? p.img.displayHeight : p.img.height;
    if (this.canvas.width !== w) this.canvas.width = w;
    if (this.canvas.height !== h) this.canvas.height = h;
    const ctx = this.canvas.getContext("2d");
    try { ctx?.drawImage(p.img, 0, 0, w, h); } finally { p.img.close(); }
    this.drawnAny = true;
    this.errors = 0;
    this.ev.onDrawn(performance.now() - p.arrival, w, h, p.tag);
  }
}
