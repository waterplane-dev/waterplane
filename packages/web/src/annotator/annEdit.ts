/**
 * The annotator's edit verbs: crop, pick a tool, undo, move and knob modes, delete, place text, reset zoom.
 *
 * Moved out of `ImageAnnotator.tsx` (docs/notes/charts-architecture.md); the sheet's behaviour is
 * unchanged and `ImageAnnotator.tsx` composes it.
 */

import { clipMark } from "../annClip";
import { LS, lsSetBool } from "../storage";
import { MARKER_DEFAULT, type AnnCtx, type Shape, type Tool } from "./annTypes";

export function editActions(c: AnnCtx) {
  const { canvasRef, wrapRef, imgRef, setTool, color, setColor, factor, setShapes, setMoveMode, setSelected, selectedRef, setTarget, targetRef, setMoveNote, setKnobs, moveRef, setCropMode, pendingCrop, setPendingCrop, cropDrag, pendingText, setPendingText, textDraft, setTextDraft, textInputRef, idRef, setPaletteOpen, setView, viewRef, fitRef, redraw, clampToImage } = c;

  /** Cut the image down to the staged selection; translate existing marks. */
  async function applyCrop() {
    const img = imgRef.current;
    const canvas = canvasRef.current;
    if (!img || !canvas || !pendingCrop) return;
    const { x, y, w, h } = clampToImage(pendingCrop);
    if (w < 1 || h < 1) { setPendingCrop(null); return; }
    const off = document.createElement("canvas");
    off.width = Math.round(w);
    off.height = Math.round(h);
    off.getContext("2d")!.drawImage(img, x, y, w, h, 0, 0, off.width, off.height);
    try {
      imgRef.current = await createImageBitmap(off);
    } catch {
      imgRef.current = off; // canvas is a valid drawImage source if bitmap fails
    }
    canvas.width = off.width;
    canvas.height = off.height;
    // A mark the crop pushed entirely outside the new picture is cut the same
    // way a fresh draw is (annClip.ts) — left uncut, it stayed selectable but
    // invisible, and a later zero-motion tap on it read as a refused move.
    setShapes((prev) => prev
      .map((s) => ({ ...s, x0: s.x0 - x, y0: s.y0 - y, x1: s.x1 - x, y1: s.y1 - y }))
      .map((s) => clipMark(s, off.width, off.height))
      .filter((s): s is Shape => s != null));
    const wrap = wrapRef.current?.getBoundingClientRect();
    if (wrap) {
      const k = Math.min(wrap.width / off.width, wrap.height / off.height);
      const fit = { k, tx: (wrap.width - off.width * k) / 2, ty: (wrap.height - off.height * k) / 2 };
      fitRef.current = fit;
      setView(fit);
    }
    setPendingCrop(null);
    setCropMode(false);
    redraw();
  }

  function toggleCrop() {
    cropDrag.current = null;
    setPendingCrop(null);
    setMoveMode(false);
    setSelected(null);
    setTarget(null);
    setMoveNote(null);
    moveRef.current = null;
    cancelText();
    setCropMode((v) => !v);
  }

  /** Switch tools. Leaving `text` drops a label you started and never typed —
   *  the bar goes with the tool it belongs to. */
  function pickTool(t: Tool) {
    if (t !== "text") cancelText();
    setPaletteOpen(false);
    // White multiplies to nothing, so the first swipe of a highlighter left in
    // white would draw an invisible mark and read as a broken tool. The colour
    // is still the user's to change — this only refuses the one that cannot work.
    if (t === "marker" && color.toLowerCase() === "#ffffff") setColor(MARKER_DEFAULT);
    setTool(t);
  }

  function undoShape() {
    moveRef.current = null;
    setSelected(null);
    setTarget(null);
    setMoveNote(null);
    setShapes((s) => s.slice(0, -1));
  }

  function toggleMove() {
    moveRef.current = null;
    setTarget(null);
    setMoveNote(null);
    setMoveMode((v) => {
      if (!v) { cropDrag.current = null; setPendingCrop(null); setCropMode(false); }
      else setSelected(null);
      return !v;
    });
  }

  function toggleKnobs() {
    moveRef.current = null;
    setTarget(null);
    targetRef.current = null;
    setMoveNote(null);
    setKnobs((v) => {
      lsSetBool(LS.annKnobs, !v);
      return !v;
    });
  }

  function deleteSelected() {
    const i = selectedRef.current;
    if (i == null) return;
    moveRef.current = null;
    setSelected(null);
    setTarget(null);
    setMoveNote(null);
    setShapes((prev) => prev.filter((_, n) => n !== i));
  }

  /** Place the staged label. Empty text places nothing — an invisible mark you
   *  can only find with undo is worse than no mark. */
  function commitText() {
    const at = pendingText;
    const t = textDraft.trim();
    setPendingText(null);
    setTextDraft("");
    textInputRef.current?.blur(); // put the keyboard down with the bar
    if (!at || !t) return;
    const canvas = canvasRef.current;
    // A label tapped beside the picture is MOVED onto it, never dropped: it
    // carries typed words, and this is the last copy of them.
    const m = { tool: "text" as const, x0: at.x, y0: at.y, x1: at.x, y1: at.y, color, factor, text: t, id: idRef.current++ };
    setShapes((prev) => [...prev, canvas ? clipMark(m, canvas.width, canvas.height)! : m]);
  }

  function cancelText() {
    setPendingText(null);
    setTextDraft("");
    textInputRef.current?.blur();
  }

  function resetZoom() {
    // Same synchronous mirroring as the ResizeObserver's refit — `redraw`
    // reads `viewRef` before this render has happened.
    viewRef.current = fitRef.current;
    redraw();
    setView(fitRef.current);
  }

  return { applyCrop, toggleCrop, pickTool, undoShape, toggleMove, toggleKnobs, deleteSelected, commitText, cancelText, resetZoom };
}
