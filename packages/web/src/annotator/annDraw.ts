/**
 * Painting on the annotator's canvas: shapes, the highlighter band, the mosaic, badges, selection chrome and knobs.
 *
 * Moved out of `ImageAnnotator.tsx` (docs/notes/charts-architecture.md); the sheet's behaviour is
 * unchanged and `ImageAnnotator.tsx` composes it.
 *
 * Each painter takes the canvas, the clean image and the view's zoom it needs as arguments instead of
 * reading the component's refs; the drawing code itself is unchanged.
 */

import { turnedBounds } from "../annClip";
import { drawKnobGlyph, KNOB_COLORS, KNOB_R_PX, knobPlaces, type KnobPlace } from "../annKnobs";
import { smallOnScreen, SMALL_PX } from "../annMove";
import { badgeAnchor, baseWidth, clampRect, inkOn, normRect, shapeBBox } from "./annGeom";
import type { AnnRect, Shape } from "./annTypes";

/** What `drawImage` accepts here — the decoded picture. */
type ImageSource = ImageBitmap | HTMLImageElement | HTMLCanvasElement;

/** Darken everything outside the crop selection and outline it. */
export function drawCropOverlay(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement, r: AnnRect | null) {
  if (!r) return;
  const lw = baseWidth(canvas);
  ctx.save();
  ctx.fillStyle = "rgba(0,0,0,.55)";
  ctx.beginPath();
  ctx.rect(0, 0, canvas.width, canvas.height);
  ctx.rect(r.x, r.y, r.w, r.h);
  ctx.fill("evenodd");
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = lw;
  ctx.setLineDash([lw * 2.5, lw * 2.5]);
  ctx.strokeRect(r.x, r.y, r.w, r.h);
  ctx.restore();
}

/** Pixelate (mosaic) a region of the base image over the canvas. Sampling the
    clean image (not the annotated canvas) and rendering it back with smoothing
    off bakes an irreversible mosaic into the flattened PNG — real redaction,
    unlike a CSS/filter blur which can be visually undone. */
function drawMosaic(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement, img: ImageSource | null, s: Shape) {
  if (!img) return;
  // A turned blur must hide what is under the TURNED box, so it is never drawn
  // through a turned canvas (that would paint the upright box's pixels, moved).
  // The upright box around it is pixelated in place and clipped to the turn.
  if (s.angle) {
    const n = normRect(s);
    const cx = n.x + n.w / 2, cy = n.y + n.h / 2;
    ctx.save();
    ctx.beginPath();
    ctx.translate(cx, cy);
    ctx.rotate(s.angle);
    ctx.rect(-n.w / 2, -n.h / 2, n.w, n.h);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clip();
    drawMosaic(ctx, canvas, img, { ...s, angle: 0, ...turnedBounds(s, s.angle) });
    ctx.restore();
    return;
  }
  const { x, y, w, h } = clampRect(canvas, normRect(s));
  if (w < 1 || h < 1) return;
  const block = Math.max(8, Math.round(canvas.width / 48)); // coarser = more private
  const dw = Math.max(1, Math.round(w / block));
  const dh = Math.max(1, Math.round(h / block));
  const off = document.createElement("canvas");
  off.width = dw;
  off.height = dh;
  off.getContext("2d")!.drawImage(img, x, y, w, h, 0, 0, dw, dh);
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(off, 0, 0, dw, dh, x, y, w, h);
  ctx.restore();
}

/**
 * The highlighter: translucent ink MULTIPLIED into the picture.
 *
 * Not a filled rectangle — normal compositing hides the very line the mark
 * exists to point at, and an outline would just be the box tool again. A band
 * thinner than a fingertip is grown to one, because the gesture is a swipe
 * along a line of text and a swipe is never as tall as the text it crosses.
 */
function drawBand(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement, s: Shape) {
  const r = normRect(s);
  const minH = baseWidth(canvas) * 5 * s.factor;
  const h = Math.max(r.h, minH);
  const y = r.h >= minH ? r.y : r.y - (minH - r.h) / 2;
  ctx.save();
  ctx.globalAlpha = 0.38;
  ctx.globalCompositeOperation = "multiply";
  ctx.fillStyle = s.color;
  ctx.fillRect(r.x, y, Math.max(r.w, minH), h);
  ctx.restore();
}

/**
 * The numbers, painted on the image itself.
 *
 * This is the half of `annNote.ts` that lives in pixels: the note says
 * "#2 highlight over …", and unless a 2 is actually visible next to that band
 * the sentence names something the reader cannot find. Drawn from the same
 * deduped list the note numbers (`visibleMarks`), so the two cannot drift, and
 * only from two marks up — a lone badge on a lone circle is decoration.
 */
export function drawBadges(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement, list: Shape[]) {
  if (list.length < 2) return;
  const rad = Math.max(10, baseWidth(canvas) * 3.2);
  list.forEach((s, i) => {
    const a = badgeAnchor(s);
    const x = Math.max(rad + 2, Math.min(canvas.width - rad - 2, a.x - rad * 0.2));
    const y = Math.max(rad + 2, Math.min(canvas.height - rad - 2, a.y - rad * 0.2));
    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, rad, 0, Math.PI * 2);
    ctx.fillStyle = s.tool === "blur" ? "#111" : s.color;
    ctx.fill();
    ctx.lineWidth = Math.max(1, rad * 0.14);
    ctx.strokeStyle = "rgba(0,0,0,.55)";
    ctx.stroke();
    ctx.fillStyle = s.tool === "blur" ? "#fff" : inkOn(s.color);
    ctx.font = `bold ${Math.round(rad * 1.25)}px ui-sans-serif, system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(i + 1), x, y);
    ctx.restore();
  });
  ctx.textAlign = "start";
}

/** A mark turned by knob mode is drawn upright inside a turned canvas, about
 *  its own middle. The blur is the exception — see `drawMosaic`. */
export function drawShape(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement, img: ImageSource | null, s: Shape) {
  if (!s.angle || s.tool === "blur" || s.tool === "arrow" || s.tool === "line") { drawUpright(ctx, canvas, img, s); return; }
  const b = shapeBBox(ctx, canvas, s);
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(s.angle);
  ctx.translate(-cx, -cy);
  drawUpright(ctx, canvas, img, s);
  ctx.restore();
}

function drawUpright(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement, img: ImageSource | null, s: Shape) {
  if (s.tool === "blur") { drawMosaic(ctx, canvas, img, s); return; }
  if (s.tool === "marker") { drawBand(ctx, canvas, s); return; }
  const lw = baseWidth(canvas) * s.factor;
  ctx.strokeStyle = s.color;
  ctx.fillStyle = s.color;
  ctx.lineWidth = lw;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  if (s.tool === "rect") {
    ctx.strokeRect(s.x0, s.y0, s.x1 - s.x0, s.y1 - s.y0);
  } else if (s.tool === "circle") {
    ctx.beginPath();
    ctx.ellipse((s.x0 + s.x1) / 2, (s.y0 + s.y1) / 2, Math.abs(s.x1 - s.x0) / 2, Math.abs(s.y1 - s.y0) / 2, 0, 0, Math.PI * 2);
    ctx.stroke();
  } else if (s.tool === "arrow" || s.tool === "line") {
    const a = Math.atan2(s.y1 - s.y0, s.x1 - s.x0);
    const head = lw * 4;
    ctx.beginPath();
    ctx.moveTo(s.x0, s.y0);
    ctx.lineTo(s.x1, s.y1);
    ctx.stroke();
    if (s.tool === "line") return; // a line is an arrow without the head
    ctx.beginPath();
    ctx.moveTo(s.x1, s.y1);
    ctx.lineTo(s.x1 - head * Math.cos(a - Math.PI / 6), s.y1 - head * Math.sin(a - Math.PI / 6));
    ctx.lineTo(s.x1 - head * Math.cos(a + Math.PI / 6), s.y1 - head * Math.sin(a + Math.PI / 6));
    ctx.closePath();
    ctx.fill();
  } else if (s.tool === "text" && s.text) {
    const fs = Math.max(16, Math.round(canvas.width / 26)) * s.factor;
    ctx.font = `bold ${fs}px ui-sans-serif, system-ui, sans-serif`;
    ctx.textBaseline = "top";
    ctx.lineWidth = Math.max(2, fs / 8);
    ctx.strokeStyle = "rgba(0,0,0,.65)";
    ctx.strokeText(s.text, s.x0, s.y0);
    ctx.fillText(s.text, s.x0, s.y0);
  }
}

/** Selection chrome: dashed box + (unless the mark is too small to grab) the
    two end dots that reshape it directly. Never part of the exported image
    (see `redraw`'s `plain`). */
export function drawSelection(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement, s: Shape, k: number, knobsOn: boolean, tgt: 0 | 1 | null) {
  const b = shapeBBox(ctx, canvas, s);
  const lw = Math.max(1, baseWidth(canvas) * 0.6);
  const small = smallOnScreen(s, k);
  // A small mark's box is grown to at least a fingertip's width on screen so
  // there is visible chrome to see at all — the mark itself may be a handful
  // of pixels.
  const pad = small ? Math.max(lw * 3, SMALL_PX / k / 2) : lw * 3;
  ctx.save();
  if (s.angle && s.tool !== "arrow" && s.tool !== "line") {
    const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    ctx.translate(cx, cy);
    ctx.rotate(s.angle);
    ctx.translate(-cx, -cy);
  }
  ctx.strokeStyle = "#4c9aff";
  ctx.lineWidth = lw;
  ctx.setLineDash([lw * 3, lw * 3]);
  ctx.strokeRect(b.x - pad, b.y - pad, b.w + pad * 2, b.h + pad * 2);
  ctx.setLineDash([]);
  if (knobsOn) {
    ctx.restore();
    drawKnobs(ctx, canvas, s, k);
    return;
  }
  // A turned mark's end dots would sit on corners its points no longer are.
  if (s.angle) { ctx.restore(); return; }
  // Dots that cannot be grabbed are not drawn — a small mark's direct drag
  // always means move (annMove.ts), so a dot here would promise a gesture
  // the finger cannot land on.
  if (s.tool !== "text" && !small) {
    const r = baseWidth(canvas) * 1.8;
      ([[0, s.x0, s.y0], [1, s.x1, s.y1]] as const).forEach(([h, hx, hy]) => {
      ctx.beginPath();
      ctx.arc(hx, hy, r, 0, Math.PI * 2);
      ctx.fillStyle = tgt === h ? "#4c9aff" : "#fff";
      ctx.fill();
      ctx.stroke();
    });
  }
  ctx.restore();
}

/** Where the selected mark's knobs hang right now (annKnobs.ts). */
export function placesFor(canvas: HTMLCanvasElement, s: Shape, k: number): KnobPlace[] {
  return knobPlaces(s, shapeBBox(canvas.getContext("2d")!, canvas, s), k, canvas.width, canvas.height);
}

/** Strings first, then the knobs over them, each with a glyph for what it
 *  does — the knob is only better than a chip if it says which gesture it is. */
function drawKnobs(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement, s: Shape, k: number) {
  const r = KNOB_R_PX / k;
  const places = placesFor(canvas, s, k);
  ctx.save();
  ctx.lineCap = "round";
  for (const p of places) {
    ctx.beginPath();
    ctx.moveTo(p.ax, p.ay);
    ctx.lineTo(p.x, p.y);
    ctx.strokeStyle = "rgba(255,255,255,0.85)";
    ctx.lineWidth = 4 / k;
    ctx.stroke();
    ctx.strokeStyle = "#4c9aff";
    ctx.lineWidth = 2 / k;
    ctx.stroke();
  }
  for (const p of places) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fillStyle = KNOB_COLORS[p.knob];
    ctx.fill();
    ctx.lineWidth = 2 / k;
    ctx.strokeStyle = "#fff";
    ctx.stroke();
    drawKnobGlyph(ctx, p.knob, p.x, p.y, r * 0.5, 2 / k);
  }
  ctx.restore();
}
