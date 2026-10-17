/**
 * The ring gauge beside the health score's hero number: geometry only, pure
 * (`healthRingWords.test.mjs`). The paint (track `currentColor` at low
 * opacity, arc `--accent`, round caps) is the component's.
 *
 * A 270° sweep with the gap at the bottom: it starts bottom-left, runs
 * clockwise over the top and ends bottom-right. The score is out of 100 on a
 * fixed scale, so 0–100 maps straight onto 0–270° — no zones, no fitted range.
 * 0 draws no arc at all (a zero-length arc with round caps would paint a dot
 * that reads as a reading of a few points); 100 is the whole track.
 */

/** Degrees of the sweep; the missing 90° is the gap at the bottom. */
export const RING_SWEEP_DEG = 270;

export interface RingGeom {
  /** The SVG box. `w` is the full diameter plus the stroke; `h` stops under
   *  the two arc ends (the gap at the bottom needs no room). */
  w: number;
  h: number;
  /** The circle's centre inside that box. */
  cx: number;
  cy: number;
  /** The full 270° track, `M…A…`. */
  track: string;
  /** The value's arc from the same start; null at 0 (nothing to draw). */
  arc: string | null;
  /** Where the value's arc ends (for an end mark); null at 0. */
  end: { x: number; y: number } | null;
  /** The value actually drawn, clamped to 0–100. */
  value: number;
}

const f2 = (v: number): string => (Math.round(v * 100) / 100).toString();

/**
 * Arc paths for a ring of radius `r` (to the stroke's centre line) and stroke
 * width `stroke`. `value` is clamped to 0–100. Null for a non-finite value or
 * a radius/stroke that cannot be drawn — the caller then draws no ring, never
 * an empty one standing for a score.
 */
export function ringGeom(value: number, r: number, stroke: number): RingGeom | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (!(r > 0) || !(stroke >= 0) || !Number.isFinite(r) || !Number.isFinite(stroke)) return null;
  const v = Math.max(0, Math.min(100, value));
  const pad = stroke / 2;
  const cx = r + pad;
  const cy = r + pad;
  // θ in degrees clockwise from 12 o'clock; screen y grows downward.
  const at = (deg: number) => {
    const t = (deg * Math.PI) / 180;
    return { x: cx + r * Math.sin(t), y: cy - r * Math.cos(t) };
  };
  const start = -RING_SWEEP_DEG / 2;
  const arcTo = (sweep: number): string => {
    const a = at(start);
    const b = at(start + sweep);
    const large = sweep > 180 ? 1 : 0;
    return `M${f2(a.x)},${f2(a.y)}A${f2(r)},${f2(r)} 0 ${large} 1 ${f2(b.x)},${f2(b.y)}`;
  };
  const sweep = (v / 100) * RING_SWEEP_DEG;
  const endPt = at(start + sweep);
  return {
    w: 2 * cx,
    h: at(RING_SWEEP_DEG / 2).y + pad,
    cx,
    cy,
    track: arcTo(RING_SWEEP_DEG),
    arc: v > 0 ? arcTo(sweep) : null,
    end: v > 0 ? { x: endPt.x, y: endPt.y } : null,
    value: v,
  };
}
