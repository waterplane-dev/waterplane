/**
 * Reading the words under a highlighted band, and correcting them by hand.
 *
 * Moved out of `ImageAnnotator.tsx` (docs/notes/charts-architecture.md); the sheet's behaviour is
 * unchanged and `ImageAnnotator.tsx` composes it.
 */

import { api } from "../api";
import { track } from "../usage";
import { encodeCanvas } from "../uploadScale";
import { normRect } from "./annGeom";
import { READ_MIN_HEIGHT, READ_MAX_SCALE, type AnnCtx, type Shape } from "./annTypes";

export function readActions(c: AnnCtx) {
  const { canvasRef, imgRef, setShapes, readsRef, readTextRef, genRef, editRead, setEditRead, readDraft, setReadDraft, readInputRef, clampToImage } = c;

  /** Set fields on one mark by its id. Never by index — see `Shape.id`. */
  function patchShape(id: number, patch: Partial<Shape>) {
    setShapes((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  }

  /**
   * Ask the host what the words under a highlighted band are.
   *
   * The crop is cut from the CLEAN image, not from the canvas: the band has
   * already been painted over the text by the time this runs, and a reader
   * handed tinted glyphs is a reader guessing. It is cut at the resolution this
   * phone still holds and drawn UP when it is a thin strip, because the copy
   * that reaches the agent is re-encoded down to the link's width
   * (`scaleForUpload`) — small text survives the mark and not the shrink, which
   * is exactly the case this feature exists for.
   *
   * Nothing here blocks anything. A failure is a sentence on the bar, the mark
   * stands on its geometry alone, and the note simply carries no quote.
   */
  async function readBand(s: Shape) {
    const img = imgRef.current;
    const canvas = canvasRef.current;
    if (!img || !canvas) return;
    const r = clampToImage(normRect(s));
    if (r.w < 8 || r.h < 4) return;
    const gen = genRef.current;
    track("action:image.readtext");
    patchShape(s.id, { reading: true, readErr: undefined });
    const done = (patch: Partial<Shape>) => {
      if (gen !== genRef.current) return; // answered for an image we have left
      patchShape(s.id, { reading: false, ...patch });
    };
    const job = (async () => {
      try {
        // A swipe clips ascenders and descenders, and half a letter reads as a
        // different letter — so the crop is a little taller than the band.
        const pad = Math.max(2, r.h * 0.3);
        const c = clampToImage({ x: r.x - pad, y: r.y - pad, w: r.w + pad * 2, h: r.h + pad * 2 });
        const scale = Math.min(READ_MAX_SCALE, Math.max(1, READ_MIN_HEIGHT / Math.max(1, c.h)));
        const off = document.createElement("canvas");
        off.width = Math.max(1, Math.round(c.w * scale));
        off.height = Math.max(1, Math.round(c.h * scale));
        const octx = off.getContext("2d");
        if (!octx) { done({ readErr: "this device could not cut the crop" }); return; }
        octx.imageSmoothingQuality = "high";
        octx.drawImage(img, c.x, c.y, c.w, c.h, 0, 0, off.width, off.height);
        // `encodeCanvas` for the reason the flatten path uses it: a bare
        // `toBlob` on an Android WebView can answer null, answer empty, or never
        // answer at all.
        const blob = await encodeCanvas(off, "image/png");
        if (!blob) { done({ readErr: "this device could not encode the crop" }); return; }
        const res = await api.readText(blob);
        if ("text" in res && res.text) {
          readTextRef.current.set(s.id, res.text);
          done({ read: res.text, readErr: undefined });
        } else {
          done({ read: undefined, readErr: ("error" in res && res.error) || "no words read" });
        }
      } catch {
        done({ readErr: "the host could not be asked — the mark still says where to look" });
      }
    })();
    readsRef.current.set(s.id, job);
    await job;
    readsRef.current.delete(s.id);
  }

  /** Correct (or supply) a band's words by hand. */
  function startEditRead(s: Shape) {
    setEditRead(s.id);
    setReadDraft(s.read ?? "");
    requestAnimationFrame(() => readInputRef.current?.focus());
  }
  function commitRead() {
    const id = editRead;
    const t = readDraft.trim();
    setEditRead(null);
    setReadDraft("");
    readInputRef.current?.blur();
    if (id == null) return;
    if (t) readTextRef.current.set(id, t);
    else readTextRef.current.delete(id);
    patchShape(id, { read: t || undefined, readErr: t ? undefined : "no words on this mark" });
  }

  /** Keep the band, drop the sentence — a read that is right but beside the
   *  point is noise in the prompt. */
  function dropRead(s: Shape) {
    readTextRef.current.delete(s.id);
    patchShape(s.id, { read: undefined, readErr: "words dropped" });
  }

  return { patchShape, readBand, startEditRead, commitRead, dropRead };
}
