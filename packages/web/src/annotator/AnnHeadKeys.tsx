/**
 * The annotator head's keys: zoom (and its reset), the toolbar's customizer,
 * and — on a desktop window where the annotator sits BESIDE the session — the
 * full-screen key, which lays the same column over the whole window and back
 * (`besideRoom.ts`'s `besideFull`; an overlay, never a remount, so the marks
 * survive the switch).
 *
 * Beside the session it also offers the picture to the compose bar's Send
 * (`offerPicture`), which asks whether it goes along.
 *
 * A region: it draws the model and owns no state of its own.
 */
import { useEffect } from "react";
import { Maximize2, Minimize2, SlidersHorizontal, ZoomIn } from "lucide-react";
import { besideFull, offerPicture, useBesideFull, useBesideRoom } from "../besideRoom";
import type { AnnModel } from "./useAnnotator";

export function AnnHeadKeys({ m }: { m: AnnModel }) {
  const { view, fitRef, zoomed, resetZoom, configOpen, setConfigOpen } = m;
  const room = useBesideRoom();
  const full = useBesideFull();
  // Only the session flow is ever drawn beside the session.
  const beside = room && !!m.props.onDispatch;
  // Beside the session, the compose bar's Send may take this picture along.
  const { send } = m;
  useEffect(() => (beside ? offerPicture((mode) => void send(mode)) : undefined), [beside, send]);
  return (
    <>
      <button className={`key ${zoomed ? "active" : ""}`} onClick={resetZoom} title="reset zoom" aria-label="reset zoom"><ZoomIn size={16} /> {(view.k / (fitRef.current.k || 1)).toFixed(1)}×</button>
      <button className={`key ${configOpen ? "active" : ""}`} onClick={() => setConfigOpen((v) => !v)} aria-pressed={configOpen}
        title="customize the toolbar" aria-label="customize the toolbar"><SlidersHorizontal size={16} /></button>
      {beside && (
        <button className={`key ${full ? "active" : ""}`} onClick={() => besideFull.set(!full)} aria-pressed={full}
          title={full ? "back beside the session (Esc)" : "full screen — the session stays where it is"}
          aria-label={full ? "exit annotator full screen" : "annotator full screen"}>
          {full ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
        </button>
      )}
    </>
  );
}
