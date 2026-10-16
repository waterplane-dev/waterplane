/**
 * Where the desktop is on the phone's screen: fit, pinch zoom and pan, the visible part of the
 * source (what "Crop to view" asks the host to stream), and the one mapping from a point on the
 * phone to a normalised source coordinate. Pure, so `view.test.mjs` pins every case.
 *
 * The model is in SOURCE UNITS: x runs 0..1 across the source's width and y runs 0..`aspect`
 * down its height (`aspect` = height / width), so one unit is the same length both ways. A view is
 * a zoom (`zoom` 1 = the source's width fills the box) and the source point drawn at the box's
 * top-left. The picture the host sends covers a REGION of the source (all of it, or the crop it
 * was asked for); where that picture is drawn follows from the view, so a crop arriving late
 * never moves what a tap lands on — the mapping does not depend on the crop at all.
 */
import type { NormRect } from "../shared/wire.mts";

export interface Box { w: number; h: number }
export interface Pt { x: number; y: number }

export interface View {
  /** Phone px per source unit is `box.w * zoom`. */
  zoom: number;
  /** The source point (in source units) at the box's top-left. */
  ox: number;
  oy: number;
}

export const MAX_ZOOM = 8;
/** The whole source as a region. */
export const FULL: NormRect = { x: 0, y: 0, w: 1, h: 1 };

/** Phone px per source unit. */
export const scaleOf = (box: Box, v: View): number => box.w * v.zoom;

/** The smallest zoom: the whole source fits the box both ways (never above 1 = fit width). */
export function minZoom(box: Box, aspect: number): number {
  if (box.w <= 0 || box.h <= 0 || aspect <= 0) return 1;
  return Math.min(1, box.h / (aspect * box.w));
}

/** Keep the view inside the source: an axis smaller than the box is centred, a larger one may not
 *  show past its edge. Zoom is clamped first. */
export function clampView(box: Box, aspect: number, v: View): View {
  const zoom = Math.min(MAX_ZOOM, Math.max(minZoom(box, aspect), v.zoom));
  const s = box.w * zoom;
  const visW = box.w / s, visH = box.h / s;
  const ax = (len: number, vis: number, o: number) => (len <= vis ? -(vis - len) / 2 : Math.min(len - vis, Math.max(0, o)));
  return { zoom, ox: ax(1, visW, v.ox), oy: ax(aspect, visH, v.oy) };
}

/** Fit width, top of the source at the top of the box (centred when the source is shorter). */
export function fitWidth(box: Box, aspect: number): View {
  return clampView(box, aspect, { zoom: 1, ox: 0, oy: 0 });
}

/** A phone point → normalised source (0..1 both ways), clamped onto the source. */
export function screenToSource(box: Box, aspect: number, v: View, p: Pt): Pt {
  const s = scaleOf(box, v);
  const ux = v.ox + p.x / s, uy = v.oy + p.y / s;
  const c = (n: number) => Math.min(1, Math.max(0, n));
  return { x: c(ux), y: c(aspect > 0 ? uy / aspect : 0) };
}

/** Normalised source → phone point (the trackpad cursor's dot). */
export function sourceToScreen(box: Box, aspect: number, v: View, n: Pt): Pt {
  const s = scaleOf(box, v);
  return { x: (n.x - v.ox) * s, y: (n.y * aspect - v.oy) * s };
}

/** Whether a phone point lands on the source at all (not the letterbox around it). */
export function onSource(box: Box, aspect: number, v: View, p: Pt): boolean {
  const s = scaleOf(box, v);
  const ux = v.ox + p.x / s, uy = v.oy + p.y / s;
  return ux >= 0 && ux <= 1 && uy >= 0 && uy <= aspect;
}

/** Where to draw a picture that covers `region` of the source: phone px, for the canvas's CSS box. */
export function regionRect(box: Box, aspect: number, v: View, region: NormRect): { left: number; top: number; width: number; height: number } {
  const s = scaleOf(box, v);
  return { left: (region.x - v.ox) * s, top: (region.y * aspect - v.oy) * s, width: region.w * s, height: region.h * aspect * s };
}

/** Zoom by `factor` about the phone point `at` (it stays under the fingers), then pan by `pan`. */
export function zoomAt(box: Box, aspect: number, v: View, factor: number, at: Pt, pan: Pt = { x: 0, y: 0 }): View {
  const s0 = scaleOf(box, v);
  const ux = v.ox + at.x / s0, uy = v.oy + at.y / s0;
  const zoom = Math.min(MAX_ZOOM, Math.max(minZoom(box, aspect), v.zoom * factor));
  const s1 = box.w * zoom;
  return clampView(box, aspect, { zoom, ox: ux - (at.x + pan.x) / s1, oy: uy - (at.y + pan.y) / s1 });
}

/** Drag the picture by `d` phone px (content follows the finger). */
export function panBy(box: Box, aspect: number, v: View, d: Pt): View {
  const s = scaleOf(box, v);
  return clampView(box, aspect, { ...v, ox: v.ox - d.x / s, oy: v.oy - d.y / s });
}

/** The part of the source on screen, normalised. Null when that is all of it (nothing to crop). */
export function visibleRect(box: Box, aspect: number, v: View): NormRect | null {
  if (aspect <= 0) return null;
  const s = scaleOf(box, v);
  const x0 = Math.max(0, v.ox), x1 = Math.min(1, v.ox + box.w / s);
  const y0 = Math.max(0, v.oy / aspect), y1 = Math.min(1, (v.oy + box.h / s) / aspect);
  const r = { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
  // Within half a percent of the whole is the whole: a crop that trims a rounding error re-aims the
  // capture for nothing.
  if (r.x <= 0.005 && r.y <= 0.005 && r.w >= 0.995 - r.x && r.h >= 0.995 - r.y) return null;
  const round = (n: number) => Math.round(n * 10000) / 10000;
  return { x: round(r.x), y: round(r.y), w: round(r.w), h: round(r.h) };
}

/** Two crops close enough that re-aiming the capture is not worth a keyframe. */
export function sameCrop(a: NormRect | null | undefined, b: NormRect | null | undefined): boolean {
  if (!a || !b) return !a && !b;
  const e = 0.002;
  return Math.abs(a.x - b.x) < e && Math.abs(a.y - b.y) < e && Math.abs(a.w - b.w) < e && Math.abs(a.h - b.h) < e;
}

/**
 * Which region of the source the frames now ARRIVING cover. The host's status names the region the
 * helper is encoding (`DesktopStatus.crop`), and the helper writes that status immediately before
 * the first frame of a new region, on the one ordered socket. So the rule is: remember the newest
 * name, and let it take effect at the next KEY — the picture only changes meaning at a key. Never
 * "the next key after I asked for a crop": a key the core asked for itself, or one the encoder made
 * before the helper applied the config, would be placed at the new region while it still shows the old.
 */
export interface RegionTrack {
  /** The region the frames arriving now cover (the tag a frame is drawn with). */
  arriving: NormRect;
  /** The newest region a status named, waiting for its key; null when there is nothing waiting. */
  named: NormRect | null;
}

/** A stream just opened: the first frames cover what was asked for until a status says otherwise. */
export const regionStart = (asked: NormRect | null | undefined): RegionTrack => ({ arriving: asked ?? FULL, named: null });

/** A status arrived. A region equal (within `sameCrop`) to the arriving one waits for nothing, and
 *  keeps the arriving object, which is the player's tag. A status that names none changes nothing. */
export function regionOnStatus(t: RegionTrack, crop: NormRect | null | undefined): RegionTrack {
  if (!crop) return t;
  return sameCrop(crop, t.arriving) ? (t.named ? { arriving: t.arriving, named: null } : t) : { arriving: t.arriving, named: crop };
}

/** A frame arrived: only a key moves the arriving region to the named one. */
export function regionOnFrame(t: RegionTrack, key: boolean): RegionTrack {
  return key && t.named ? { arriving: t.named, named: null } : t;
}

/** Pan just enough that the phone point `p` sits `margin` px inside the box (the trackpad cursor
 *  walking off the edge of a zoomed view drags the view along). */
export function keepInView(box: Box, aspect: number, v: View, p: Pt, margin = 24): View {
  const m = Math.min(margin, box.w / 4, box.h / 4);
  let dx = 0, dy = 0;
  if (p.x < m) dx = m - p.x; else if (p.x > box.w - m) dx = box.w - m - p.x;
  if (p.y < m) dy = m - p.y; else if (p.y > box.h - m) dy = box.h - m - p.y;
  return dx || dy ? panBy(box, aspect, v, { x: dx, y: dy }) : v;
}

/** The source's aspect (height / width): the host's own size when it said, else what the picture
 *  and its region imply, else 16:9 until anything is known. */
export function aspectOf(src: { srcWidth?: number; srcHeight?: number } | null, pic: { w: number; h: number } | null, region: NormRect): number {
  if (src?.srcWidth && src.srcHeight) return src.srcHeight / src.srcWidth;
  if (pic && pic.w > 0 && pic.h > 0 && region.w > 0 && region.h > 0) return (pic.h / region.h) / (pic.w / region.w);
  return 9 / 16;
}

// ── the overview (minimap) and the mouse's pan ──────────────────────────────
//
// A zoomed view on a desktop browser had no way to the hidden part: the phone's three-finger pan
// needs fingers, and every plain mouse press is a click on the desktop. The overview is the whole
// source in a corner with the visible part drawn on it — drag the rectangle, or press anywhere on it
// to centre there — and the middle button drags the picture. Neither sends anything to the desktop.

/** The overview's longest side, phone px. */
export const OVERVIEW_MAX = 160;
/** At most this share of the box either way, so the map never hides what it maps. */
export const OVERVIEW_SHARE = 0.32;

/** The overview's size for this box and source, or null when the box is too small to spare one. */
export function overviewSize(box: Box, aspect: number): Box | null {
  if (box.w <= 0 || box.h <= 0 || aspect <= 0) return null;
  let w = Math.min(OVERVIEW_MAX, box.w * OVERVIEW_SHARE);
  let h = w * aspect;
  const maxH = Math.min(OVERVIEW_MAX, box.h * OVERVIEW_SHARE);
  if (h > maxH) { h = maxH; w = h / aspect; }
  if (w < 40 || h < 24) return null;
  return { w: Math.round(w), h: Math.round(h) };
}

/** The visible part of the source as a rectangle on the overview (its px), clipped to the source. */
export function overviewRect(box: Box, aspect: number, v: View, map: Box): { left: number; top: number; width: number; height: number } {
  const s = scaleOf(box, v);
  if (s <= 0 || aspect <= 0) return { left: 0, top: 0, width: map.w, height: map.h };
  const x0 = Math.max(0, v.ox), x1 = Math.min(1, v.ox + box.w / s);
  const y0 = Math.max(0, v.oy / aspect), y1 = Math.min(1, (v.oy + box.h / s) / aspect);
  return { left: x0 * map.w, top: y0 * map.h, width: Math.max(0, x1 - x0) * map.w, height: Math.max(0, y1 - y0) * map.h };
}

/** A point on the overview (its px) → normalised source, clamped onto it. */
export function overviewPoint(map: Box, p: Pt): Pt {
  const c = (n: number) => Math.min(1, Math.max(0, n));
  return { x: map.w > 0 ? c(p.x / map.w) : 0, y: map.h > 0 ? c(p.y / map.h) : 0 };
}

/** The centre of what is on screen, normalised. */
function viewCentre(box: Box, aspect: number, v: View): Pt {
  const s = scaleOf(box, v) || 1;
  return { x: v.ox + box.w / s / 2, y: aspect > 0 ? (v.oy + box.h / s / 2) / aspect : 0 };
}

/** The same zoom, moved so the normalised source point `n` sits in the middle of the box (clamped). */
export function centreOn(box: Box, aspect: number, v: View, n: Pt): View {
  const s = scaleOf(box, v) || 1;
  return clampView(box, aspect, { ...v, ox: n.x - box.w / s / 2, oy: n.y * aspect - box.h / s / 2 });
}

/** A press on the overview at `n` (normalised): inside the visible rectangle it grabs it where it was
 *  pressed (the offset from its centre, so it does not jump); outside it, the view will centre there. */
export function overviewGrab(box: Box, aspect: number, v: View, n: Pt, map: Box): Pt {
  const r = overviewRect(box, aspect, v, map);
  const px = { x: n.x * map.w, y: n.y * map.h };
  const inside = px.x >= r.left && px.x <= r.left + r.width && px.y >= r.top && px.y <= r.top + r.height;
  if (!inside) return { x: 0, y: 0 };
  const c = viewCentre(box, aspect, v);
  return { x: n.x - c.x, y: n.y - c.y };
}

/** The pointer on the overview is at `n` with `grab` held: the view that puts the grabbed point under it. */
export function overviewDrag(box: Box, aspect: number, v: View, n: Pt, grab: Pt): View {
  return centreOn(box, aspect, v, { x: n.x - grab.x, y: n.y - grab.y });
}

/** The middle mouse button: it pans the picture and is never sent to the desktop as a click. */
export const isPanButton = (e: { pointerType: string; button: number }): boolean => e.pointerType === "mouse" && e.button === 1;
