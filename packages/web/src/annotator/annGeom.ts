/**
 * Pure geometry over marks and the canvas: rects, distances, bounding boxes, hit tests, badge anchors.
 *
 * Moved out of `ImageAnnotator.tsx` (docs/notes/charts-architecture.md); the sheet's behaviour is
 * unchanged and `ImageAnnotator.tsx` composes it.
 */

import type { AnnRect, Shape } from "./annTypes";

export function baseWidth(canvas: HTMLCanvasElement): number {
  return Math.max(4, Math.round(canvas.width / 220));
}

/** x0/y0/x1/y1 (any direction) → positive {x,y,w,h}. */
export function normRect(r: { x0: number; y0: number; x1: number; y1: number }) {
  return { x: Math.min(r.x0, r.x1), y: Math.min(r.y0, r.y1), w: Math.abs(r.x1 - r.x0), h: Math.abs(r.y1 - r.y0) };
}

/** Clamp a selection to the image bounds. A drag can begin or end past the
    canvas edge (the gesture is the wrapper's, and the pointer is unclamped
    anyway when zoomed), and WebKit throws IndexSizeError on a drawImage source
    rect that overshoots the image — Chrome only clips.

    BOTH edges are clamped, never the origin alone: a rect starting left of the
    image kept its width, so clamping x to 0 pushed its right edge further
    right than it was drawn — a crop that grew as it was dragged off. */
export function clampRect(canvas: HTMLCanvasElement | null, r: AnnRect): AnnRect {
  if (!canvas) return r;
  const cx = (v: number) => Math.max(0, Math.min(v, canvas.width));
  const cy = (v: number) => Math.max(0, Math.min(v, canvas.height));
  const x = cx(r.x), y = cy(r.y);
  return { x, y, w: cx(r.x + r.w) - x, h: cy(r.y + r.h) - y };
}

/** Black text on a light mark, white on a dark one — the badge is drawn in the
 *  mark's own colour, and five of them are nowhere near the same luminance. */
export function inkOn(color: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(color.trim());
  if (!m) return "#fff";
  const n = parseInt(m[1], 16);
  const lum = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return lum > 0.6 ? "#111" : "#fff";
}

/** Where a mark's number sits: the end you drew FROM for a stroke, the top-left
 *  corner for anything with an area. */
export function badgeAnchor(s: Shape): { x: number; y: number } {
  if (s.tool === "text" || s.tool === "arrow" || s.tool === "line") return { x: s.x0, y: s.y0 };
  const r = normRect(s);
  if (!s.angle) return { x: r.x, y: r.y };
  // The turned top-left corner, so the number stays on the mark it names.
  const cx = r.x + r.w / 2, cy = r.y + r.h / 2, c = Math.cos(s.angle), sn = Math.sin(s.angle);
  return { x: cx + (-r.w / 2) * c - (-r.h / 2) * sn, y: cy + (-r.w / 2) * sn + (-r.h / 2) * c };
}

/** Bounding box of a mark in canvas px. Text has no geometry of its own — it
    is measured with the same font `drawShape` renders it with. */
export function shapeBBox(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement, s: Shape) {
  if (s.tool === "text") {
    const fs = Math.max(16, Math.round(canvas.width / 26)) * s.factor;
    ctx.save();
    ctx.font = `bold ${fs}px ui-sans-serif, system-ui, sans-serif`;
    const w = ctx.measureText(s.text || "").width;
    ctx.restore();
    return { x: s.x0, y: s.y0, w, h: fs * 1.2 };
  }
  return normRect(s);
}

/** Distance from a point to the segment (x0,y0)-(x1,y1). */
export function segDist(px: number, py: number, x0: number, y0: number, x1: number, y1: number): number {
  const dx = x1 - x0, dy = y1 - y0;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((px - x0) * dx + (py - y0) * dy) / len2)) : 0;
  return Math.hypot(px - (x0 + t * dx), py - (y0 + t * dy));
}

/** Is this point on that mark? A stroke is hit near its LINE (a long arrow's
    bounding box is mostly empty space); everything else anywhere inside. */
export function hitShapeOn(canvas: HTMLCanvasElement | null, s: Shape, x: number, y: number, tol: number): boolean {
  if (!canvas) return false;
  if (s.tool === "arrow" || s.tool === "line") return segDist(x, y, s.x0, s.y0, s.x1, s.y1) <= tol;
  const b = shapeBBox(canvas.getContext("2d")!, canvas, s);
  if (s.angle) {
    // Into the mark's own upright frame, then the same box test.
    const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    const c = Math.cos(-s.angle), sn = Math.sin(-s.angle);
    const lx = cx + (x - cx) * c - (y - cy) * sn, ly = cy + (x - cx) * sn + (y - cy) * c;
    x = lx; y = ly;
  }
  return x >= b.x - tol && x <= b.x + b.w + tol && y >= b.y - tol && y <= b.y + b.h + tol;
}
