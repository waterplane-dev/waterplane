/**
 * How much of the session's chrome (header + status line) stays on screen,
 * dragged by the grip under it (`ChromeGrip.tsx`), kept per device
 * (`LS.sessChromeH`).
 *
 * The cap CLIPS from the bottom: the status line goes first, then the chip and
 * control row, the title last — the title row holds Back and the session's
 * name, which is what a person shrinking the header still wants to see.
 *
 * `null` is "no cap": the chrome at its natural height, which is the default
 * and what dragging past the bottom of the content snaps back to. A cap is never
 * stored at or above the natural height, so content that grows later (a second
 * status line) is shown rather than silently cut by an old drag.
 */
export const CHROME_STEP_PX = 16;

/** The cap a drag of `dy` px from `startPx` leaves, or null once it reaches the content. */
export function chromeCapAfter(startPx: number, dy: number, naturalPx: number): number | null {
  const v = Math.round(startPx + dy);
  if (v >= naturalPx) return null;
  return Math.max(0, v);
}

/** A stored value read back: a positive finite number, else no cap. */
export function chromeCapOf(raw: string | null): number | null {
  if (raw == null || raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}
