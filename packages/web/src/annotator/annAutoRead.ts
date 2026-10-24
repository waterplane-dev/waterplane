/**
 * Reading a mark's words ON THE PHONE, the DOM half (the plan is `annReadPlan.ts`, node-tested).
 *
 * When a highlight, box or circle is finished — or moved, resized, turned or cropped — and an
 * enabled text-in-marks extension offers a reader (`imageTextReader()`), its area is cut from the
 * CLEAN picture (no handles, badges or other ink; but every blur IS applied first, so a redacted
 * word is never read back into the note), enlarged for small text, and handed over as a PNG.
 * The answer lands on the mark only while its words are still not the person's (`readBy`), the
 * mark still exists with the same geometry, and the same picture is open. Nothing, an error, an
 * abort or 10 s ⇒ no words, and the mark says so; never a guess.
 */
import type { MutableRefObject, RefObject } from "react";
import { cleanRead, planReads, readCropRect, readKey, readScale, READ_TIMEOUT_MS, type ReadMark } from "../annReadPlan";
import type { ImageTextReader } from "../sdk/types";
import { encodeCanvas } from "../uploadScale";
import { drawShape } from "./annDraw";
import { baseWidth } from "./annGeom";
import type { Shape } from "./annTypes";

/** One read sent out: the geometry it was for, and the way to call it off (absent once settled). */
export interface ReadSlot { key: string; ctl?: AbortController }

interface AutoReadDeps {
  canvasRef: RefObject<HTMLCanvasElement>;
  imgRef: MutableRefObject<ImageBitmap | HTMLImageElement | HTMLCanvasElement | null>;
  setShapes: (fn: (prev: Shape[]) => Shape[]) => void;
  genRef: MutableRefObject<number>;
  readsRef: MutableRefObject<Map<number, ReadSlot>>;
}

export function autoReadActions(d: AutoReadDeps) {
  const { canvasRef, imgRef, setShapes, genRef, readsRef } = d;

  const patch = (id: number, fn: (s: Shape) => Shape) => setShapes((prev) => prev.map((s) => (s.id === id ? fn(s) : s)));

  function abort(id: number) {
    readsRef.current.get(id)?.ctl?.abort();
    readsRef.current.delete(id);
  }

  /** Every read out, called off: the picture changed or the sheet closed. */
  function abortAll() {
    for (const id of [...readsRef.current.keys()]) abort(id);
  }

  /** The marks as they stand now: start what needs reading, call off what no longer does. */
  function sync(shapes: readonly Shape[], reader: ImageTextReader | null) {
    const known = new Map([...readsRef.current].map(([id, r]) => [id, r.key]));
    const { start, abort: drop } = planReads(shapes, known, !!reader);
    for (const id of drop) {
      const wasReading = !!readsRef.current.get(id)?.ctl;
      abort(id);
      if (wasReading) patch(id, (s) => (s.reading ? { ...s, reading: false } : s));
    }
    if (!reader) return;
    for (const m of start) void readOne(m, shapes, reader);
  }

  async function readOne(m: ReadMark, shapes: readonly Shape[], reader: ImageTextReader) {
    abort(m.id);
    const ctl = new AbortController();
    const slot: ReadSlot = { key: readKey(m), ctl };
    readsRef.current.set(m.id, slot);
    const gen = genRef.current;
    // Words the phone read for the OLD geometry describe somewhere else now: gone until re-read.
    patch(m.id, (s) => ({ ...s, reading: true, readErr: undefined, ...(s.readBy === "phone" ? { read: undefined, readBy: undefined } : {}) }));
    const timer = setTimeout(() => ctl.abort(), READ_TIMEOUT_MS);
    let words: string | null = null;
    let why = "no words found in this mark";
    try {
      const crop = await cropFor(m, shapes);
      if (!crop) why = "this mark is too small to read";
      else words = cleanRead(await untilAborted(reader.read(crop, { signal: ctl.signal }), ctl.signal));
    } catch {
      why = ctl.signal.aborted ? `not read within ${READ_TIMEOUT_MS / 1000} s` : "this phone could not read it";
    } finally {
      clearTimeout(timer);
    }
    // Called off (deleted, re-read for new geometry, typed over) or another picture: lands nowhere.
    if (readsRef.current.get(m.id) !== slot || genRef.current !== gen) return;
    slot.ctl = undefined;
    patch(m.id, (s) => {
      if (s.readBy === "hand") return { ...s, reading: false };
      return words ? { ...s, reading: false, read: words, readBy: "phone", readErr: undefined } : { ...s, reading: false, read: undefined, readBy: undefined, readErr: why };
    });
  }

  /** The mark's area of the clean picture, blurs applied, enlarged, as PNG. Null: nothing to read. */
  async function cropFor(m: ReadMark, shapes: readonly Shape[]): Promise<Blob | null> {
    const canvas = canvasRef.current, img = imgRef.current;
    if (!canvas || !img) return null;
    const self = shapes.find((s) => s.id === m.id);
    const r = readCropRect(m, canvas.width, canvas.height, baseWidth(canvas) * 5 * (self?.factor ?? 1));
    if (!r) return null;
    let src: CanvasImageSource = img;
    const blurs = shapes.filter((s) => s.tool === "blur");
    if (blurs.length) {
      const full = document.createElement("canvas");
      full.width = canvas.width;
      full.height = canvas.height;
      const fctx = full.getContext("2d");
      if (!fctx) return null;
      fctx.drawImage(img, 0, 0);
      for (const b of blurs) drawShape(fctx, full, img, b);
      src = full;
    }
    const k = readScale(r.w, r.h);
    const out = document.createElement("canvas");
    out.width = Math.max(1, Math.round(r.w * k));
    out.height = Math.max(1, Math.round(r.h * k));
    const octx = out.getContext("2d");
    if (!octx) return null;
    octx.imageSmoothingEnabled = true;
    octx.imageSmoothingQuality = "high";
    octx.drawImage(src, r.x, r.y, r.w, r.h, 0, 0, out.width, out.height);
    return encodeCanvas(out, "image/png");
  }

  return { sync, abortAll };
}

/** A reader that ignores its signal still cannot hold the mark past an abort. */
function untilAborted<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error("aborted"));
  return new Promise<T>((res, rej) => {
    const off = () => rej(new Error("aborted"));
    signal.addEventListener("abort", off, { once: true });
    p.then((v) => { signal.removeEventListener("abort", off); res(v); }, (e) => { signal.removeEventListener("abort", off); rej(e); });
  });
}
