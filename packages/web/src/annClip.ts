/**
 * Where a mark ENDS UP when it was drawn from outside the picture.
 *
 * A thumb starting a box exactly on the edge of a phone-sized image is a tap on
 * the edge, not a drag from it: the first pixel of the gesture is already inside
 * whatever it was meant to enclose, and the usual repair is undo-and-try-again.
 * So the annotator takes the gesture on the WRAPPER — the letterboxed area
 * around the canvas — and a drag may begin (and end) off the image entirely.
 *
 * What is drawn past the edge is then not part of the picture: the canvas clips
 * it away, and the sentence `annNote.ts` writes would be the only place it
 * survived — as percentages of an image those pixels are not in. That is the
 * part the agent pays for and cannot act on, so it is cut here, once, before the
 * mark is committed.
 *
 * Pure and node-tested (`annClip.test.mjs`) because every rule below is a claim
 * about what somebody meant to draw:
 *
 * - **A box is clipped to the image.** Its visible part does not change (the
 *   canvas already clipped it); what changes is that the cut edge now has a
 *   stroke on it, which is the honest drawing of "this runs to the border".
 * - **An ellipse is NOT clipped, only dropped.** Shrinking the box shrinks the
 *   arc, so clipping a circle would redraw the curve the moment the finger
 *   lifted — a mark that moves on release is worse than one that overhangs.
 * - **A segment keeps its direction.** Clipped to the image rect along its own
 *   line (Liang–Barsky), so an arrow drawn in from off the picture still points
 *   where it was aimed, with its tail on the border.
 * - **A label is moved, never dropped.** It carries typed words, and those are
 *   the one thing on this screen that nothing else holds a copy of.
 */
import { clamp } from "./format.ts";
import type { Mark } from "./annNote";

/** Tools whose geometry is a box, and whose visible part a clip cannot change. */
const BOX_TOOLS = new Set(["rect", "blur", "marker"]);

/** Held inside [0, hi] — `format.clamp` with the floor fixed (identical for any hi >= 0, i.e. a canvas size). */
const clampTo = (v: number, hi: number) => clamp(v, 0, hi);

/** Does any part of the mark's bounding box land on the image? */
export function touchesImage(m: Pick<Mark, "x0" | "y0" | "x1" | "y1">, w: number, h: number): boolean {
  return (
    Math.max(m.x0, m.x1) > 0 && Math.min(m.x0, m.x1) < w &&
    Math.max(m.y0, m.y1) > 0 && Math.min(m.y0, m.y1) < h
  );
}

/** The upright box around a box-like mark turned `a` radians about its middle. */
export function turnedBounds(m: Pick<Mark, "x0" | "y0" | "x1" | "y1">, a: number): { x0: number; y0: number; x1: number; y1: number } {
  const cx = (m.x0 + m.x1) / 2, cy = (m.y0 + m.y1) / 2;
  const hw = Math.abs(m.x1 - m.x0) / 2, hh = Math.abs(m.y1 - m.y0) / 2;
  const ex = Math.abs(hw * Math.cos(a)) + Math.abs(hh * Math.sin(a));
  const ey = Math.abs(hw * Math.sin(a)) + Math.abs(hh * Math.cos(a));
  return { x0: cx - ex, y0: cy - ey, x1: cx + ex, y1: cy + ey };
}

/**
 * Clip a segment to the rect along its own line. Returns null when the line
 * misses the image — which a bounding-box test does not catch: a stroke across
 * the corner of the screen can have a box that overlaps and a line that never
 * does.
 */
export function clipSegment(
  s: { x0: number; y0: number; x1: number; y1: number },
  w: number,
  h: number,
): { x0: number; y0: number; x1: number; y1: number } | null {
  const dx = s.x1 - s.x0, dy = s.y1 - s.y0;
  let t0 = 0, t1 = 1;
  const edges: Array<[number, number]> = [
    [-dx, s.x0 - 0], [dx, w - s.x0],
    [-dy, s.y0 - 0], [dy, h - s.y0],
  ];
  for (const [p, q] of edges) {
    if (p === 0) {
      if (q < 0) return null; // parallel to this edge and outside it
      continue;
    }
    const r = q / p;
    if (p < 0) {
      if (r > t1) return null;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return null;
      if (r < t1) t1 = r;
    }
  }
  return {
    x0: s.x0 + t0 * dx, y0: s.y0 + t0 * dy,
    x1: s.x0 + t1 * dx, y1: s.y0 + t1 * dy,
  };
}

/**
 * The mark as it will be sent, or null when nothing of it is on the image.
 * Null is a mark that was never inside the picture — dropping it is what the
 * canvas already did to every pixel of it.
 */
export function clipMark<T extends Mark>(m: T, w: number, h: number): T | null {
  if (!(w > 0 && h > 0)) return m;
  if (m.tool === "text") {
    const x = clampTo(m.x0, w), y = clampTo(m.y0, h);
    return { ...m, x0: x, y0: y, x1: x, y1: y };
  }
  if (m.tool === "line" || m.tool === "arrow") {
    const c = clipSegment(m, w, h);
    return c ? { ...m, ...c } : null;
  }
  // A turned mark is kept whole or not at all, like the ellipse: clamping its
  // unturned corners would cut a different shape from the one on screen.
  if (m.angle) return touchesImage(turnedBounds(m, m.angle), w, h) ? m : null;
  if (!touchesImage(m, w, h)) return null;
  if (!BOX_TOOLS.has(m.tool)) return m; // circle: kept as drawn
  return { ...m, x0: clampTo(m.x0, w), y0: clampTo(m.y0, h), x1: clampTo(m.x1, w), y1: clampTo(m.y1, h) };
}
