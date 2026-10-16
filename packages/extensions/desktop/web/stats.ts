/**
 * What this view has cost, counted honestly. Pure (`stats.test.mjs`).
 *
 * A total is never printed without its split: video frames apart from keyframes (a keyframe is
 * many times a P-frame, and a reopened view or a decoder error costs one), and the upstream input
 * events counted apart. Latency is the time from a frame ARRIVING on the phone to it being DRAWN —
 * what the phone can measure; a desktop-to-glass figure would need the desktop's clock, and an
 * invented number is worse than "—".
 */

export interface Meter {
  /** Payload bytes of non-key frames this view. */
  videoBytes: number;
  /** Payload bytes of keyframes (every JPEG is one). */
  keyBytes: number;
  frames: number;
  keyframes: number;
  /** Upstream events sent (clicks, moves, keys, text). */
  inputs: number;
  /** Recent arrival→draw times, ms, newest last. */
  lat: number[];
}

export const LAT_SAMPLES = 30;

export const newMeter = (): Meter => ({ videoBytes: 0, keyBytes: 0, frames: 0, keyframes: 0, inputs: 0, lat: [] });

export function addFrame(m: Meter, bytes: number, key: boolean): Meter {
  return key
    ? { ...m, keyBytes: m.keyBytes + bytes, frames: m.frames + 1, keyframes: m.keyframes + 1 }
    : { ...m, videoBytes: m.videoBytes + bytes, frames: m.frames + 1 };
}

export function addInputs(m: Meter, n: number): Meter {
  return n ? { ...m, inputs: m.inputs + n } : m;
}

export function addLatency(m: Meter, ms: number): Meter {
  if (!Number.isFinite(ms) || ms < 0) return m;
  const lat = m.lat.length >= LAT_SAMPLES ? [...m.lat.slice(1 - LAT_SAMPLES), ms] : [...m.lat, ms];
  return { ...m, lat };
}

/** The median of the recent samples, or null with none: the chip then says "—". */
export function latencyMs(m: Meter): number | null {
  if (!m.lat.length) return null;
  const s = [...m.lat].sort((a, b) => a - b);
  return Math.round(s[Math.floor(s.length / 2)]!);
}

export const totalBytes = (m: Meter): number => m.videoBytes + m.keyBytes;

export const mb = (bytes: number): string => (bytes >= 10e6 ? (bytes / 1e6).toFixed(0) : (bytes / 1e6).toFixed(1));

/** The chip: `kbps · fps · ms · MB`. */
export function chipText(kbps: number, fps: number, m: Meter): string {
  const ms = latencyMs(m);
  return `${Math.round(kbps)} kbps · ${Math.round(fps)} fps · ${ms == null ? "—" : ms} ms · ${mb(totalBytes(m))} MB`;
}

/** The expanded chip's lines, each total with its split. */
export function detailLines(m: Meter, s: { width?: number; height?: number; codec?: string; bitrateKbps?: number; auto?: boolean } | null): string[] {
  const lines = [
    `this view: ${mb(totalBytes(m))} MB — video ${mb(m.videoBytes)} MB, keyframes ${mb(m.keyBytes)} MB (${m.keyframes} of ${m.frames} frames)`,
    `sent up: ${m.inputs} input event${m.inputs === 1 ? "" : "s"}`,
    s?.width && s.height ? `picture: ${s.width}×${s.height}${s.codec ? ` ${s.codec === "jpeg" ? "JPEG" : "H.264"}` : ""}` : "picture: not yet known",
  ];
  if (s?.bitrateKbps != null) lines.push(`${s.auto ? "Auto is at" : "bitrate cap"}: ${Math.round(s.bitrateKbps)} kbit/s`);
  const ms = latencyMs(m);
  lines.push(ms == null ? "latency: — (no frame drawn yet)" : `latency: ${ms} ms from arrival on this phone to the screen (not counting the network)`);
  return lines;
}

/** Whether the data cap is reached: `capMb` 0 is no cap. `fromBytes` is where it was last resumed
 *  (the view's total then), so a Resume grants another `capMb` and the total keeps counting. */
export function overCap(m: Meter, capMb: number, fromBytes = 0): boolean {
  return capMb > 0 && totalBytes(m) - fromBytes >= capMb * 1e6;
}

export function capSentence(capMb: number): string {
  return `Paused after ${capMb} MB — the data cap you set for one view. Resume starts another ${capMb} MB.`;
}
