/**
 * Where the fullscreen handle sits: its centre as a fraction of the picture's box, so a turn of the
 * phone keeps it on the same side. Clamped so the whole button stays on the glass; a stored value
 * from an older build (or garbage) falls back to the default, the top-right corner.
 */
export interface Spot { x: number; y: number }

export const DEFAULT_SPOT: Spot = { x: 0.94, y: 0.12 };
/** Movement (px) under which a press is a tap, not a drag. */
export const DRAG_SLOP = 8;

const unit = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;

export function cleanSpot(v: unknown): Spot {
  const s = v as Partial<Spot> | null;
  return s && unit(s.x) && unit(s.y) ? { x: s.x, y: s.y } : DEFAULT_SPOT;
}

/** A finger at `px`,`py` inside a `w`×`h` box, with a button `size` px across, as a clamped spot. */
export function spotAt(px: number, py: number, w: number, h: number, size: number): Spot {
  const clamp = (v: number, len: number) => {
    if (len <= size) return 0.5;
    const half = size / 2;
    return Math.min(len - half, Math.max(half, v)) / len;
  };
  return { x: clamp(px, w), y: clamp(py, h) };
}
