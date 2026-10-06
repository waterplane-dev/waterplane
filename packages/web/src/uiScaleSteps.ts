/**
 * The steps, and the clamp — the half of `uiScale.ts` that touches nothing.
 *
 * Split out for this repo's usual reason (`downloadState.ts` to `pull.ts`,
 * `costNotice.ts` to the cost pill): the rule worth pinning is arithmetic over a
 * value read from `localStorage`, and a module that imports storage cannot be
 * loaded by a test.
 */

/**
 * The steps, as multipliers.
 *
 * Named rather than free: a slider invites 1.07, which is indistinguishable from
 * 1 and makes a person wonder whether the control works. Each step here is a
 * visible change. The range stops where the layout does — past ~1.5 the two-line
 * rows this app is built from start wrapping to three, and a setting that can
 * break the screen it is set from is a trap.
 */
export const TEXT_STEPS = [
  { label: "smaller", value: 0.9 },
  { label: "default", value: 1 },
  { label: "larger", value: 1.15 },
  { label: "largest", value: 1.3 },
  { label: "huge", value: 1.45 },
] as const;

export const ICON_STEPS = [
  { label: "smaller", value: 0.9 },
  { label: "default", value: 1 },
  { label: "larger", value: 1.2 },
  { label: "largest", value: 1.4 },
] as const;

export const TEXT_MIN = 0.9;
export const TEXT_MAX = 1.45;
export const ICON_MIN = 0.9;
export const ICON_MAX = 1.4;

/**
 * A stored multiplier, as a number this app is willing to render at.
 *
 * Clamped on the way OUT rather than trusted on the way in: this is a value in
 * `localStorage`, which is a file a person can edit and a place an older build
 * may have written a different range into. A 4x that survived would render an
 * app nobody can reach the settings screen in to undo it — the one failure this
 * setting must not be able to cause.
 *
 * Anything unparseable is 1 and never `NaN`: `calc(13px * NaN)` is an invalid
 * declaration, and an invalid declaration drops the whole rule — so a typo in
 * storage would un-style the app rather than mis-size it.
 */
export function clampScale(raw: string | null, min: number, max: number): number {
  const n = Number(raw);
  if (raw === null || raw.trim() === "" || !Number.isFinite(n)) return 1;
  return Math.min(max, Math.max(min, n));
}

/**
 * The terminal's own zoom, ON TOP of the text size — and why it is a second
 * knob rather than the first one doing more work.
 *
 * `textScale` above sizes the app AND the terminal, which is right for eyesight
 * and wrong for the question actually being asked here: *"I want to see more
 * text on screen."* That is not a complaint about legibility, it is a complaint
 * about how many columns and rows the CLI gets — a smaller terminal font means
 * a bigger GRID, which is a fact about the session, not about the reader. The
 * two wants are opposite as often as not: lists and sheets comfortably large,
 * the TUI dense enough that a diff fits.
 *
 * So it multiplies rather than replaces. Somebody who already set "larger"
 * because they cannot read 13px keeps that everywhere, and zooming the console
 * out moves them relative to it rather than back to a size they rejected.
 *
 * The range is wider than `TEXT_STEPS` in both directions for the same reason
 * that range is narrow: what stops the text steps is the LAYOUT (two-line rows
 * wrapping to three), and a canvas that redraws itself in whatever cell size it
 * is given has no such edge. What bounds it instead is the pixel result, below.
 */
export const TERM_BASE_PX = 13;
export const TERM_ZOOM_STEPS = [0.6, 0.7, 0.8, 0.9, 1, 1.15, 1.3, 1.5] as const;
export const TERM_ZOOM_MIN = 0.6;
export const TERM_ZOOM_MAX = 1.5;
/**
 * Where the pixels stop, whatever the two multipliers say between them.
 *
 * 6px is not "dense", it is an unreadable smear that a person then has to
 * undo — and the button that would undo it is in an app that just got stepped
 * on too (the text scale is in the product). 7 is small and still shaped like
 * letters on a phone screen; 28 is past the point where the grid is too narrow
 * for the CLI to draw its own boxes in.
 */
export const TERM_PX_MIN = 7;
export const TERM_PX_MAX = 28;

/** What xterm is actually told, given both multipliers. One rounding, one
 *  clamp, in one place — the terminal, the toolbar readout and the settings row
 *  all quote THIS, or the number on screen is not the number being rendered. */
export function termFontPx(text: number, zoom: number): number {
  const px = Math.round(TERM_BASE_PX * text * zoom);
  if (!Number.isFinite(px)) return TERM_BASE_PX;
  return Math.min(TERM_PX_MAX, Math.max(TERM_PX_MIN, px));
}

/**
 * The next zoom step in `dir`, or `null` when that direction is spent.
 *
 * `null` is what the caller renders as NO BUTTON — never as a dimmed one
 * (`Unavailable.tsx`): on a phone a greyed control and a live one differ by an
 * opacity nobody reads, and the reason lives in a `title` nothing can hover.
 *
 * Steps whose pixel result is the one already on screen are SKIPPED rather than
 * offered, because the clamp above can make two neighbouring multipliers land
 * on the same size — and a button that visibly does nothing is worse than a
 * button that is not there. Scanning outward rather than stopping means a step
 * flattened by the clamp costs the next one, not the whole direction.
 */
export function nextZoomStep(cur: number, dir: 1 | -1, effect: (z: number) => number): number | null {
  const steps = TERM_ZOOM_STEPS;
  // Nearest step to whatever is stored: the value may come from a hand-edited
  // localStorage or from a build with a different ladder, and neither is a
  // reason for the buttons to stop working.
  let i = 0;
  for (let k = 1; k < steps.length; k++) {
    if (Math.abs(steps[k] - cur) < Math.abs(steps[i] - cur)) i = k;
  }
  const now = effect(cur);
  for (let k = i + dir; k >= 0 && k < steps.length; k += dir) {
    if (effect(steps[k]) !== now) return steps[k];
  }
  return null;
}

/** The console's ladder: what changes is the pixel size xterm is told. */
export const nextTermZoom = (cur: number, dir: 1 | -1, text: number): number | null =>
  nextZoomStep(cur, dir, (z) => termFontPx(text, z));

/**
 * The READER's zoom — the same ladder over a different surface.
 *
 * The reader is HTML, not a canvas, so there is no single font size to push:
 * every size in it is already `calc(Npx * var(--ui-font))`, and the whole
 * document re-sizes by overriding that one property on the reader's subtree.
 * So what this produces is a MULTIPLIER, not a pixel count — `readerScale` is
 * the text setting times the zoom, clamped as a product.
 *
 * The clamp is the same argument as the console's pixel floor, one level up:
 * 0.45 of the app's smallest text is not "dense", it is a page nobody can read
 * the way out of, and the way out is drawn at a size this very number owns.
 * Rounded to hundredths so two steps that land on the same rendered size are
 * skipped rather than offered as a button that does nothing.
 */
export const READER_SCALE_MIN = 0.6;
export const READER_SCALE_MAX = 1.9;

export function readerScale(text: number, zoom: number): number {
  const v = text * zoom;
  if (!Number.isFinite(v)) return 1;
  return Math.round(Math.min(READER_SCALE_MAX, Math.max(READER_SCALE_MIN, v)) * 100) / 100;
}

export const nextReaderZoom = (cur: number, dir: 1 | -1, text: number): number | null =>
  nextZoomStep(cur, dir, (z) => readerScale(text, z));
