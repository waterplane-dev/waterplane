/**
 * How big the git view's before/after pictures are drawn (`GitMediaDiff`).
 *
 * A multiple of the fit width, applied as LAYOUT width inside one scroll box —
 * never a CSS transform: a transformed layer wider than the GPU's max texture
 * renders black on many Android GPUs (`ZoomableImage.tsx`), a wide laid-out
 * image is rastered in tiles. Both sides share the one value, so the same spot
 * of the before and the after stays one scroll apart.
 */
export const MEDIA_ZOOM_MIN = 1;
export const MEDIA_ZOOM_MAX = 4;
const STEPS = [1, 1.5, 2, 3, 4];

/** Clamp a pinch's continuous value into the range; NaN falls back to fit. */
export function clampMediaZoom(z: number): number {
  if (!Number.isFinite(z)) return MEDIA_ZOOM_MIN;
  return Math.min(MEDIA_ZOOM_MAX, Math.max(MEDIA_ZOOM_MIN, z));
}

/** The next button step from `z` (which a pinch may have left between steps), or null at that end. */
export function nextMediaZoom(z: number, dir: 1 | -1): number | null {
  const c = clampMediaZoom(z);
  const eps = 0.01;
  const next = dir > 0 ? STEPS.find((s) => s > c + eps) : [...STEPS].reverse().find((s) => s < c - eps);
  return next ?? null;
}
