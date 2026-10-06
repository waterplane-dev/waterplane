/**
 * The frames a socket hears before anyone is listening, kept for the first
 * subscriber instead of dropped (`ws.ts`).
 *
 * `makeConnection()` dials during App's first RENDER, and App subscribes in an
 * EFFECT. Whatever lands in between — the `welcome`, `session.list` and the
 * rest of the hello batch, which the host sends ONCE — used to go to an empty
 * listener set. Chromium happened to run the effects first; WebKit (Safari,
 * every iPhone) ran the demo's in-memory socket first, and the phone sat on
 * "0 live · syncing sessions…" for good. A real link only won the race by its
 * round trip.
 *
 * Boot-only: once the held frames are handed over, a frame with nobody
 * listening is dropped as before. Bounded, so a page that never subscribes
 * cannot grow it without end; the frames past the bound are the ones dropped.
 * Pure, node-tested (`heldFrames.test.mjs`).
 */
export const HELD_FRAMES_MAX = 1000;

export class HeldFrames<M> {
  private held: M[] | null = [];
  private flushing = false;

  /** True when `msg` was kept for the first subscriber rather than delivered now.
   *  Also true between the first subscription and the hand-over, so order holds. */
  keep(msg: M, listeners: number): boolean {
    if (!this.held) return false;
    if (listeners > 0 && !this.flushing) return false;
    if (this.held.length < HELD_FRAMES_MAX) this.held.push(msg);
    return true;
  }

  /**
   * A listener subscribed. The first time, every kept frame is handed to
   * `deliver` in arrival order — `later` (a microtask) so the subscribers that
   * register in the same effect pass all hear them, not just the first one.
   */
  subscribed(later: (fn: () => void) => void, deliver: (msg: M) => void): void {
    if (!this.held || this.flushing) return;
    this.flushing = true;
    later(() => {
      const held = this.held ?? [];
      this.held = null;
      this.flushing = false;
      for (const m of held) deliver(m);
    });
  }
}
