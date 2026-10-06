/**
 * Knob mode — the OPT-IN alternative to relative drag for moving or reshaping a
 * placed mark (`waterplane.annKnobs`, a toggle in the annotator's move row).
 *
 * `annMove.ts` argues against a floating handle, and relative drag stays the
 * default. Knobs are the other honest answer to the same occlusion problem,
 * carried over from child-paint where they were built for a four-year-old: every
 * knob hangs off the mark on a short STRING, so the finger is on the knob and the
 * mark stays in view above it. Some people would rather grab a thing than drive
 * it from elsewhere, and a knob also says which gesture it is (move · size ·
 * turn) where the chip row has to be read first.
 *
 * Sized for an adult: a 36 px knob with a 48 px catch, not child-paint's 12 mm.
 * Everything here is in CANVAS px, converted from screen px by the view's zoom
 * `k`, so a knob is the same size on screen at any zoom.
 *
 * What each mark gets:
 *   - arrow / line: move · size (length, both ends, direction kept) · turn (the
 *     two points swing round their middle — a segment needs no angle of its own)
 *   - box / ellipse / blur: move · size (the lower-right corner, the opposite
 *     one held) · turn (`Mark.angle`, about the middle)
 *   - text:         move · turn (its size is the stroke setting, not a gesture)
 *   - marker band:  move · size — never turned: the host reads the words under
 *     the band as an upright strip, and a turned band would read the wrong ones
 *
 * Every knob works off the finger's TOTAL movement since the drag began,
 * applied to the mark as it was then — the same `base + delta` the move mode
 * already uses — so a knob pulled back onto the picture at an edge, or swung
 * round to clear another knob, still moves the mark exactly as far as the finger
 * moved. What a knob drag commits to is `settleMove`'s, unchanged.
 *
 * Pure and node-tested (`annKnobs.test.mjs`), apart from `drawKnobGlyph`.
 */
import type { Mark } from "./annNote";

export type Knob = "move" | "size" | "turn";

/** Knob radius on screen, CSS px — 36 px across. */
export const KNOB_R_PX = 18;
/** How near a finger must land, CSS px — the 48 px touch target. */
export const KNOB_REACH_PX = 24;
/** Length of the string between the mark and its knob, CSS px. */
export const STRING_PX = 26;
/** Nothing is sized smaller than this on screen, or there is nothing left to see. */
export const MIN_SPAN_PX = 16;

export interface Box { x: number; y: number; w: number; h: number }
export interface KnobPlace { knob: Knob; ax: number; ay: number; x: number; y: number }

type Pt = { x: number; y: number };

const isSegment = (tool: string) => tool === "arrow" || tool === "line" || tool === "marker";

/** Which knobs a mark gets — see the table above. */
export function knobsFor(tool: string): Knob[] {
  if (tool === "text") return ["move", "turn"];
  if (tool === "marker") return ["move", "size"];
  return ["move", "size", "turn"];
}

/**
 * Where each of the mark's knobs hangs: `ax/ay` is where its string is tied to
 * the mark, `x/y` the knob's centre. `box` is the mark's on-canvas bounding box
 * (the caller measures it — text needs a font), `k` screen px per canvas px,
 * `cw/ch` the picture's size: a knob is drawn ON the canvas, so one that would
 * fall off it is pulled back on, and one that lands on another knob is swung
 * round the mark until it is clear.
 */
export function knobPlaces(m: Mark, box: Box, k: number, cw: number, ch: number): KnobPlace[] {
  const r = KNOB_R_PX / k;
  const L = STRING_PX / k;
  const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
  // `box` is the mark UNturned; a turned mark's knobs ride round with it.
  const a = isSegment(m.tool) ? 0 : m.angle ?? 0;
  const turn = (x: number, y: number): Pt => rotate({ x, y }, { x: cx, y: cy }, a);
  const raw: KnobPlace[] = [];
  for (const knob of knobsFor(m.tool)) {
    if (knob === "move") {
      // Straight down, whatever the mark or its angle — "below it" needs no
      // working out. Above instead when there is no room under it.
      const ey = Math.abs(box.w / 2 * Math.sin(a)) + Math.abs(box.h / 2 * Math.cos(a));
      const bottom = cy + ey, top = cy - ey;
      const below = bottom + L + r;
      raw.push(below + r <= ch
        ? { knob, ax: cx, ay: bottom, x: cx, y: below }
        : { knob, ax: cx, ay: top, x: cx, y: top - L - r });
    } else if (knob === "size") {
      if (isSegment(m.tool)) {
        // Off the head end, along the mark's own line.
        const u = unit(m.x1 - m.x0, m.y1 - m.y0);
        raw.push({ knob, ax: m.x1, ay: m.y1, x: m.x1 + u.x * (L + r), y: m.y1 + u.y * (L + r) });
      } else {
        const d = (L + r) * Math.SQRT1_2;
        const at = turn(box.x + box.w, box.y + box.h);
        const to = turn(box.x + box.w + d, box.y + box.h + d);
        raw.push({ knob, ax: at.x, ay: at.y, x: to.x, y: to.y });
      }
    } else if (!isSegment(m.tool)) {
      // Straight up off the top edge, turning with the mark — which way is up
      // is the one thing a turned mark has to show.
      const at = turn(cx, box.y);
      const to = turn(cx, box.y - L - r);
      raw.push({ knob, ax: at.x, ay: at.y, x: to.x, y: to.y });
    } else {
      // Square off the middle of the line, on its upper side, so it reads as
      // "the lever you swing this by".
      const u = unit(m.x1 - m.x0, m.y1 - m.y0);
      let px = -u.y, py = u.x;
      if (py > 0 || (py === 0 && px > 0)) { px = -px; py = -py; }
      const mx = (m.x0 + m.x1) / 2, my = (m.y0 + m.y1) / 2;
      raw.push({ knob, ax: mx, ay: my, x: mx + px * (L + r), y: my + py * (L + r) });
    }
  }
  const clamp = (p: Pt): Pt => ({
    x: Math.min(Math.max(p.x, r), Math.max(r, cw - r)),
    y: Math.min(Math.max(p.y, r), Math.max(r, ch - r)),
  });
  const placed: KnobPlace[] = [];
  for (const p of raw) {
    const clear = (q: Pt) => placed.every((o) => Math.hypot(o.x - q.x, o.y - q.y) >= r * 2.2);
    let best = clamp(p);
    if (!clear(best)) {
      search: for (let step = 1; step <= 12; step++) {
        for (const sign of [1, -1]) {
          const q = clamp(rotate(p, { x: cx, y: cy }, (sign * step * 20 * Math.PI) / 180));
          if (clear(q)) { best = q; break search; }
        }
      }
    }
    placed.push({ ...p, x: best.x, y: best.y });
  }
  return placed;
}

/** The knob under the finger, nearest first, or null. */
export function knobAt(places: KnobPlace[], x: number, y: number, k: number): Knob | null {
  const reach = KNOB_REACH_PX / k;
  let best: KnobPlace | null = null;
  let bestD = Infinity;
  for (const p of places) {
    const d = Math.hypot(p.x - x, p.y - y);
    if (d <= reach && d < bestD) { best = p; bestD = d; }
  }
  return best?.knob ?? null;
}

/**
 * The mark after dragging `knob` from `from` to `to` (canvas px), computed from
 * `base` — the mark as it was when the drag began. `k` only sets the minimum
 * size, which is a size on screen. `center` is what a turn swings about, and is
 * only needed for text, whose two points are its corner rather than its middle.
 */
export function applyKnob<T extends Mark>(knob: Knob, base: T, from: Pt, to: Pt, k: number, center?: Pt): T {
  const dx = to.x - from.x, dy = to.y - from.y;
  const min = MIN_SPAN_PX / k;
  if (knob === "move") {
    return { ...base, x0: base.x0 + dx, y0: base.y0 + dy, x1: base.x1 + dx, y1: base.y1 + dy };
  }
  const cx = center?.x ?? (base.x0 + base.x1) / 2, cy = center?.y ?? (base.y0 + base.y1) / 2;
  if (knob === "turn") {
    // Too near the middle and a twitch is a half-turn: hold still instead.
    if (Math.hypot(from.x - cx, from.y - cy) < min || Math.hypot(to.x - cx, to.y - cy) < min) return base;
    const a = Math.atan2(to.y - cy, to.x - cx) - Math.atan2(from.y - cy, from.x - cx);
    // A mark with an area keeps its points and gains an angle; a segment has
    // no inside to turn, so its two points swing instead.
    if (!isSegment(base.tool)) return { ...base, angle: normAngle((base.angle ?? 0) + a) };
    const p0 = rotate({ x: base.x0, y: base.y0 }, { x: cx, y: cy }, a);
    const p1 = rotate({ x: base.x1, y: base.y1 }, { x: cx, y: cy }, a);
    return { ...base, x0: p0.x, y0: p0.y, x1: p1.x, y1: p1.y };
  }
  if (isSegment(base.tool)) {
    // Longer or shorter about the middle, direction kept: the head end follows
    // the finger's movement along the line, the tail mirrors it.
    const u = unit(base.x1 - base.x0, base.y1 - base.y0);
    const half = Math.max(min / 2, Math.hypot(base.x1 - base.x0, base.y1 - base.y0) / 2 + dx * u.x + dy * u.y);
    return { ...base, x0: cx - u.x * half, y0: cy - u.y * half, x1: cx + u.x * half, y1: cy + u.y * half };
  }
  // A box-like mark: its own lower-right corner follows the finger and the
  // opposite corner stays put ON SCREEN — for a turned mark that means working
  // in the mark's frame and then sliding its middle so the held corner has not
  // moved. Normalised first, so the corner a mark was drawn from does not
  // decide which one this knob holds.
  const a = base.angle ?? 0;
  const local = rotate({ x: dx, y: dy }, { x: 0, y: 0 }, -a);
  const w = Math.abs(base.x1 - base.x0), h = Math.abs(base.y1 - base.y0);
  const w2 = Math.max(min, w + local.x), h2 = Math.max(min, h + local.y);
  const held = rotate({ x: cx - w / 2, y: cy - h / 2 }, { x: cx, y: cy }, a);
  const half = rotate({ x: w2 / 2, y: h2 / 2 }, { x: 0, y: 0 }, a);
  const mid = { x: held.x + half.x, y: held.y + half.y };
  return { ...base, x0: mid.x - w2 / 2, y0: mid.y - h2 / 2, x1: mid.x + w2 / 2, y1: mid.y + h2 / 2 };
}

/** Into (-π, π], so a mark turned round and round does not carry a growing number. */
function normAngle(a: number): number {
  const t = a % (Math.PI * 2);
  return t > Math.PI ? t - Math.PI * 2 : t <= -Math.PI ? t + Math.PI * 2 : t;
}

function unit(dx: number, dy: number): Pt {
  const len = Math.hypot(dx, dy);
  return len > 1e-6 ? { x: dx / len, y: dy / len } : { x: 1, y: 0 };
}

function rotate(p: Pt, c: Pt, a: number): Pt {
  const cos = Math.cos(a), sin = Math.sin(a);
  const dx = p.x - c.x, dy = p.y - c.y;
  return { x: c.x + dx * cos - dy * sin, y: c.y + dx * sin + dy * cos };
}

/** One colour per knob, the same three child-paint uses, so a knob is told
 *  apart before its glyph is read. */
export const KNOB_COLORS: Record<Knob, string> = { move: "#2f80ed", size: "#f2994a", turn: "#27ae60" };

/** The hint line in knob mode, naming exactly the knobs this mark wears. */
export function knobHint(tool: string): string {
  const say: Record<Knob, string> = {
    move: "blue moves",
    size: isSegment(tool) ? "orange sets the length" : "orange sizes",
    turn: "green turns",
  };
  const parts = knobsFor(tool).map((k) => say[k]);
  return parts[0][0].toUpperCase() + parts.join(" · ").slice(1);
}

/**
 * The white line glyph inside a knob: four-way arrows, a corner-to-corner double
 * arrow, or a circular arrow. Drawn rather than an icon font because it is on the
 * canvas and must scale with the zoom like the knob does. The one function here
 * that touches a canvas; it is never called by the tests.
 */
export function drawKnobGlyph(ctx: CanvasRenderingContext2D, knob: Knob, x: number, y: number, s: number, lw: number): void {
  ctx.save();
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = lw;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  const h = s * 0.35;
  ctx.beginPath();
  if (knob === "move") {
    ctx.moveTo(x - s, y); ctx.lineTo(x + s, y);
    ctx.moveTo(x, y - s); ctx.lineTo(x, y + s);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const tx = x + dx * s, ty = y + dy * s;
      ctx.moveTo(tx - dx * h + dy * h, ty - dy * h + dx * h);
      ctx.lineTo(tx, ty);
      ctx.lineTo(tx - dx * h - dy * h, ty - dy * h - dx * h);
    }
  } else if (knob === "size") {
    const d = s * 0.75;
    ctx.moveTo(x - d, y - d); ctx.lineTo(x + d, y + d);
    ctx.moveTo(x - d + h * 1.4, y - d); ctx.lineTo(x - d, y - d); ctx.lineTo(x - d, y - d + h * 1.4);
    ctx.moveTo(x + d - h * 1.4, y + d); ctx.lineTo(x + d, y + d); ctx.lineTo(x + d, y + d - h * 1.4);
  } else {
    const a0 = -Math.PI * 0.25;
    ctx.arc(x, y, s * 0.8, a0, Math.PI * 1.45);
    const ex = x + Math.cos(a0) * s * 0.8, ey = y + Math.sin(a0) * s * 0.8;
    ctx.moveTo(ex - h * 1.2, ey - h * 0.2); ctx.lineTo(ex, ey); ctx.lineTo(ex + h * 0.1, ey - h * 1.2);
  }
  ctx.stroke();
  ctx.restore();
}
