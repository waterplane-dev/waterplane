/**
 * "Text only": the whole picture read on the DESKTOP (`POST /api/host/ocr`,
 * host `ocrlocal.ts`), shown for editing, and only the words sent.
 *
 * For a photo of another screen with a person in it: what the agent needs is
 * the error message, and what must not travel is the face. The picture goes to
 * the person's own desktop to be read (a tmp file, removed), never into the
 * inbox, so no agent and no cloud model is handed it.
 *
 * What is read is the FLATTENED canvas, the picture as it is on screen: a crop
 * narrows the reading to the screen in the photo, and a blur over a password
 * keeps the password out of the text too. Marks are left out of the reading
 * when there are none to draw (`redraw(true)`).
 */
import { api } from "../api";
import { track } from "../usage";
import { encodeCanvas } from "../uploadScale";
import type { RefObject, MutableRefObject, Dispatch, SetStateAction } from "react";

export type OcrState =
  | { phase: "reading" }
  | { phase: "ready"; engine: string; ms: number }
  | { phase: "error"; error: string };

export function ocrActions(c: {
  canvasRef: RefObject<HTMLCanvasElement>;
  genRef: MutableRefObject<number>;
  redraw: (plain?: boolean) => void;
  setOcr: Dispatch<SetStateAction<OcrState | null>>;
  setOcrDraft: Dispatch<SetStateAction<string>>;
  onText?: (text: string) => void;
}) {
  const { canvasRef, genRef, redraw, setOcr, setOcrDraft, onText } = c;

  async function readAll() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    track("action:image.ocr");
    const gen = genRef.current;
    setOcr({ phase: "reading" });
    redraw(true); // no selection chrome in what is read
    const blob = await encodeCanvas(canvas, "image/jpeg", 0.92);
    if (gen !== genRef.current) return; // the sheet moved on to another picture
    if (!blob) { setOcr({ phase: "error", error: "this device could not encode the picture" }); return; }
    const r = await api.ocrImage(blob);
    if (gen !== genRef.current) return;
    if ("error" in r) { setOcr({ phase: "error", error: r.error }); return; }
    setOcrDraft(r.text);
    setOcr({ phase: "ready", engine: r.engine, ms: r.ms });
  }

  /** Back to the picture. The draft is KEPT — it is typed words — and a second
   *  "text only" re-reads only when there is nothing to come back to. */
  function closeOcr() { setOcr(null); }

  function sendText(text: string) {
    const t = text.trim();
    if (!t || !onText) return;
    track("action:image.ocr.send");
    onText(t);
  }

  return { readAll, closeOcr, sendText };
}
