import { LS, lsGet, lsSet } from "./storage";
import { uploadWidthFor } from "./collageName";
/**
 * Upload sizing — the phone half of "don't push 4 MB of screenshot up a 3G
 * uplink". Downloads already have server-made thumbnails (`media.ts` +
 * host/thumbs.ts); uploads had nothing: the annotator encodes a full-resolution
 * PNG and hands it straight to the inbox route, which on a roaming link is tens
 * of seconds of blocked send (the compose bar waits for uploads).
 *
 * Two parts: a measured/declared view of the uplink, and a canvas re-encode
 * that shrinks an image before it goes. `auto` picks the width from the link,
 * so the common case needs no decision — but the picker in the annotator is
 * deliberately in front of the send buttons, because "more/less than auto" is a
 * per-image call (a 4K UI screenshot with 10px text is not a photo).
 */

const SCALE_KEY = LS.uploadScale;
const RATE_KEY = LS.upKbps;

/** Widths offered. `full` (0) uploads the original bytes. */
export const UPLOAD_WIDTHS = [720, 1080, 1600, 2560] as const;
export type UploadScale = "auto" | "full" | 720 | 1080 | 1600 | 2560;

export function getUploadScale(): UploadScale {
  const v = lsGet(SCALE_KEY);
  if (v === "full" || v === "auto") return v;
  const n = Number(v);
  return (UPLOAD_WIDTHS as readonly number[]).includes(n) ? (n as UploadScale) : "auto";
}
export function setUploadScale(v: UploadScale): void {
  lsSet(SCALE_KEY, String(v));
}

/**
 * Remember what the uplink actually did, as an EWMA in kB/s. This is the only
 * honest bandwidth number available: `navigator.connection` reports the radio,
 * not the tunnel, and a Tailscale hop through a DERP relay is routinely an
 * order of magnitude slower than the "4g" the phone believes it has.
 *
 * Tiny or very short transfers are ignored — they measure latency, not rate.
 */
export function noteUploadRate(bytes: number, ms: number): void {
  if (bytes < 40_000 || ms < 300) return;
  const sample = bytes / 1024 / (ms / 1000);
  const prev = uploadKbps();
  const next = prev ? prev * 0.6 + sample * 0.4 : sample;
  lsSet(RATE_KEY, String(Math.round(next)));
}
export function uploadKbps(): number | null {
  const n = Number(lsGet(RATE_KEY));
  return Number.isFinite(n) && n > 0 ? n : null;
}

interface NetInfo { effectiveType?: string; downlink?: number; saveData?: boolean }
const conn = (): NetInfo | undefined =>
  (navigator as unknown as { connection?: NetInfo }).connection;

export interface LinkInfo {
  /** Measured upload rate in kB/s, when one is known. */
  kbps: number | null;
  /** Where the verdict came from — a measurement beats the radio's own claim. */
  source: "measured" | "connection" | "none";
  /** Short human label for the UI ("slow link · 90 kB/s"). */
  label: string;
  slow: boolean;
}

/** What we believe about the uplink right now. */
export function linkInfo(): LinkInfo {
  const kbps = uploadKbps();
  if (kbps !== null) {
    const slow = kbps < 200;
    return { kbps, source: "measured", slow, label: `${slow ? "slow link" : "link"} · ${Math.round(kbps)} kB/s up` };
  }
  const c = conn();
  if (c?.saveData) return { kbps: null, source: "connection", slow: true, label: "data saver on" };
  const et = c?.effectiveType;
  if (et === "slow-2g" || et === "2g") return { kbps: null, source: "connection", slow: true, label: `slow link · ${et}` };
  if (et === "3g") return { kbps: null, source: "connection", slow: true, label: "slow link · 3g" };
  if (typeof c?.downlink === "number" && c.downlink > 0 && c.downlink < 2)
    return { kbps: null, source: "connection", slow: true, label: `slow link · ${c.downlink} Mbps` };
  if (et) return { kbps: null, source: "connection", slow: false, label: et };
  return { kbps: null, source: "none", slow: false, label: "link unknown" };
}

/** Width `auto` resolves to. 0 = send the original. */
export function autoMaxWidth(): number {
  const c = conn();
  const kbps = uploadKbps();
  if (kbps !== null) {
    if (kbps < 100) return 720;
    if (kbps < 400) return 1080;
    if (kbps < 1500) return 1600;
    return 0;
  }
  if (c?.saveData) return 1080;
  const et = c?.effectiveType;
  if (et === "slow-2g" || et === "2g") return 720;
  if (et === "3g") return 1080;
  if (typeof c?.downlink === "number" && c.downlink > 0 && c.downlink < 2) return 1080;
  // Nothing known: don't degrade what the agent gets to look at.
  return 0;
}

/** The width uploads actually use, plus whether `auto` chose it. */
export function effectiveMaxWidth(): { width: number; auto: boolean } {
  const pref = getUploadScale();
  if (pref === "full") return { width: 0, auto: false };
  if (pref === "auto") return { width: autoMaxWidth(), auto: true };
  return { width: pref, auto: false };
}

/** "full" / "1080p" — one label for the picker and the strip. */
export const widthLabel = (w: number): string => (w ? `${w}px` : "full size");


/** Rough time-to-send, only when a rate has actually been measured. */
export function etaText(bytes: number, kbps: number | null): string | null {
  if (!kbps || bytes <= 0) return null;
  const s = Math.round(bytes / 1024 / kbps);
  return s < 60 ? `~${Math.max(1, s)}s` : `~${Math.round(s / 60)}m`;
}

const SCALABLE = /^image\/(png|jpeg|webp|bmp|heic|heif)$/i;

/**
 * Re-encode an image down to `maxWidth` per panel (`uploadWidthFor`) (JPEG, since the source is a screenshot
 * or a photo, never line art that needs lossless). Returns the ORIGINAL blob
 * whenever shrinking wouldn't help — already narrow enough, unsupported type,
 * decode failure, or a result that came out bigger. Never throws, and never
 * HANGS: an upload that can't be shrunk still has to happen.
 */
export async function scaleForUpload(
  blob: Blob, name: string, maxWidth: number,
): Promise<{ blob: Blob; name: string; scaled: boolean; width?: number; height?: number }> {
  const keep = { blob, name, scaled: false };
  maxWidth = uploadWidthFor(name, maxWidth);
  if (!maxWidth || !SCALABLE.test(blob.type || "")) return keep;
  // A file already smaller than one screenshot's worth of bytes isn't the problem.
  if (blob.size < 120_000) return keep;
  try {
    const bmp = await withTimeout(decodeImage(blob), null);
    if (!bmp) return keep;
    const w = bmp.width, h = bmp.height;
    if (!w || !h) return keep;
    if (w <= maxWidth) { close(bmp); return keep; }
    const scale = maxWidth / w;
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(w * scale));
    canvas.height = Math.max(1, Math.round(h * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) { close(bmp); return keep; }
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bmp as CanvasImageSource, 0, 0, canvas.width, canvas.height);
    close(bmp);
    const out = await encodeCanvas(canvas, "image/jpeg", 0.82);
    if (!out || out.size >= blob.size) return keep;
    // The grid the bytes actually carry. Answered only on this path: everywhere
    // else the original is passed through untouched and its size is the caller's
    // to know — a decode here to state a number would be a decode nobody asked
    // for, and a guessed number is worse than none (`annNote.withUploadSize`).
    return { blob: out, name: name.replace(/\.[A-Za-z0-9]+$/, "") + ".jpg", scaled: true, width: canvas.width, height: canvas.height };
  } catch { return keep; }
}

/**
 * Bound a decode/encode step. Both of them are browser callbacks that can
 * simply never fire — an `<img>` fed a codec the WebView half-supports resolves
 * neither `onload` nor `onerror`, and `canvas.toBlob` under memory pressure has
 * the same failure — and the caller of this module parks the UI in an "adding…"
 * state while it waits. Timing out means the ORIGINAL bytes are uploaded, which
 * is the same degradation every other branch here takes.
 */
const SCALE_TIMEOUT_MS = 8000;
export function withTimeout<T>(p: Promise<T>, fallback: T, ms = SCALE_TIMEOUT_MS): Promise<T> {
  return new Promise<T>((res) => {
    const t = setTimeout(() => res(fallback), ms);
    p.then((v) => { clearTimeout(t); res(v); }, () => { clearTimeout(t); res(fallback); });
  });
}

/** How long `toBlob` may take when the synchronous encoder failed too. Generous: this
 *  bounds the failure mode where the callback never comes at all, not slowness. */
const ENCODE_TIMEOUT_MS = 20_000;

/** How long `toBlob` gets before the synchronous encoder is used instead. */
const ENCODE_PATIENCE_MS = 250;

/**
 * Turn a canvas into bytes, the only way that survives an Android WebView.
 *
 * `canvas.toBlob` is the whole story on a desktop, and on a phone it has four
 * separate failure modes that all look like "nothing happened": it can hand
 * back `null`, it can hand back a zero-length blob, it can simply never invoke
 * its callback because the encode could not be allocated, and it can be SLOW
 * for a reason that is not the picture: Chromium encodes PNG and JPEG in the
 * main thread's IDLE time, so anything busy every frame starves it. Measured
 * 2026-11-24 on a 2036 x 2244 canvas at 1/4 CPU: 85 ms on an idle page, 2.1 s
 * (PNG 4.8 s) beside 8 ms of work per frame. `toDataURL` is synchronous and
 * took 91 ms (PNG 168 ms) either way.
 *
 * So: a short wait, then the OTHER encoder. Where that one fails, the callback
 * still running is given its full time, because the two fail independently.
 *
 * Written once here rather than at each canvas: `collage.ts` learned all of
 * this the hard way and `ImageAnnotator.tsx`, one directory away, still had the
 * bare `toBlob` with no timeout and no fallback — so the one flow whose whole
 * job is "mark up this screenshot and send it" could park on `Sending…` for
 * ever on exactly the device this app is for.
 *
 * The synchronous encode reads the canvas when it RUNS. A canvas the caller may
 * repaint meanwhile is `live`: it is copied first, because the annotator moves
 * on to the next picture on the same tap and a late read would send that one
 * under this one's name. Where the copy cannot be made, a live canvas gets
 * `toBlob` alone, which snapshots when called.
 */
export async function encodeCanvas(
  canvas: HTMLCanvasElement, type = "image/jpeg", quality = 0.9, opts: { live?: boolean } = {},
): Promise<Blob | null> {
  const copy = opts.live ? copyCanvas(canvas) : null;
  const src = copy ?? canvas;
  const job = new Promise<Blob | null>((res) => src.toBlob(res, type, quality)).catch(() => null);
  const good = (b: Blob | null): Blob | null => (b && b.size > 0 ? b : null);
  try {
    const quick = good(await withTimeout(job, null, ENCODE_PATIENCE_MS));
    if (quick) return quick;
    const sync = opts.live && !copy ? null : encodeSync(src, type, quality);
    return sync ?? good(await withTimeout(job, null, ENCODE_TIMEOUT_MS));
  } finally {
    if (copy) copy.width = copy.height = 0;
  }
}

/** A canvas of the same pixels, or null where this device cannot hold a second one. */
function copyCanvas(canvas: HTMLCanvasElement): HTMLCanvasElement | null {
  try {
    const c = document.createElement("canvas");
    c.width = canvas.width;
    c.height = canvas.height;
    if (!c.width || c.width !== canvas.width || c.height !== canvas.height) return null;
    const ctx = c.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(canvas, 0, 0);
    return c;
  } catch { return null; }
}

function encodeSync(canvas: HTMLCanvasElement, type: string, quality: number): Blob | null {
  try {
    const url = canvas.toDataURL(type, quality);
    const comma = url.indexOf(",");
    // A canvas that could not encode as asked returns some OTHER type (usually
    // `data:,`); taking those bytes would ship a file whose name lies about it.
    if (!url.startsWith(`data:${type}`) || comma < 0) return null;
    const bin = atob(url.slice(comma + 1));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.length ? new Blob([bytes], { type }) : null;
  } catch { return null; }
}

function close(bmp: ImageBitmap | HTMLImageElement) {
  if (typeof ImageBitmap !== "undefined" && bmp instanceof ImageBitmap) bmp.close();
}

/**
 * createImageBitmap where available (off-main-thread decode), `<img>` otherwise.
 *
 * Exported because `collage.ts` needs the same two-step fallback: a WebView that
 * cannot `createImageBitmap` a HEIC is exactly the device this app runs on, and
 * a second copy of this would be a second place that forgets the `<img>` path.
 */
export async function decodeImage(blob: Blob): Promise<ImageBitmap | HTMLImageElement | null> {
  if (typeof createImageBitmap === "function") {
    try { return await createImageBitmap(blob); } catch { /* fall through */ }
  }
  return await new Promise((res) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); res(img); };
    img.onerror = () => { URL.revokeObjectURL(url); res(null); };
    img.src = url;
  });
}
