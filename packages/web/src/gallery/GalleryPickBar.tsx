import { FolderTree, Layers, X } from "lucide-react";
import { pickText } from "./galleryPick";
import type { GalleryModel } from "./useGallery";
import { Button } from "../kit/Button";

/** The row over the grid: the door to the whole file tree (one repo only: all repos have no one tree),
 *  and combine. Combine: pick pictures in order, then the collage sheet and the annotator. A mode with its own
 *  bar that says what a tap does now; Combine is drawn only once there are two to combine (the bar
 *  says why when there are not), never dimmed. */
export function GalleryPickBar({ m }: { m: GalleryModel }) {
  const { picked, canPick, startPick, cancelPick, combinePicked, scope, singleRepo, since, onNewCut } = m;
  const browse = singleRepo && scope !== "all" ? m.props.onBrowse : undefined;
  if (!picked) {
    if (!canPick && !browse) return null;
    return (
      <div className="annot-tools gallery-pick">
        {browse && <Button title="browse files — every folder of this repo" onClick={() => browse({ scope, since, onNewCut })}><FolderTree size={14} /> browse files</Button>}
        {canPick && <Button aria-label="pick pictures to combine" onClick={startPick}><Layers size={14} /> combine pictures…</Button>}
      </div>
    );
  }
  return (
    <div className="annot-tools gallery-pick on">
      <span className="viewer-doc-note">{pickText(picked.length)}</span>
      <Button onClick={cancelPick}><X size={14} /> cancel</Button>
      {picked.length >= 2 && (
        <button className="send" onClick={combinePicked}><Layers size={14} /> combine {picked.length}</button>
      )}
    </div>
  );
}
