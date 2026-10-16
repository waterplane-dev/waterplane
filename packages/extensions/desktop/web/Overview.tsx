/**
 * The overview: while the view is zoomed, the whole desktop small in a corner with the part on
 * screen outlined. Drag the outline, or press anywhere on the overview to centre the view there —
 * a mouse's way to the hidden part (fingers have the three-finger pan), and it works for a finger
 * too. A press here moves the VIEW only; nothing reaches the desktop, because the overview is a
 * sibling of the picture's element, not inside it (the controller's native listeners are on that).
 *
 * The controller paints the canvas (the last picture of the whole desktop, at most a second old —
 * with Crop to view on, the zoomed stream carries only the crop, so the overview keeps the picture
 * from before the zoom) and places the outline imperatively; React only mounts it and sizes it.
 */
import { useEffect, useRef } from "react";
import type { DesktopController } from "./controller.ts";
import type { Box } from "./view.ts";

const WRAP = {
  position: "absolute", right: 8, bottom: 8, zIndex: 2, touchAction: "none", cursor: "move",
  border: "1px solid rgba(255,255,255,0.7)", boxShadow: "0 0 4px #000", background: "#222", opacity: 0.9,
} as const;
const RECT = {
  position: "absolute", left: 0, top: 0, width: 0, height: 0, pointerEvents: "none",
  border: "2px solid var(--accent)", boxShadow: "0 0 0 1px #000", boxSizing: "border-box",
} as const;

export const OVERVIEW_TITLE = "overview — the whole desktop; drag the outline, or press anywhere on it, to move the zoomed view there (the middle mouse button also drags the picture)";

export function Overview({ ctl, map }: { ctl: DesktopController; map: Box }) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const rect = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const w = wrap.current;
    if (!w) return;
    ctl.attachMap(canvas.current, rect.current);
    const at = (e: PointerEvent) => { const r = w.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    const down = (e: PointerEvent) => {
      e.preventDefault(); e.stopPropagation();
      try { w.setPointerCapture(e.pointerId); } catch { /* fine */ }
      ctl.mapDown(at(e));
    };
    const move = (e: PointerEvent) => { if (w.hasPointerCapture(e.pointerId)) { e.preventDefault(); ctl.mapMove(at(e)); } };
    const up = () => ctl.mapUp();
    const menu = (e: Event) => e.preventDefault();
    w.addEventListener("pointerdown", down);
    w.addEventListener("pointermove", move);
    w.addEventListener("pointerup", up);
    w.addEventListener("pointercancel", up);
    w.addEventListener("contextmenu", menu);
    return () => {
      w.removeEventListener("pointerdown", down);
      w.removeEventListener("pointermove", move);
      w.removeEventListener("pointerup", up);
      w.removeEventListener("pointercancel", up);
      w.removeEventListener("contextmenu", menu);
      ctl.attachMap(null, null);
    };
  }, [ctl]);

  // A new size (rotation, a resize): the controller repaints and re-places for it.
  useEffect(() => { ctl.attachMap(canvas.current, rect.current); }, [ctl, map.w, map.h]);

  return (
    <div ref={wrap} style={{ ...WRAP, width: map.w, height: map.h }} title={OVERVIEW_TITLE} aria-label="overview of the whole desktop">
      <canvas ref={canvas} style={{ display: "block", width: map.w, height: map.h }} />
      <div ref={rect} style={RECT} />
    </div>
  );
}
