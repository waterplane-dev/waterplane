/**
 * "Text only" — the desktop's reading of the whole picture, editable, sent in
 * place of the picture (annOcr.ts). Replaces the marking bars while it is up;
 * the picture stays above it so the reading can be checked against it.
 *
 * A region: it draws the model and owns no hook (a child's effects run before its parent's).
 */
import { ArrowLeft, RotateCw, ScanText } from "lucide-react";
import type { AnnModel } from "./useAnnotator";
import { Button } from "../kit/Button";

export function AnnTextOnly({ m }: { m: AnnModel }) {
  const { ocr, ocrDraft, setOcrDraft, readAll, closeOcr, sendText } = m;
  if (!ocr) return null;
  const empty = !ocrDraft.trim();
  return (
    <div className="annot-ocr">
      {ocr.phase === "reading" && (
        <div className="annot-hint">Reading every word on your desktop… The photo goes no further than that machine.</div>
      )}
      {ocr.phase === "error" && <div className="annot-hint">{ocr.error}</div>}
      {ocr.phase === "ready" && (
        <div className="annot-hint">
          Read on your desktop ({ocr.engine}, {(ocr.ms / 1000).toFixed(1)} s). Fix anything misread — only this text is sent, never the photo.
        </div>
      )}
      {(ocr.phase === "ready" || !empty) && (
        <textarea className="annot-ocr-text" value={ocrDraft} onChange={(e) => setOcrDraft(e.target.value)}
          spellCheck={false} autoCapitalize="off" aria-label="text read off the picture" />
      )}
      {ocr.phase === "ready" && empty && <div className="annot-hint">Nothing left to send — read again, or go back to the picture.</div>}
      <div className="sheet-actions annot-send-bar" data-primary-key="">
        <Button onClick={closeOcr}><ArrowLeft size={14} /> picture</Button>
        {ocr.phase !== "reading" && <Button onClick={() => void readAll()}><RotateCw size={14} /> read again</Button>}
        {ocr.phase !== "reading" && !empty && (
          <button className="send" onClick={() => sendText(ocrDraft)}><ScanText size={14} /> Send text only</button>
        )}
      </div>
    </div>
  );
}
