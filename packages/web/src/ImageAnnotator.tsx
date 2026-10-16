import { SheetHead } from "./Sheet";
import { useBackStep } from "./backStep";
import { AnnBars } from "./annotator/AnnBars";
import { AnnHeadKeys } from "./annotator/AnnHeadKeys";
import { AnnPrompt } from "./annotator/AnnPrompt";
import { AnnSendBar } from "./annotator/AnnSendBar";
import { AnnStage } from "./annotator/AnnStage";
import { AnnTextOnly } from "./annotator/AnnTextOnly";
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
  // Text only replaces the marking bars: Back returns to the picture (the draft stays), not out of the annotator.
  useBackStep(m.ocr !== null, m.closeOcr);
  const { index, total, onClose } = props;
  return (
    <div className="sheet">
      <SheetHead onClose={onClose}
        title={total && total > 1 ? `Mark & send · ${index ?? 1}/${total}` : "Mark & send image"}>
        <AnnHeadKeys m={m} />
      </SheetHead>

      {props.prompt && <AnnPrompt prompt={props.prompt} />}
      <AnnStage m={m} />
      {m.ocr ? <AnnTextOnly m={m} /> : <><AnnBars m={m} /><AnnSendBar m={m} /></>}
    </div>
  );
}
