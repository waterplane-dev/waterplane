/**
 * Is the microphone still hearing anything? The pure half of `useVoice`'s
 * watchdog, node-tested in `dictateWatch.test.mjs`.
 *
 * Reported: *"voice input seems to stop processing my audio at a certain point,
 * and I have no indication of it"*. A long dictation is a phone nobody touches,
 * so the screen times out; the WebView is paused, the `AudioContext` with it,
 * and the capture stops receiving frames — while the button, drawn from a React
 * flag nobody cleared, went on saying *listening*. A phone call, another app
 * taking the microphone or a Bluetooth headset dropping out end the track the
 * same way. The words after that point were never recorded, and nothing said so.
 *
 * The capture's own frame count is the only honest clock: it advances only
 * while audio actually arrives. So the button shows THAT (it freezes when the
 * microphone does), and a gap between it and the wall clock is a stall.
 */

/** How far the audio may fall behind the wall clock before it is a stall. A
 *  4096-frame callback at 16 kHz is 256 ms, so two seconds is eight missed
 *  callbacks — never scheduling jitter. */
export const STALL_MS = 2_000;

/** How far the audio may fall behind the wall clock since the open. Checked
 *  apart from `STALL_MS` because a context resumed after the screen came back
 *  counts frames again at once — the gap is then in the MIDDLE of the clip, and
 *  only the running total shows it. A second of slack for the graph's start. */
export const LAG_MS = 3_000;

/** Before the per-clip cap, when the person is told the clip will roll over. */
export const CAP_WARN_SECONDS = 20;

export interface CaptureFacts {
  now: number;
  /** When the microphone opened. */
  startedAt: number;
  /** Seconds of audio the capture actually holds. */
  heardSeconds: number;
  /** When frames were last counted (the open, before the first callback). */
  lastFrameAt: number;
  /** `MediaStreamTrack.readyState` of the microphone. */
  track: "live" | "ended" | string;
  /** `AudioContext.state` — `running`, `suspended`, `interrupted` (Safari), `closed`. */
  ctx: string;
  /** Whether the page is visible. Hidden is the usual cause, and worth naming. */
  visible: boolean;
}

/**
 * Why the microphone is not hearing anything, as the end of a sentence — or
 * null while it is. Checked in the order that names the most specific cause.
 */
export function captureStall(f: CaptureFacts): string | null {
  if (f.track === "ended") return "the microphone was taken away (a call, another app, or a headset disconnecting)";
  if (f.ctx === "closed") return "the recording was closed";
  if (f.now - f.lastFrameAt < STALL_MS && f.now - f.startedAt - f.heardSeconds * 1000 < LAG_MS) return null;
  if (!f.visible) return "the app went to the background or the screen turned off";
  if (f.ctx !== "running") return "the phone paused the audio (usually the screen turning off)";
  return "the audio was interrupted (usually the screen turning off or the app leaving the foreground)";
}

/** `m:ss`, the clock on the microphone button. */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** The sentence for a stall: WHEN it stopped hearing, and what happens to the
 *  part that was heard. */
export function stallToast(heardSeconds: number, why: string): string {
  return `dictation stopped hearing you at ${clock(heardSeconds)} — ${why}. Everything up to then is being read; tap the mic to go on.`;
}
