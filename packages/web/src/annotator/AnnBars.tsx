/**
 * The bar under the picture: crop, hand-edited words, the label, move/knob hints, the band's reading, errors.
 *
 * Moved out of `ImageAnnotator.tsx` (docs/notes/charts-architecture.md); the sheet's behaviour is
 * unchanged and `ImageAnnotator.tsx` composes it.
 *
 * A region: it draws the model and owns no hook (a child's effects run before its parent's).
 */

import { X } from "lucide-react";
import { knobHint } from "../annKnobs";
import type { AnnModel } from "./useAnnotator";

export function AnnBars({ m }: { m: AnnModel }) {
  const { tool, shapes, moveMode, selected, target, setTarget, moveNote, knobs, err, cropMode, pendingCrop, pendingText, textDraft, setTextDraft, textInputRef, editRead, setEditRead, readDraft, setReadDraft, readInputRef, lastBand, applyCrop, toggleCrop, commitText, cancelText, readBand, startEditRead, commitRead, dropRead, hintHidden, hideHint } = m;
  return (
    <>
      {cropMode ? (
        <div className="annot-crop-bar">
          <span className="annot-hint">{pendingCrop ? `crop to ${Math.round(pendingCrop.w)}×${Math.round(pendingCrop.h)}` : "drag a box to crop"}</span>
          <button className="send" disabled={!pendingCrop} onClick={applyCrop}>Apply crop</button>
          <button className="key" onClick={toggleCrop}>cancel</button>
        </div>
      ) : editRead != null ? (
        <div className="annot-crop-bar">
          <input className="search annot-text-in" ref={readInputRef} value={readDraft}
            placeholder="the highlighted words" aria-label="the highlighted words"
            onChange={(e) => setReadDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commitRead(); } }} />
          <button className="send" onClick={commitRead}>Use</button>
          <button className="key" onClick={() => { setEditRead(null); setReadDraft(""); }}>cancel</button>
        </div>
      ) : pendingText ? (
        <div className="annot-crop-bar">
          <input className="search annot-text-in" ref={textInputRef} value={textDraft}
            placeholder="label text" aria-label="label text"
            onChange={(e) => setTextDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commitText(); } }} />
          <button className="send" disabled={!textDraft.trim()} onClick={commitText}>Place</button>
          <button className="key" onClick={cancelText}>cancel</button>
        </div>
      ) : moveMode && selected != null && shapes[selected] && knobs ? (
        <div className="annot-hint">{moveNote ?? knobHint(shapes[selected].tool)}</div>
      ) : moveMode && selected != null && shapes[selected] ? (
        shapes[selected].tool === "text" ? (
          <div className="annot-hint">Drag anywhere to move the label — from beside the picture too.</div>
        ) : (
          // The mode chip IS the move/resize declaration the user asked for —
          // not a second on-canvas handle. It only matters for a drag that
          // starts off the mark (annMove.ts's "relative" grab); a direct drag
          // on a visible end dot always reshapes that end regardless of it.
          <div className="annot-crop-bar">
            <button className={`key ${target === null ? "active" : ""}`} onClick={() => setTarget(null)} aria-pressed={target === null}>whole</button>
            <button className={`key ${target === 0 ? "active" : ""}`} onClick={() => setTarget(0)} aria-pressed={target === 0}>{shapes[selected].tool === "arrow" ? "tail" : "A"}</button>
            <button className={`key ${target === 1 ? "active" : ""}`} onClick={() => setTarget(1)} aria-pressed={target === 1}>{shapes[selected].tool === "arrow" ? "head" : "B"}</button>
            <span className="annot-hint">{moveNote ?? "Drag anywhere — the finger needn't be on the mark · pinch to zoom for finer steps"}</span>
          </div>
        )
      ) : hintHidden ? null : (
        <div className="annot-hint annot-hint-x">
          <span>{moveMode
            ? "Tap a mark to select it"
            : tool === "text"
              ? "Tap where the label goes, then type it · two fingers pinch-zoom & pan"
              : tool === "marker"
                ? "Swipe along a line of text · the host reads the words and sends them with the mark"
                : "One finger draws, from beside the picture too · two fingers pinch-zoom & pan · crop trims the image"}</span>
          <button className="key" onClick={hideHint} aria-label="hide this hint for good"><X size={14} aria-hidden /></button>
        </div>
      )}
      {/* What the agent will be told this band says — shown BEFORE anything is
          sent, because a transcription nobody checked is a sentence the prompt
          asserts. It is editable for the same reason, and its failures are
          words, not a spinner that never stops. */}
      {lastBand && !cropMode && pendingText == null && editRead == null && (
        <div className="annot-read">
          {lastBand.reading ? (
            <span className="annot-hint">reading the highlighted words…</span>
          ) : lastBand.read ? (
            <>
              <span className="annot-hint annot-read-text">reads: “{lastBand.read}”</span>
              <button className="key" onClick={() => startEditRead(lastBand)}>edit</button>
              <button className="key" onClick={() => dropRead(lastBand)}>drop</button>
            </>
          ) : (
            <>
              <span className="annot-hint">{lastBand.readErr ?? "no words read — the mark still says where to look"}</span>
              <button className="key" onClick={() => void readBand(lastBand)}>read again</button>
              <button className="key" onClick={() => startEditRead(lastBand)}>type it</button>
            </>
          )}
        </div>
      )}
      {err && <div className="err">{err}</div>}
    </>
  );
}
