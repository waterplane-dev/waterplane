import { SlidersHorizontal, ZoomIn } from "lucide-react";
import { SheetHead } from "./Sheet";
import { AnnBars } from "./annotator/AnnBars";
import { AnnSendBar } from "./annotator/AnnSendBar";
import { AnnStage } from "./annotator/AnnStage";
import type { AnnotatorProps } from "./annotator/annTypes";
import { useAnnotator } from "./annotator/useAnnotator";

export type { AnnDispatch, AnnSend, AnnSource } from "./annotator/annTypes";

/**
 * Mark an image (red/colored circle, rectangle, arrow, or text) so the agent
 * knows where to look, then upload the flattened copy to the repo inbox.
 * Supports pinch-zoom/pan for precise marks. Works on picked files and on
 * existing repo/agent images (loaded by URL).
 *
 * The composer: `useAnnotator` holds every hook, the regions draw the model
 * (docs/notes/charts-architecture.md).
 */
export function ImageAnnotator(props: AnnotatorProps) {
  const m = useAnnotator(props);
  const { view, fitRef, zoomed, resetZoom, configOpen, setConfigOpen } = m;
  const { index, total, onClose } = props;
  return (
    <div className="sheet">
      <SheetHead onClose={onClose}
        title={total && total > 1 ? `Mark & send · ${index ?? 1}/${total}` : "Mark & send image"}>
        <button className={`key ${zoomed ? "active" : ""}`} onClick={resetZoom} title="reset zoom" aria-label="reset zoom"><ZoomIn size={16} /> {(view.k / (fitRef.current.k || 1)).toFixed(1)}×</button>
        <button className={`key ${configOpen ? "active" : ""}`} onClick={() => setConfigOpen((v) => !v)} aria-pressed={configOpen}
          title="customize the toolbar" aria-label="customize the toolbar"><SlidersHorizontal size={16} /></button>
      </SheetHead>

      <AnnStage m={m} />

      <AnnBars m={m} />
      <AnnSendBar m={m} />
    </div>
  );
}
