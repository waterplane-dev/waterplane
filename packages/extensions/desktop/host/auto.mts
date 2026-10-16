/**
 * The Auto controller (docs/analysis/desktop-stream-plan.md §5): one per stream with `auto` on.
 * Pure: the caller hands it the numbers on every tick and sends what it answers.
 *
 * - in flight = bytes sent − the phone's `rxBytes` (both payload bytes, per stream).
 * - in flight over 0.5 s of the current bitrate on every tick for `AUTO_PERSIST_MS`, or any
 *   skipped frame since the last tick ⇒ bitrate × 0.7, never under 100 kbit/s (or under the cap,
 *   when the cap is lower). In flight must PERSIST because `rx` lags: the phone acks every 250 ms,
 *   so a steady stream already shows ~0.3 s in flight, and one keyframe (every pinch re-aim asks for
 *   one) tips a single tick over the line on a link that is fine. Read on one tick, every re-aim cut
 *   the bitrate by 30%. A skip is the core's own proof of a backlog, so it still counts at once.
 * - 5 s clean while frames were actually going out ⇒ × 1.15, never over the cap. A still
 *   screen sends nothing, and a link that carried nothing proved nothing.
 * - under 400 kbit/s the frame rate follows: half the cap, never under 5 (or the cap, if lower).
 * - one change per second at most. A decrease that has to wait is not forgotten: the skips stay
 *   counted until a change is allowed.
 *
 * The answer says whether the fps moved, because that is a `config` to the helper (a new
 * session) where a bitrate alone is the cheap `{"t":"bitrate"}`.
 */

export const AUTO_FLOOR_KBPS = 100;
export const AUTO_START_KBPS = 1000;
export const AUTO_LOW_KBPS = 400;
export const AUTO_MIN_FPS = 5;
export const AUTO_DOWN = 0.7;
export const AUTO_UP = 1.15;
export const AUTO_CLEAN_MS = 5000;
export const AUTO_GAP_MS = 1000;
export const AUTO_INFLIGHT_SEC = 0.5;
/** How long in flight must stay over the line, tick after tick, before it is congestion: three
 *  ack intervals, so a keyframe's bytes have been acked before they are read as a slow link. */
export const AUTO_PERSIST_MS = 750;

/** The frame rate for a bitrate, under a cap. */
export function autoFps(kbps: number, capFps: number): number {
  if (kbps >= AUTO_LOW_KBPS) return capFps;
  return Math.min(capFps, Math.max(AUTO_MIN_FPS, Math.round(capFps / 2)));
}

export interface AutoTick {
  /** Payload bytes sent on this stream so far. */
  sent: number;
  /** The phone's newest `rxBytes`, or null before its first ack. */
  rx: number | null;
  /** Frames skipped on this stream so far (a running count). */
  skips: number;
  now: number;
}

export interface AutoChange { kbps: number; fps: number; fpsChanged: boolean; why: "congested" | "clean" }

export class AutoController {
  private kbpsNow: number;
  private capKbps: number;
  private capFps: number;
  private lastChangeAt: number;
  private cleanSince: number;
  private sentAtClean: number;
  private skipsSeen = 0;
  /** When in flight went over the line, on an unbroken run of ticks; null while it is under. */
  private overSince: number | null = null;

  constructor(capKbps: number, capFps: number, now: number, startKbps = AUTO_START_KBPS) {
    this.capKbps = Math.max(1, capKbps);
    this.capFps = Math.max(1, capFps);
    this.kbpsNow = Math.max(this.floor, Math.min(this.capKbps, startKbps));
    this.lastChangeAt = now;
    this.cleanSince = now;
    this.sentAtClean = 0;
  }

  get kbps(): number { return this.kbpsNow; }
  /** 100 kbit/s, or the cap when the phone asked for less than that. */
  private get floor(): number { return Math.min(AUTO_FLOOR_KBPS, this.capKbps); }
  get fps(): number { return autoFps(this.kbpsNow, this.capFps); }

  /** New caps from the phone (a params change). The bitrate is clamped under the new cap, and the
   *  clean clock restarts: a new picture is a new measurement. */
  setCaps(capKbps: number, capFps: number, now: number, sent: number): void {
    this.capKbps = Math.max(1, capKbps);
    this.capFps = Math.max(1, capFps);
    this.kbpsNow = Math.max(this.floor, Math.min(this.kbpsNow, this.capKbps));
    this.cleanSince = now;
    this.sentAtClean = sent;
    this.overSince = null;
  }

  /** One look at the link. Null when nothing changes. */
  tick(t: AutoTick): AutoChange | null {
    const inFlight = t.rx === null ? 0 : Math.max(0, t.sent - t.rx);
    const over = inFlight * 8 > AUTO_INFLIGHT_SEC * this.kbpsNow * 1000;
    if (!over) this.overSince = null;
    else if (this.overSince === null) this.overSince = t.now;
    const persisted = over && this.overSince !== null && t.now - this.overSince >= AUTO_PERSIST_MS;
    const congested = persisted || t.skips > this.skipsSeen;
    if (over && !congested) return null; // one keyframe in flight, maybe: not proof yet, and not clean either
    const mayChange = t.now - this.lastChangeAt >= AUTO_GAP_MS;
    const fpsBefore = this.fps;
    if (congested) {
      this.cleanSince = t.now;
      this.sentAtClean = t.sent;
      if (!mayChange) return null; // the skips stay unseen until a change is allowed
      this.skipsSeen = t.skips;
      const next = Math.max(this.floor, Math.round(this.kbpsNow * AUTO_DOWN));
      if (next === this.kbpsNow) return null;
      return this.change(next, fpsBefore, t.now, "congested");
    }
    if (t.now - this.cleanSince < AUTO_CLEAN_MS || !mayChange || this.kbpsNow >= this.capKbps) return null;
    if (t.sent <= this.sentAtClean) return null; // nothing went out: the link proved nothing
    const next = Math.min(this.capKbps, Math.round(this.kbpsNow * AUTO_UP));
    this.cleanSince = t.now;
    this.sentAtClean = t.sent;
    if (next === this.kbpsNow) return null;
    return this.change(next, fpsBefore, t.now, "clean");
  }

  private change(kbps: number, fpsBefore: number, now: number, why: AutoChange["why"]): AutoChange {
    this.kbpsNow = kbps;
    this.lastChangeAt = now;
    const fps = this.fps;
    return { kbps, fps, fpsChanged: fps !== fpsBefore, why };
  }
}
