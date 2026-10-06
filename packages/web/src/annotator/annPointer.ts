/**
 * The gesture: pointer down / move / up for drawing, cropping, moving and reshaping, and pinch-zoom.
 *
 * Moved out of `ImageAnnotator.tsx` (docs/notes/charts-architecture.md); the sheet's behaviour is
 * unchanged and `ImageAnnotator.tsx` composes it.
 */

import { clipMark } from "../annClip";
import { moveGrab, settleMove, smallOnScreen, SMALL_PX, TAP_SLOP_PX } from "../annMove";
import { applyKnob, knobAt } from "../annKnobs";
import { normRect, shapeBBox, hitShapeOn } from "./annGeom";
import { type AnnCtx, type Shape } from "./annTypes";
import { placesFor as knobPlacesFor } from "./annDraw";

export function pointerActions(c: AnnCtx, readBand: (s: Shape) => Promise<void>) {
  const { canvasRef, wrapRef, tool, color, factor, setShapes, shapesRef, dragRef, moveMode, setSelected, selectedRef, setTarget, targetRef, setMoveNote, knobsRef, moveRef, cropMode, setPendingCrop, cropDrag, setPendingText, setTextDraft, textInputRef, idRef, setView, viewRef, fitRef, pointers, gesture, redraw, clampToImage } = c;
  const hitShape = (s: Shape, x: number, y: number, tol: number) => hitShapeOn(canvasRef.current, s, x, y, tol);
  const placesFor = (canvas: HTMLCanvasElement, s: Shape) => knobPlacesFor(canvas, s, viewRef.current.k || 1);

  /** Grab tolerance in canvas px, so it stays a fingertip on screen at any zoom.
   *  The screen-px floor matches the touch-target width `smallOnScreen` hides
   *  dots below, so a mark just at that edge is exactly as easy to pick as it
   *  is to see is small. */
  function grabTol(): number {
    const canvas = canvasRef.current;
    const k = viewRef.current.k || 1;
    return Math.max(6, SMALL_PX / 2 / k, canvas ? canvas.width / 90 : 0);
  }

  /** Map a pointer event to canvas (native image) coordinates. getBoundingClientRect
      already reflects the CSS zoom/pan transform, so this stays correct when zoomed. */
  function toCanvas(e: { clientX: number; clientY: number }): { x: number; y: number } {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * canvas.width,
      y: ((e.clientY - rect.top) / rect.height) * canvas.height,
    };
  }
  function wrapLocal(e: { clientX: number; clientY: number }): { x: number; y: number } {
    const r = wrapRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  /** Topmost mark under the point — last drawn wins, as on screen. */
  function pickShape(x: number, y: number, tol: number): number | null {
    const cur = shapesRef.current;
    for (let i = cur.length - 1; i >= 0; i--) if (hitShape(cur[i], x, y, tol)) return i;
    return null;
  }

  function onDown(e: React.PointerEvent) {
    e.preventDefault();
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    // Captured on the WRAPPER, never on `e.target`: the drag may begin on the
    // letterbox beside the image, and a capture on whichever element the finger
    // happened to land on is a different element per gesture.
    e.currentTarget.setPointerCapture(e.pointerId);
    if (pointers.current.size === 2) {
      // Begin pinch: drop any in-progress draw or move.
      dragRef.current = null;
      moveRef.current = null;
      const pts = [...pointers.current.values()];
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      const mid = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
      const local = wrapLocal({ clientX: mid.x, clientY: mid.y });
      const v = viewRef.current;
      // content point under the pinch midpoint (transform-origin 0,0)
      gesture.current = { startDist: dist, startK: v.k, cx: (local.x - v.tx) / v.k, cy: (local.y - v.ty) / v.k };
      cropDrag.current = null;
      redraw();
      return;
    }
    if (cropMode) {
      const { x, y } = toCanvas(e);
      cropDrag.current = { x0: x, y0: y, x1: x, y1: y };
      setPendingCrop(null);
      return;
    }
    if (moveMode) {
      setMoveNote(null); // a refusal from the last drag doesn't outlive this one
      const { x, y } = toCanvas(e);
      const tol = grabTol();
      const k = viewRef.current.k || 1;
      const cur = shapesRef.current;
      // A selection that no longer exists (e.g. a stale index past a delete)
      // is no selection at all — moveGrab must never see a dangling `sel`.
      const selRaw = selectedRef.current;
      const sel = selRaw != null && cur[selRaw] ? selRaw : null;
      const s = sel != null ? cur[sel] : undefined;
      // A turned mark (knob mode made it) has no usable end dots: a direct drag on
      // it always moves it, as on a small one.
      const small = s ? smallOnScreen(s, k) || !!s.angle : false;
      if (knobsRef.current) {
        const canvas = canvasRef.current!;
        // A knob of the current selection first: it hangs beside the mark, so
        // it can sit over another mark and must still win.
        const held = s ? knobAt(placesFor(canvas, s), x, y, k) : null;
        if (held) {
          moveRef.current = { i: sel!, base: s!, live: s!, gx: x, gy: y, handle: null, sx: e.clientX, sy: e.clientY, fromEmpty: false, knob: held };
          return;
        }
        // Then a mark under the finger — picked, and moved whole if dragged.
        const hit = pickShape(x, y, tol);
        if (hit != null) {
          selectedRef.current = hit;
          setSelected(hit);
          moveRef.current = { i: hit, base: cur[hit], live: cur[hit], gx: x, gy: y, handle: null, sx: e.clientX, sy: e.clientY, fromEmpty: false, knob: "move" };
          redraw();
          return;
        }
        // Empty space: no relative drag in this mode, only the deselect tap.
        if (sel != null) moveRef.current = { i: sel, base: s!, live: s!, gx: x, gy: y, handle: null, sx: e.clientX, sy: e.clientY, fromEmpty: true, idle: true };
        return;
      }
      // An end dot of the CURRENT selection wins over picking another mark:
      // reshaping is the finer gesture, and it starts on top of the shape.
      // Suppressed on a small mark — its dots are not drawn, so there is
      // nothing here for the finger to have actually landed on. NEAREST dot
      // within tolerance, not first-found: two dots close enough on screen to
      // both fall inside `tol*1.4` must not always resolve to the tail.
      let handleHit: 0 | 1 | null = null;
      if (s && s.tool !== "text" && !small) {
        let best = Infinity;
        for (const h of [0, 1] as const) {
          const hx = h === 0 ? s.x0 : s.x1, hy = h === 0 ? s.y0 : s.y1;
          const d = Math.hypot(x - hx, y - hy);
          if (d <= tol * 1.4 && d < best) { best = d; handleHit = h; }
        }
      }
      const pickHit = pickShape(x, y, tol);
      const grab = moveGrab({ sel, small, handleHit, pickHit, target: targetRef.current });
      if (grab.kind === "handle") {
        moveRef.current = { i: grab.i, base: s!, live: s!, gx: x, gy: y, handle: grab.h, sx: e.clientX, sy: e.clientY, fromEmpty: false };
        return;
      }
      if (grab.kind === "pick") {
        if (grab.i !== sel) { setTarget(null); targetRef.current = null; } // a freshly-picked mark has no target opinion yet
        selectedRef.current = grab.i;
        setSelected(grab.i);
        moveRef.current = { i: grab.i, base: cur[grab.i], live: cur[grab.i], gx: x, gy: y, handle: null, sx: e.clientX, sy: e.clientY, fromEmpty: false };
        redraw();
        return;
      }
      if (grab.kind === "relative") {
        // Nothing is under the finger — the whole point. The mark still
        // follows the finger's delta (onMove), it just didn't start on it.
        moveRef.current = { i: sel!, base: s!, live: s!, gx: x, gy: y, handle: grab.h, sx: e.clientX, sy: e.clientY, fromEmpty: true };
        return;
      }
      return; // "none": nothing selected, nothing hit — no gesture yet
    }
    if (tool === "text") return; // placed on up
    const { x, y } = toCanvas(e);
    dragRef.current = { tool, x0: x, y0: y, x1: x, y1: y, color, factor, id: idRef.current++ };
  }

  function onMove(e: React.PointerEvent) {
    if (pointers.current.has(e.pointerId)) pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (gesture.current && pointers.current.size >= 2) {
      const pts = [...pointers.current.values()];
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      const mid = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
      const local = wrapLocal({ clientX: mid.x, clientY: mid.y });
      const g = gesture.current;
      const minK = fitRef.current.k;
      const k = Math.min(minK * 8, Math.max(minK, g.startK * (dist / g.startDist)));
      setView({ k, tx: local.x - g.cx * k, ty: local.y - g.cy * k });
      return;
    }
    if (cropMode && cropDrag.current) {
      const { x, y } = toCanvas(e);
      cropDrag.current = { ...cropDrag.current, x1: x, y1: y };
      redraw();
      return;
    }
    if (moveMode) {
      const m = moveRef.current;
      if (!m) return;
      if (m.idle) return;
      const { x, y } = toCanvas(e);
      if (m.knob) {
        const canvas = canvasRef.current!;
        const b = shapeBBox(canvas.getContext("2d")!, canvas, m.base);
        m.live = applyKnob(m.knob, m.base, { x: m.gx, y: m.gy }, { x, y }, viewRef.current.k || 1, { x: b.x + b.w / 2, y: b.y + b.h / 2 });
        redraw();
        return;
      }
      const dx = x - m.gx, dy = y - m.gy;
      m.live =
        m.handle === 0 ? { ...m.base, x0: m.base.x0 + dx, y0: m.base.y0 + dy }
        : m.handle === 1 ? { ...m.base, x1: m.base.x1 + dx, y1: m.base.y1 + dy }
        : { ...m.base, x0: m.base.x0 + dx, y0: m.base.y0 + dy, x1: m.base.x1 + dx, y1: m.base.y1 + dy };
      redraw();
      return;
    }
    if (!dragRef.current) return;
    const { x, y } = toCanvas(e);
    dragRef.current = { ...dragRef.current, x1: x, y1: y };
    redraw();
  }

  function onUp(e: React.PointerEvent) {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) gesture.current = null;
    if (pointers.current.size > 0) return; // still gesturing

    if (cropMode) {
      if (cropDrag.current) {
        const r = clampToImage(normRect(cropDrag.current));
        cropDrag.current = null;
        setPendingCrop(r.w > 12 && r.h > 12 ? r : null); // ignore tiny taps
        redraw();
      }
      return;
    }
    if (moveMode) {
      const m = moveRef.current;
      moveRef.current = null;
      if (m) {
        // A relative drag that barely moved was a tap on empty space, not a
        // move — the deselect gesture, deferred from down to up so a real
        // drag starting there still works (see annMove.ts).
        if (m.fromEmpty && Math.hypot(e.clientX - m.sx, e.clientY - m.sy) < TAP_SLOP_PX) {
          selectedRef.current = null;
          targetRef.current = null;
          setSelected(null);
          setTarget(null);
          redraw();
          return;
        }
        if (m.idle) { redraw(); return; }
        const canvas = canvasRef.current;
        const { mark, refused } = canvas ? settleMove(m.live, m.base, canvas.width, canvas.height) : { mark: m.live, refused: false };
        if (refused) {
          // Nothing moved — `mark` is only `m.base`, a snapshot from before
          // the drag, and writing it back would clobber any field a
          // concurrent `patchShape` (readBand) landed on this mark mid-drag.
          redraw(); // clears the live overlay; not in the redraw effect's deps
        } else {
          // Merge geometry ONLY, onto the row as it stands NOW — the same
          // reason: `read`/`reading` may have landed while this drag was live.
          setShapes((prev) => prev.map((s, i) => (i === m.i ? { ...s, x0: mark.x0, y0: mark.y0, x1: mark.x1, y1: mark.y1, angle: mark.angle } : s)));
        }
        setMoveNote(refused ? "That would take it off the picture — left where it was." : null);
      } else redraw();
      return;
    }
    if (tool === "text") {
      const { x, y } = toCanvas(e);
      setPendingText({ x, y });
      setTextDraft("");
      // The bar mounts this frame; focus it on the next one so the keyboard
      // comes up from the tap that asked for it.
      requestAnimationFrame(() => textInputRef.current?.focus());
      return;
    }
    if (dragRef.current) {
      const raw = dragRef.current;
      dragRef.current = null;
      // What overhangs the picture is cut HERE, on release: it is drawn while
      // the finger is down (the drag is the whole point), the canvas never
      // painted it, and the only place it would have survived is the sentence
      // the agent reads — as percentages of an image it is not in.
      const canvas = canvasRef.current;
      const s = canvas ? clipMark(raw, canvas.width, canvas.height) : raw;
      if (s && (Math.abs(s.x1 - s.x0) > 6 || Math.abs(s.y1 - s.y0) > 6)) {
        setShapes((prev) => [...prev, s]);
        // The band is placed; ask the host what is under it. Fire and forget —
        // the mark is already complete without an answer.
        if (s.tool === "marker") void readBand(s);
      } else redraw();
    }
  }

  return { onDown, onMove, onUp };
}
