/**
 * THE SIDEBAR'S WIDTH on a wide window — dragged by its right edge
 * (`SideGrip.tsx`), kept per device (`LS.wideSideW`).
 *
 * 320 stays the default (styles.css P1c says why). The floor is where the
 * launcher's rows stop fitting a repo name and its badges; the ceiling leaves
 * the main pane `SIDE_MAIN_MIN_PX`, about 80 terminal columns. CSS clamps the
 * SAME numbers against the live viewport (`--ws-side`), so a window dragged
 * narrower than the stored width squeezes the sidebar without rewriting it.
 */
export const SIDE_DEFAULT_PX = 320;
export const SIDE_MIN_PX = 240;
export const SIDE_MAX_PX = 760;
export const SIDE_MAIN_MIN_PX = 600;
/** One arrow-key press on the focused grip; Shift is five. */
export const SIDE_STEP_PX = 16;

/** The width a drag or a stored value may take in a `viewport`-wide window.
 *  Not a number → the default; never below the floor, even in a window too
 *  narrow to honour the main pane's minimum. */
export function clampSide(w: number, viewport: number): number {
  if (!Number.isFinite(w)) return SIDE_DEFAULT_PX;
  const room = Number.isFinite(viewport) ? viewport - SIDE_MAIN_MIN_PX : SIDE_MAX_PX;
  const max = Math.max(SIDE_MIN_PX, Math.min(SIDE_MAX_PX, room));
  return Math.round(Math.min(max, Math.max(SIDE_MIN_PX, w)));
}
