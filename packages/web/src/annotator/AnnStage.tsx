/**
 * The canvas stage, with the tool bar beside it: the wrapper that owns the gesture, and the canvas under the view transform.
 *
 * Moved out of `ImageAnnotator.tsx` (docs/notes/charts-architecture.md); the sheet's behaviour is
 * unchanged and `ImageAnnotator.tsx` composes it.
 *
 * A region: it draws the model and owns no hook (a child's effects run before its parent's).
 */

import { AnnConfig } from "./AnnConfig";
import { AnnToolbar } from "./AnnToolbar";
import type { AnnModel } from "./useAnnotator";

export function AnnStage({ m }: { m: AnnModel }) {
  const { canvasRef, wrapRef, bodyRef, view, onDown, onMove, onUp, place, configOpen } = m;
  return (
    // Bar and picture share one box so the bar can be a row on top or a rail
    // down the left (`.place-*`, annLayout.ts) without the gesture knowing.
    // `place` is `auto` resolved for this picture once its size is known.
    <div className={`annot-body place-${place}`} ref={bodyRef}>
      <AnnToolbar m={m} />
      {/* The gesture is the WRAPPER's, not the canvas's: a mark may start (and
          end) off the picture, which is the only way a thumb reliably encloses
          something that touches the edge. `toCanvas` answers for a point
          outside the image too, and `annClip.ts` cuts what overhangs on the way
          into `shapes`. */}
      <div
        className="annot-canvas-wrap"
        ref={wrapRef}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
      >
        <canvas
          ref={canvasRef}
          className="annot-canvas"
          style={{ transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.k})`, transformOrigin: "0 0" }}
        />
      </div>
      {configOpen && <AnnConfig m={m} />}
    </div>
  );
}
