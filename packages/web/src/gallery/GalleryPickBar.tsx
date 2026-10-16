import { Layers, X } from "lucide-react";
import { pickText } from "./galleryPick";
import type { GalleryModel } from "./useGallery";

/** Combine: pick pictures in order, then the collage sheet and the annotator. A mode with its own
 *  bar that says what a tap does now; Combine is drawn only once there are two to combine (the bar
 *  says why when there are not), never dimmed. */
export function GalleryPickBar({ m }: { m: GalleryModel }) {
  const { picked, canPick, startPick, cancelPick, combinePicked } = m;
  if (!picked) {
    if (!canPick) return null;
    return (
      <div className="annot-tools gallery-pick">
        <button className="key" aria-label="pick pictures to combine" onClick={startPick}><Layers size={14} /> combine pictures…</button>
      </div>
    );
  }
  return (
    <div className="annot-tools gallery-pick on">
      <span className="viewer-doc-note">{pickText(picked.length)}</span>
      <button className="key" onClick={cancelPick}><X size={14} /> cancel</button>
      {picked.length >= 2 && (
        <button className="send" onClick={combinePicked}><Layers size={14} /> combine {picked.length}</button>
      )}
    </div>
  );
}
