/**
 * The terminal corner group's drag handle (`ScreenCorner` in `TermArea.tsx`).
 *
 * The group floats over the top-right of the output, and the line it sits on
 * is sometimes the line you need to read. A grip at its left end moves the
 * whole group anywhere inside the terminal box; a double-tap puts it back.
 *
 * Stored as an OFFSET from the CSS anchor (`.term-zoom`'s top/right), not as
 * a position: the anchor already moves for typing room, and an offset rides
 * along with it instead of fighting it. Clamped to the parent box on every
 * drag and on resize, so a position saved on a wide screen can never park the
 * group off a narrow one — a control you cannot see is a control you cannot
 * drag back.
 *
 * It is a `transform`, never a size or a flow change: the group exists so it
 * does not refit the PTY, and moving it must not either.
 *
 * Pushing PAST the right edge folds the group instead (the owner's ask): the
 * group is anchored right, so it cannot travel further, and every button's
 * width of overshoot takes one column off — a grid that wraps into rows, down
 * to one column (fully vertical) when the finger reaches the far edge.
 * Dragging back left unfolds it the same way. The fold is part of the one
 * virtual position the drag tracks, so out and back is the same gesture.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { LS, lsJson, lsSetJson } from "../../storage";
import { foldCols, foldExcess } from "./cornerFold";

export interface Offset { x: number; y: number }
/** `cols` absent = unfolded (one row). */
export interface Place extends Offset { cols?: number }
const ZERO: Place = { x: 0, y: 0 };
/** Assumed button pitch before one has been measured. */
const STEP_FALLBACK = 40;
/** Gap kept to the box's right edge — the CSS anchor's own `right: 8px`, so a
 *  drag (or a fold) never parks the group flush against the screen edge. */
const EDGE = 8;
/** How close to the box's right edge a finger can drag. */
const FINGER = 16;
/** Never fold faster than one column per this many px. */
const MIN_STEP = 12;
/** Movement under this many px is a tap, not a drag. */
const SLOP = 4;
/** Two taps this close together put the group back. Counted by hand: a
 *  `dblclick` is not reliably synthesised from touch once pointerdown is
 *  prevented. */
const DOUBLE_MS = 350;

function readSaved(): Place {
  const v = lsJson<Partial<Place> | null>(LS.termCornerPos, null);
  if (!v || !Number.isFinite(v.x) || !Number.isFinite(v.y)) return ZERO;
  const cols = Number.isInteger(v.cols) && (v.cols as number) >= 1 ? v.cols : undefined;
  return { x: v.x as number, y: v.y as number, ...(cols ? { cols } : {}) };
}

/** `off` clamped so the element (currently drawn at `cur`) stays inside its parent. */
function clampTo(el: HTMLElement, cur: Offset, off: Offset): Offset {
  const parent = el.offsetParent as HTMLElement | null;
  if (!parent) return off;
  const r = el.getBoundingClientRect();
  const p = parent.getBoundingClientRect();
  // Where the element would be with no offset at all.
  const left0 = r.left - cur.x, top0 = r.top - cur.y;
  const minX = p.left - left0, maxX = p.right - EDGE - (left0 + r.width);
  const minY = p.top - top0, maxY = p.bottom - (top0 + r.height);
  return {
    x: Math.round(Math.min(Math.max(off.x, minX), Math.max(minX, maxX))),
    y: Math.round(Math.min(Math.max(off.y, minY), Math.max(minY, maxY))),
  };
}

/** `onTap(true)` after a double-tap has put the group back, `onTap(false)` for a lone tap. */
export function useCornerDrag(onTap: (wasReset: boolean) => void) {
  const ref = useRef<HTMLDivElement>(null);
  const [off, setOff] = useState<Place>(readSaved);
  const offRef = useRef(off);
  offRef.current = off;
  const drag = useRef<{ id: number; sx: number; sy: number; base: Offset; moved: boolean; n: number; step: number } | null>(null);
  const lastTap = useRef(0);
  /** Average button pitch, measured while the group is one row. */
  const stepRef = useRef(STEP_FALLBACK);

  const reclamp = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const c = clampTo(el, offRef.current, offRef.current);
    if (c.x !== offRef.current.x || c.y !== offRef.current.y) setOff(c);
  }, []);
  // Again after a fold: a taller group may now hang past the bottom.
  useLayoutEffect(reclamp, [reclamp, off.cols]);
  useEffect(() => {
    window.addEventListener("resize", reclamp);
    return () => window.removeEventListener("resize", reclamp);
  }, [reclamp]);

  const onPointerDown = (e: ReactPointerEvent<HTMLElement>) => {
    e.preventDefault(); // keeps focus in the compose box (`keepFocus`'s reason) and stops text selection
    e.currentTarget.setPointerCapture(e.pointerId);
    const el = ref.current;
    const n = el ? el.children.length : 0;
    const cur = offRef.current;
    const parent = el?.offsetParent as HTMLElement | null;
    if (el && parent && n > 1 && !cur.cols) {
      // The pitch is sized to the finger's REACH, not the buttons' width: the
      // fold has to reach one column with the finger at the screen edge, and
      // a pitch of one button left it stuck at two (the grip is on the left
      // end, so the overshoot a finger can make is shorter than the row).
      const pr = parent.getBoundingClientRect().right;
      const room = pr - EDGE - el.getBoundingClientRect().right; // travel before the edge stops it
      const reach = pr - FINGER - e.clientX - room;
      stepRef.current = Math.max(MIN_STEP, reach / (n - 0.5));
    }
    const step = stepRef.current;
    // The drag runs on ONE virtual x: the real offset plus the overshoot the
    // current fold stands for.
    const cols = cur.cols ? Math.min(cur.cols, n) : n;
    const base = { x: cur.x + foldExcess(n, cols, step), y: cur.y };
    drag.current = { id: e.pointerId, sx: e.clientX, sy: e.clientY, base, moved: false, n, step };
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current;
    const el = ref.current;
    if (!d || d.id !== e.pointerId || !el) return;
    const dx = e.clientX - d.sx, dy = e.clientY - d.sy;
    if (!d.moved && Math.hypot(dx, dy) < SLOP) return;
    d.moved = true;
    const want = { x: d.base.x + dx, y: d.base.y + dy };
    // Right-anchored, so the right limit does not depend on the width: the
    // overshoot past it is what folds.
    const parent = el.offsetParent as HTMLElement | null;
    const maxX = parent ? parent.getBoundingClientRect().right - EDGE - (el.getBoundingClientRect().right - offRef.current.x) : want.x;
    const cols = foldCols(d.n, want.x - maxX, d.step);
    const c = clampTo(el, offRef.current, want);
    setOff(cols < d.n ? { ...c, cols } : c);
  };
  const onPointerUp = (e: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    if (d.moved) { lsSetJson(LS.termCornerPos, offRef.current); return; }
    const now = Date.now();
    if (now - lastTap.current < DOUBLE_MS) { lastTap.current = 0; reset(); onTap(true); return; }
    lastTap.current = now;
    onTap(false);
  };
  const onPointerCancel = () => { drag.current = null; };
  const reset = () => { setOff(ZERO); lsSetJson(LS.termCornerPos, ZERO); };

  const moved = off.x !== 0 || off.y !== 0;
  const style: CSSProperties | undefined = moved || off.cols
    ? {
      ...(moved ? { transform: `translate(${off.x}px, ${off.y}px)` } : {}),
      ...(off.cols ? { display: "grid", gridTemplateColumns: `repeat(${off.cols}, auto)` } : {}),
    }
    : undefined;
  return {
    ref,
    style,
    handle: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel },
  };
}
