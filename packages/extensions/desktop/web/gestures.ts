/**
 * Fingers on the phone → what the desktop is sent, and what the view does. A small state machine
 * fed with pointer events (and a clock tick, for the long press), returning what to do — so
 * `gestures.test.mjs` drives every gesture with numbers and no DOM.
 *
 * - **Touch:** a tap clicks where the finger is; a 500 ms press right-clicks there; a one-finger
 *   drag is a mouse drag (down, moves, up); a two-finger drag scrolls.
 * - **Trackpad:** a cursor the phone draws, moved RELATIVELY by one finger with acceleration (a
 *   tiny screen, a precise pointer); a tap clicks at the cursor, a two-finger tap right-clicks there,
 *   a two-finger drag scrolls, and a double-tap-and-drag drags.
 * - **View only:** one finger pans, nothing is sent.
 *
 * In every mode a PINCH zooms the view and is never input. A two-finger gesture is a pinch once the
 * fingers' spread changes by `PINCH_SLOP`; until then a parallel move is a scroll (a pan in View
 * only). Once a gesture has been read as one thing it stays that thing until the fingers lift.
 *
 * In every mode THREE fingers pan the view and are never input — the way to look around a zoomed
 * desktop without zooming out, when two fingers already mean scroll. A third finger landing takes
 * over whatever the two were doing (a scroll just stops; nothing is pressed while two are down).
 *
 * Scroll deltas are SOURCE pixels the content should move, the way it follows the fingers:
 * fingers down ⇒ `dy > 0` (natural scrolling, as on the Mac's own trackpad).
 */
import type { DesktopInput } from "../shared/wire.mts";
import type { Pt } from "./view.ts";

export type InputMode = "touch" | "trackpad" | "view";

/** Phone px a finger may wander and still be a tap. */
export const SLOP = 8;
/** A press held this long without moving is a right click (Touch). */
export const LONG_MS = 500;
/** A second tap within this long is a double click (and in Trackpad, the start of a drag). */
export const DOUBLE_MS = 350;
/** …and within this many phone px of the first (Touch; the trackpad cursor does not move). */
export const DOUBLE_DIST = 30;
/** Two fingers down and up within this long, without moving, is a two-finger tap. */
export const TAP2_MS = 300;
/** Change in the fingers' spread (phone px) that makes a two-finger gesture a pinch. */
export const PINCH_SLOP = 24;

/** The view's half of the mapping, asked fresh on every event (the view moves under a pinch). */
export interface Mapper {
  /** A phone point → normalised source. */
  toSource(p: Pt): Pt;
  /** Normalised source per phone px, each axis (the trackpad cursor's step). */
  unitsPerPx(): Pt;
  /** Source px per phone px (a scroll's size on the desktop). Null while the desktop's width is
   *  unknown: a scroll is then DROPPED — a guessed width scrolled the wrong distance. */
  srcPxPerPx(): number | null;
}

export type GestureOut =
  | { t: "input"; ev: DesktopInput }
  /** Zoom by `factor` about the phone point `at`, then pan by `pan` phone px. */
  | { t: "zoom"; factor: number; at: Pt; pan: Pt }
  /** Pan by `d` phone px (content follows the finger). */
  | { t: "pan"; d: Pt }
  /** The trackpad cursor moved (normalised source). */
  | { t: "cursor"; at: Pt };

export interface PointerIn { id: number; x: number; y: number; t: number }

/** The trackpad's pointer acceleration: a slow finger moves the cursor 1:1, a fast flick up to 4×.
 *  `v` is phone px per ms. */
export function accel(v: number): number {
  return 1 + 2.5 * Math.min(1.2, Math.max(0, v - 0.25));
}

type Phase =
  | "idle"
  | "pending"   // one finger down, not yet a drag or a long press
  | "drag"      // Touch: a mouse drag in progress
  | "long"      // Touch: the long press fired; the rest of this touch is ignored
  | "pan"       // View only: one finger pans
  | "tpmove"    // Trackpad: moving the cursor
  | "tpdrag"    // Trackpad: double-tap-and-drag, the button is down
  | "two"       // two fingers, not yet a pinch or a scroll
  | "pinch"
  | "scroll"
  | "pan3"      // three fingers: pan the view in every mode
  | "spent";    // a two-finger gesture ended; wait for every finger to lift

interface Ptr { x: number; y: number; x0: number; y0: number; t0: number; lt: number }

const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);
const mid = (a: Pt, b: Pt): Pt => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const centroid = (ps: Iterable<Pt>): Pt => {
  let x = 0, y = 0, n = 0;
  for (const p of ps) { x += p.x; y += p.y; n++; }
  return n ? { x: x / n, y: y / n } : { x: 0, y: 0 };
};
const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

export function createGestures(map: Mapper, init: { mode: InputMode; cursor?: Pt }) {
  let mode = init.mode;
  let cursor: Pt = init.cursor ?? { x: 0.5, y: 0.5 };
  const ptrs = new Map<number, Ptr>();
  let phase: Phase = "idle";
  let lastTap: { t: number; x: number; y: number; n: number } | null = null;
  /** Trackpad: this touch began within DOUBLE_MS of a tap — a move makes it a drag. */
  let armed = false;
  // two-finger bookkeeping
  let t2 = 0, d0 = 0, c0: Pt = { x: 0, y: 0 }, lastD = 0, lastC: Pt = { x: 0, y: 0 }, moved2 = false;

  const at = () => ({ x: cursor.x, y: cursor.y });
  const inp = (ev: DesktopInput): GestureOut => ({ t: "input", ev });
  const src = (p: Pt) => map.toSource(p);
  const pair = () => { const [a, b] = [...ptrs.values()]; return [a!, b!] as const; };

  /** The click count for a tap at `p`, now — and remember it. */
  const tapCount = (p: Pt, t: number): number => {
    const near = mode === "trackpad" || (lastTap != null && dist(p, lastTap) <= DOUBLE_DIST);
    const n = lastTap && t - lastTap.t <= DOUBLE_MS && near ? Math.min(3, lastTap.n + 1) : 1;
    lastTap = { t, x: p.x, y: p.y, n };
    return n;
  };

  const moveCursor = (dx: number, dy: number, dt: number): GestureOut[] => {
    const g = accel(Math.hypot(dx, dy) / Math.max(1, dt));
    const u = map.unitsPerPx();
    cursor = { x: clamp01(cursor.x + dx * g * u.x), y: clamp01(cursor.y + dy * g * u.y) };
    return [{ t: "cursor", at: at() }, inp({ k: "move", ...at() })];
  };

  /** End whatever one finger was doing, because a second one landed. */
  const endOne = (): GestureOut[] => {
    const one = [...ptrs.values()][0];
    if (phase === "drag" && one) return [inp({ k: "up", b: "l", ...src(one) })];
    if (phase === "tpdrag") return [inp({ k: "up", b: "l", ...at() })];
    return [];
  };

  return {
    get mode() { return mode; },
    get phase() { return phase; },
    cursor: () => at(),
    setCursor(p: Pt) { cursor = { x: clamp01(p.x), y: clamp01(p.y) }; },
    /** Switching mode mid-gesture drops the gesture (a drag in progress is released first). */
    setMode(m: InputMode): GestureOut[] {
      const out = ptrs.size === 1 ? endOne() : [];
      mode = m;
      ptrs.clear();
      phase = "idle";
      lastTap = null;
      armed = false;
      return out;
    },
    /** When the caller should `tick` next (the long-press deadline), or null. */
    nextTick(): number | null {
      if (phase !== "pending" || mode !== "touch") return null;
      const p = [...ptrs.values()][0];
      return p ? p.t0 + LONG_MS : null;
    },

    down(e: PointerIn): GestureOut[] {
      if (ptrs.size >= 3) return []; // a fourth finger changes nothing
      const out: GestureOut[] = [];
      if (ptrs.size === 2) {
        ptrs.set(e.id, { x: e.x, y: e.y, x0: e.x, y0: e.y, t0: e.t, lt: e.t });
        if (phase === "spent") return out;
        phase = "pan3"; lastC = centroid(ptrs.values());
        return out;
      }
      if (ptrs.size === 1) {
        out.push(...endOne());
        ptrs.set(e.id, { x: e.x, y: e.y, x0: e.x, y0: e.y, t0: e.t, lt: e.t });
        if (phase === "spent") return out;
        const [a, b] = pair();
        phase = "two"; t2 = e.t; moved2 = false;
        d0 = lastD = dist(a, b); c0 = lastC = mid(a, b);
        return out;
      }
      ptrs.set(e.id, { x: e.x, y: e.y, x0: e.x, y0: e.y, t0: e.t, lt: e.t });
      phase = "pending";
      armed = mode === "trackpad" && lastTap != null && e.t - lastTap.t <= DOUBLE_MS;
      return out;
    },

    move(e: PointerIn): GestureOut[] {
      const p = ptrs.get(e.id);
      if (!p) return [];
      const px = p.x, py = p.y, dt = e.t - p.lt;
      p.x = e.x; p.y = e.y; p.lt = e.t;
      if (ptrs.size === 1) {
        if (phase === "pending") {
          if (dist(p, { x: p.x0, y: p.y0 }) <= SLOP) return [];
          if (mode === "touch") {
            phase = "drag";
            return [inp({ k: "down", b: "l", ...src({ x: p.x0, y: p.y0 }) }), inp({ k: "move", ...src(p) })];
          }
          if (mode === "view") { phase = "pan"; return [{ t: "pan", d: { x: p.x - p.x0, y: p.y - p.y0 } }]; }
          // trackpad
          const out: GestureOut[] = [];
          if (armed) { phase = "tpdrag"; lastTap = null; out.push(inp({ k: "down", b: "l", ...at() })); }
          else phase = "tpmove";
          out.push(...moveCursor(p.x - p.x0, p.y - p.y0, e.t - p.t0));
          return out;
        }
        if (phase === "drag") return [inp({ k: "move", ...src(p) })];
        if (phase === "pan") return [{ t: "pan", d: { x: p.x - px, y: p.y - py } }];
        if (phase === "tpmove" || phase === "tpdrag") return moveCursor(p.x - px, p.y - py, dt);
        return [];
      }
      if (phase === "pan3") {
        if (ptrs.size !== 3) return [];
        const c = centroid(ptrs.values());
        const d = { x: c.x - lastC.x, y: c.y - lastC.y };
        lastC = c;
        return d.x || d.y ? [{ t: "pan", d }] : [];
      }
      if (ptrs.size !== 2 || phase === "spent") return [];
      const [a, b] = pair();
      const d = dist(a, b), c = mid(a, b);
      const out: GestureOut[] = [];
      if (phase === "two") {
        // Pointer events arrive one finger at a time, so the first half of a pinch moves the
        // centroid too — but its SPREAD moves twice as far. A scroll moves together.
        const spread = Math.abs(d - d0), shift = dist(c, c0);
        if (spread > PINCH_SLOP) phase = "pinch";
        else if (shift > SLOP && spread < shift) phase = mode === "view" ? "pan" : "scroll";
        else return [];
        moved2 = true;
      }
      if (phase === "pinch") out.push({ t: "zoom", factor: lastD > 0 ? d / lastD : 1, at: lastC, pan: { x: c.x - lastC.x, y: c.y - lastC.y } });
      else if (phase === "pan") out.push({ t: "pan", d: { x: c.x - lastC.x, y: c.y - lastC.y } });
      else if (phase === "scroll") {
        const k = map.srcPxPerPx();
        if (k === null) { lastD = d; lastC = c; return []; } // the desktop's size is not known yet: dropped, never guessed
        const dx = Math.round((c.x - lastC.x) * k), dy = Math.round((c.y - lastC.y) * k);
        if (dx || dy) out.push(inp({ k: "scroll", ...(mode === "trackpad" ? at() : src(c)), dx, dy }));
        else return []; // too small to say: keep lastC so the remainder adds up
      }
      lastD = d; lastC = c;
      return out;
    },

    up(e: PointerIn): GestureOut[] {
      const p = ptrs.get(e.id);
      if (!p) return [];
      p.x = e.x; p.y = e.y;
      const n = ptrs.size;
      ptrs.delete(e.id);
      if (n === 3) { phase = "spent"; return []; }
      if (n === 2) {
        const out: GestureOut[] = [];
        if (phase === "two" && !moved2 && e.t - t2 <= TAP2_MS && mode === "trackpad") {
          out.push(inp({ k: "click", b: "r", ...at(), n: 1 }));
        }
        phase = "spent";
        return out;
      }
      const was = phase;
      phase = "idle";
      armed = false;
      switch (was) {
        case "pending": {
          if (mode === "view") return [];
          const count = tapCount(p, e.t);
          return [inp({ k: "click", b: "l", ...(mode === "trackpad" ? at() : src({ x: p.x0, y: p.y0 })), n: count })];
        }
        case "drag": return [inp({ k: "up", b: "l", ...src(p) })];
        case "tpdrag": return [inp({ k: "up", b: "l", ...at() })];
        default: return [];
      }
    },

    /** A pointer the browser took away (a system gesture): release, never click. */
    cancel(e: PointerIn): GestureOut[] {
      if (!ptrs.has(e.id)) return [];
      const out = ptrs.size === 1 ? endOne() : [];
      ptrs.delete(e.id);
      phase = ptrs.size ? "spent" : "idle";
      armed = false;
      return out;
    },

    /** The clock: fires the long press once its deadline has passed. */
    tick(t: number): GestureOut[] {
      if (phase !== "pending" || mode !== "touch") return [];
      const p = [...ptrs.values()][0];
      if (!p || t - p.t0 < LONG_MS) return [];
      phase = "long";
      lastTap = null;
      return [inp({ k: "click", b: "r", ...src({ x: p.x0, y: p.y0 }), n: 1 })];
    },
  };
}

export type Gestures = ReturnType<typeof createGestures>;

/**
 * Upstream events, coalesced until the next animation frame: consecutive moves keep only the last,
 * consecutive scrolls at the same point add up (split at `max` either way), and anything else goes
 * in order — a down is never reordered past the move after it.
 */
export function createCoalescer(max: number) {
  let q: DesktopInput[] = [];
  return {
    push(ev: DesktopInput): void {
      const last = q[q.length - 1];
      if (ev.k === "move" && last?.k === "move") { q[q.length - 1] = ev; return; }
      if (ev.k === "scroll" && last?.k === "scroll" && last.x === ev.x && last.y === ev.y
        && Math.abs(last.dx + ev.dx) <= max && Math.abs(last.dy + ev.dy) <= max) {
        q[q.length - 1] = { ...last, dx: last.dx + ev.dx, dy: last.dy + ev.dy };
        return;
      }
      q.push(ev);
    },
    /** Everything queued, in order; the queue is empty after. */
    drain(): DesktopInput[] { const out = q; q = []; return out; },
    get size() { return q.length; },
  };
}
