/**
 * The annotator's ONE state hook: every `useState`, `useRef` and `useEffect` of the sheet, in their original order.
 *
 * Moved out of `ImageAnnotator.tsx` (docs/notes/charts-architecture.md); the sheet's behaviour is
 * unchanged and `ImageAnnotator.tsx` composes it.
 *
 * The handlers are built from this state by the factories in `annEdit`, `annPointer`, `annRead` and
 * `annSend` (see `AnnCtx`); no region component holds a hook, because a child's effects run before its
 * parent's and moving one would reorder them.
 */

import { useEffect, useRef, useState } from "react";
import { visibleMarks } from "../annNote";
import { drawBadges, drawCropOverlay, drawSelection, drawShape } from "./annDraw";
import { editActions } from "./annEdit";
import { clampRect, normRect } from "./annGeom";
import { pointerActions } from "./annPointer";
import { readActions } from "./annRead";
import { sendActions } from "./annSend";
import { ocrActions, type OcrState } from "./annOcr";
import { COLORS, type AnnCtx, type AnnotatorProps, type AnnRect, type Shape, type Tool } from "./annTypes";
import { LS, lsBool, lsJson, lsSetBool, lsSetJson } from "../storage";
import { readLayout, type AnnLayout } from "../annLayout";
import { type Knob } from "../annKnobs";

export function useAnnotator({ source, repoId, index, total, facts, onUploaded, onDispatch, onPark, onSkip, onSendAll, onText, onClose }: AnnotatorProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<ImageBitmap | HTMLImageElement | HTMLCanvasElement | null>(null);
  const [tool, setTool] = useState<Tool>("circle");
  const [color, setColor] = useState(COLORS[0]);
  const [factor, setFactor] = useState(1);
  const [shapes, setShapes] = useState<Shape[]>([]);
  // Mirror shapes into a ref so async redraws (image decode finishing after a
  // batch step) never repaint with a stale closure's shapes — that's what
  // carried the previous image's marks onto the next one.
  const shapesRef = useRef(shapes);
  shapesRef.current = shapes;
  const dragRef = useRef<Shape | null>(null);
  // Move mode: drawing is off, a tap SELECTS the mark under it and a drag moves
  // it (or reshapes it, by an end dot). A placed mark stops being permanent —
  // the alternative on a phone is undo-and-redraw, which is the whole mark.
  const [moveMode, setMoveMode] = useState(false);
  const [selected, setSelected] = useState<number | null>(null);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  // Which end a RELATIVE drag reshapes (see annMove.ts) — the mode chip's own
  // state, `null` meaning "the whole mark". Only consulted when the finger is
  // not on the mark at all; a direct drag on a visible end dot always wins.
  const [target, setTarget] = useState<0 | 1 | null>(null);
  const targetRef = useRef(target);
  targetRef.current = target;
  // What a refused move says, right where the mode chips are — cleared on the
  // next pointer-down so it never outlives the drag it was about.
  const [moveNote, setMoveNote] = useState<string | null>(null);
  // Knob mode (annKnobs.ts): the selected mark wears move/size/turn knobs on
  // strings instead of end dots and the whole·A·B chips. Opt-in, per device.
  const [knobs, setKnobs] = useState(() => lsBool(LS.annKnobs));
  // The idle gesture hint, closed once and gone for good on this device — it
  // costs a row of picture on every open once it has been read.
  const [hintHidden, setHintHidden] = useState(() => lsBool(LS.annHintHidden));
  const hideHint = () => { lsSetBool(LS.annHintHidden, true); setHintHidden(true); };
  const knobsRef = useRef(knobs);
  knobsRef.current = knobs;
  // Live drag of an existing shape, held OUT of state for the same reason
  // dragRef is: one redraw per pointer move, not one React render. `sx`/`sy`
  // and `fromEmpty` are screen-space and only meaningful for a relative drag —
  // they tell a tap-to-deselect (see TAP_SLOP_PX) from an actual move.
  // `knob` is set when a knob is what the finger holds; `idle` is knob mode's
  // stand-in for a relative drag — there is none, so a drag from empty space
  // does nothing and only its tap (deselect) counts.
  const moveRef = useRef<{ i: number; base: Shape; live: Shape; gx: number; gy: number; handle: 0 | 1 | null; sx: number; sy: number; fromEmpty: boolean; knob?: Knob; idle?: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Crop: when on, a one-finger drag selects a region; the selection is staged
  // (pendingCrop) so the user can confirm before the image is actually cut.
  const [cropMode, setCropMode] = useState(false);
  const [pendingCrop, setPendingCrop] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const cropDrag = useRef<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  // Text: a tap stages a spot, the bar below takes the words — never
  // `window.prompt`, which blocks the WebView's event loop (see Confirm.tsx)
  // and which an Android WebView may suppress outright, leaving the text tool
  // doing nothing at all when you tap the canvas.
  const [pendingText, setPendingText] = useState<{ x: number; y: number } | null>(null);
  const [textDraft, setTextDraft] = useState("");
  const textInputRef = useRef<HTMLInputElement>(null);
  // Ids handed out to marks, and the words read back for them.
  //
  // The text map is kept OUTSIDE React state on purpose: `flattenAsync` snapshots
  // the marks at the tap and the sheet may advance to the next image (which
  // clears `shapes`) before a read lands, so the note is rebuilt from the
  // snapshot plus this map — never from state that has moved on.
  const idRef = useRef(1);
  const readTextRef = useRef<Map<number, string>>(new Map());
  // Which image the marks belong to. A read that answers for the PREVIOUS image
  // of a batch must land nowhere.
  const genRef = useRef(0);
  // Correcting (or supplying) a band's words by hand — the same bar the text
  // tool uses, because a reader that got one character wrong is fixed by typing,
  // not by re-highlighting.
  const [editRead, setEditRead] = useState<number | null>(null);
  const [readDraft, setReadDraft] = useState("");
  const readInputRef = useRef<HTMLInputElement>(null);

  // One dot of the CURRENT colour opens the palette: five always-on swatches
  // cost a phone's toolbar five slots to say one thing.
  const [paletteOpen, setPaletteOpen] = useState(false);
  // "Text only" (annOcr.ts): the desktop's reading of the whole picture and the
  // words as the person is editing them. Per picture — cleared with the marks.
  const [ocr, setOcr] = useState<OcrState | null>(null);
  const [ocrDraft, setOcrDraft] = useState("");

  // The toolbar as the person arranged it (`annLayout.ts`), and whether its
  // config panel is up. Written through on every change, like the knobs switch.
  const [layout, setLayoutState] = useState<AnnLayout>(() => readLayout(lsJson<unknown>(LS.annTools, null)));
  const setLayout = (l: AnnLayout) => { setLayoutState(l); lsSetJson(LS.annTools, l); };
  const [configOpen, setConfigOpen] = useState(false);

  // Zoom/pan transform (CSS px, transform-origin 0 0). Canvas is absolutely
  // placed with NO css scaling, so screen = t + canvasPx * k exactly.
  const [view, setView] = useState({ k: 1, tx: 0, ty: 0 });
  const viewRef = useRef(view);
  viewRef.current = view;
  const fitRef = useRef({ k: 1, tx: 0, ty: 0 }); // the "fit to wrapper" view
  // Active pointers for gesture detection.
  const pointers = useRef<Map<number, { x: number; y: number }>>(new Map());
  const gesture = useRef<null | { startDist: number; startK: number; cx: number; cy: number }>(null);

  useEffect(() => {
    let revoked: string | null = null;
    let cancelled = false;
    setShapes([]); // fresh marks per image when stepping through a batch
    setOcr(null);
    setOcrDraft("");
    genRef.current++;
    setEditRead(null);
    setSelected(null);
    setTarget(null);
    setMoveNote(null);
    moveRef.current = null;
    setErr(null);
    setBusy(false); // re-enable send for the next image in a batch (component stays mounted)
    const sizeAndDraw = (w: number, h: number) => {
      const canvas = canvasRef.current!;
      canvas.width = w;
      canvas.height = h;
      const wrap = wrapRef.current?.getBoundingClientRect();
      if (wrap) {
        const k = Math.min(wrap.width / w, wrap.height / h);
        const fit = { k, tx: (wrap.width - w * k) / 2, ty: (wrap.height - h * k) / 2 };
        fitRef.current = fit;
        setView(fit);
      }
      redraw();
    };
    const fromBlob = async (blob: Blob) => {
      try {
        const bmp = await createImageBitmap(blob);
        if (cancelled) return;
        imgRef.current = bmp;
        sizeAndDraw(bmp.width, bmp.height);
        return true;
      } catch { return false; }
    };
    const load = async () => {
      if (source instanceof File) {
        if (await fromBlob(source)) return;
        const img = new Image();
        revoked = URL.createObjectURL(source);
        img.onload = () => { if (!cancelled) { imgRef.current = img; sizeAndDraw(img.naturalWidth, img.naturalHeight); } };
        img.onerror = () => !cancelled && setErr("Can't decode this image format on this device.");
        img.src = revoked;
      } else {
        try {
          // An object URL this page minted (see the same read in App's collage path).
          // eslint-disable-next-line no-restricted-globals -- not the API
          const blob = await fetch(source.url).then((r) => r.blob());
          if (!(await fromBlob(blob))) setErr("Can't load this image.");
        } catch { setErr("Can't load this image."); }
      }
    };
    load();
    return () => { cancelled = true; if (revoked) URL.revokeObjectURL(revoked); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reload per image; `redraw` reads everything it needs through refs
  }, [source]);

  // This screen has no text field, so a keyboard on it is one the previous
  // screen left up (tapping the attach button doesn't blur the compose box on
  // Android). It costs the image half the height: the fit above is measured
  // against a wrapper the keyboard has already shrunk, so dismissing it later
  // leaves the picture small and the user pinching to get it back.
  useEffect(() => { (document.activeElement as HTMLElement | null)?.blur(); }, []);

  // …and the wrapper can still change height under us — the keyboard going
  // down, a rotation, the crop bar appearing. Re-fit on resize, but only while
  // the view IS the fit: once the user has zoomed or panned, their view is the
  // one that matters and resize must not throw it away.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      const canvas = canvasRef.current;
      const rect = el.getBoundingClientRect();
      if (!canvas || !canvas.width || !canvas.height || rect.width < 1 || rect.height < 1) return;
      const k = Math.min(rect.width / canvas.width, rect.height / canvas.height);
      const fit = { k, tx: (rect.width - canvas.width * k) / 2, ty: (rect.height - canvas.height * k) / 2 };
      const wasFit = Math.abs(viewRef.current.k - fitRef.current.k) <= fitRef.current.k * 0.02;
      fitRef.current = fit; // keep "reset zoom", the ×N readout and the min-zoom clamp honest
      if (wasFit) {
        // Selection chrome (small-mark dots/pad) is drawn AT this zoom, and
        // `view` is not a redraw dependency — a refit with no pointer event
        // to trigger one otherwise leaves it stale. `viewRef` is mirrored by
        // hand here (not by the render it will cause) because `redraw` reads
        // it synchronously, before React has re-rendered with the new state.
        viewRef.current = fit;
        redraw();
        setView(fit);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only observer; `redraw` reads everything it needs through refs
  }, []);

  useEffect(redraw, [shapes, cropMode, pendingCrop, selected, moveMode, target, knobs]);
  // Nothing left to move (undo/clear/delete emptied the marks): drop back to
  // drawing, or the canvas would silently ignore every touch.
  useEffect(() => { if (!shapes.length && moveMode) { setMoveMode(false); setSelected(null); setTarget(null); } }, [shapes.length, moveMode]);

  /** `plain` = no selection chrome: the flatten path exports THIS canvas, so a
      selection outline drawn here would be baked into the uploaded PNG. */
  function redraw(plain = false) {
    const canvas = canvasRef.current;
    const img = imgRef.current;
    if (!canvas || !img) return;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(img, 0, 0);
    const mv = moveRef.current;
    const cur = mv ? shapesRef.current.map((s, i) => (i === mv.i ? mv.live : s)) : shapesRef.current;
    const all = dragRef.current ? [...cur, dragRef.current] : cur;
    for (const s of all) drawShape(ctx, canvas, img, s);
    // Badges last so nothing covers them, and from the COMMITTED marks only —
    // a number that appears mid-drag and renumbers on release is worse than none.
    drawBadges(ctx, canvas, visibleMarks(cur, canvas.width, canvas.height) as Shape[]);
    if (cropMode) drawCropOverlay(ctx, canvas, cropDrag.current ? normRect(cropDrag.current) : pendingCrop);
    const sel = selectedRef.current;
    if (!plain && !cropMode && sel != null && cur[sel]) drawSelection(ctx, canvas, cur[sel], viewRef.current.k || 1, knobsRef.current, targetRef.current);
  }

  function clampToImage(r: AnnRect): AnnRect {
    return clampRect(canvasRef.current, r);
  }

  const ctx: AnnCtx = {
    source, repoId, facts, onUploaded, onDispatch, onPark, onSendAll,
    canvasRef, wrapRef, imgRef, tool, setTool, color, setColor, factor, shapes, setShapes, shapesRef, dragRef,
    moveMode, setMoveMode, selected, setSelected, selectedRef, target, setTarget, targetRef, setMoveNote,
    setKnobs, knobsRef, moveRef, busy, setBusy, setErr, cropMode, setCropMode, pendingCrop, setPendingCrop, cropDrag,
    pendingText, setPendingText, textDraft, setTextDraft, textInputRef, idRef, readTextRef, genRef,
    editRead, setEditRead, readDraft, setReadDraft, readInputRef, setPaletteOpen, setView, viewRef, fitRef,
    pointers, gesture, redraw, clampToImage,
  };
  const edit = editActions(ctx);
  const read = readActions(ctx);
  const pointer = pointerActions(ctx);
  const { send, sendAll } = sendActions(ctx);
  const ocrAct = ocrActions({ canvasRef, genRef, redraw, setOcr, setOcrDraft, onText });
  const zoomed = view.k > fitRef.current.k * 1.02;

  // The newest highlighted band — the one a person has just drawn and is about
  // to send. One bar, never one per mark: a stack of transcriptions is a screen
  // of text on a phone that is trying to show a picture.
  const lastBand = [...shapes].reverse().find((s) => s.tool === "marker");

  return {
    props: { index, total, onSkip, onSendAll, onDispatch, onText, onClose },
    canvasRef, wrapRef, tool, color, setColor, factor, setFactor, shapes, setShapes, moveMode, selected, setSelected,
    target, setTarget, moveNote, setMoveNote, knobs, busy, err, cropMode, pendingCrop, pendingText, textDraft, setTextDraft,
    textInputRef, editRead, setEditRead, readDraft, setReadDraft, readInputRef, paletteOpen, setPaletteOpen, view, fitRef,
    layout, setLayout, configOpen, setConfigOpen,
    moveRef, zoomed, lastBand, hintHidden, hideHint, ...edit, ...read, ...pointer, send, sendAll,
    ocr, ocrDraft, setOcrDraft, ...ocrAct,
  };
}

export type AnnModel = ReturnType<typeof useAnnotator>;
