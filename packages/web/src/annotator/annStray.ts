/**
 * Fingers OUTSIDE the picture still count toward a two-finger pan.
 *
 * At zoom the picture is a band between the toolbar and the send bar, and a
 * two-finger pan very often lands one finger on either. The wrapper then saw
 * ONE finger and drew a box out of the pan (owner, 2026-11-20, R-images-018).
 * So a touch outside the wrapper is watched on window (capture phase): one
 * landing while a finger is on the picture joins the gesture at once, one that
 * landed first is adopted by the wrapper's next touch (`adoptStrays`).
 */

import { useEffect, useRef, type RefObject } from "react";

type Pts = Map<number, { x: number; y: number }>;
type Ptr = { pointerId: number; clientX: number; clientY: number };

/** Capture `id` to the wrapper and count it as a finger of the gesture.
 *  `mustCapture`: a stray whose capture fails is no longer down (its up was
 *  missed) — adopting it would leave a phantom finger that turns every later
 *  touch into a pinch. A finger that has JUST landed is down, so it is counted
 *  uncaptured and the window listener tracks it. */
function adopt(wrap: HTMLElement | null, pointers: Pts, id: number, x: number, y: number, mustCapture: boolean) {
  try { wrap?.setPointerCapture(id); } catch { if (mustCapture) return; }
  pointers.set(id, { x, y });
}

export function adoptStrays(wrap: HTMLElement | null, pointers: Pts, strays: Pts) {
  for (const [id, p] of strays) adopt(wrap, pointers, id, p.x, p.y, true);
  strays.clear();
}

export function useStrayTouches(
  wrapRef: RefObject<HTMLDivElement | null>,
  pointers: { current: Pts },
  strays: { current: Pts },
  actions: { onMove: (e: Ptr) => void; onUp: (e: Ptr) => void; beginPinch: () => void },
) {
  const act = useRef(actions);
  act.current = actions;
  useEffect(() => {
    const outside = (e: PointerEvent) => !wrapRef.current || !wrapRef.current.contains(e.target as Node);
    const down = (e: PointerEvent) => {
      if (e.pointerType !== "touch" || !outside(e)) return;
      if (pointers.current.size === 0) { strays.current.set(e.pointerId, { x: e.clientX, y: e.clientY }); return; }
      e.preventDefault();
      e.stopPropagation(); // the button under it never sees the press
      adopt(wrapRef.current, pointers.current, e.pointerId, e.clientX, e.clientY, false);
      // `>= 2`, as in onDown: a third finger re-bases the pinch, never starts a mark.
      if (pointers.current.size >= 2) act.current.beginPinch();
    };
    const move = (e: PointerEvent) => {
      if (strays.current.has(e.pointerId)) strays.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      // An adopted finger the wrapper could not capture: its events arrive elsewhere.
      else if (outside(e) && pointers.current.has(e.pointerId)) act.current.onMove(e);
    };
    const gone = (e: PointerEvent) => {
      strays.current.delete(e.pointerId);
      if (outside(e) && pointers.current.has(e.pointerId)) act.current.onUp(e);
    };
    const on: [string, (e: PointerEvent) => void][] = [["pointerdown", down], ["pointermove", move], ["pointerup", gone], ["pointercancel", gone]];
    for (const [t, f] of on) window.addEventListener(t, f as EventListener, true);
    return () => { for (const [t, f] of on) window.removeEventListener(t, f as EventListener, true); };
  }, [wrapRef, pointers, strays]);
}
