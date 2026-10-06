import { useRef, useState } from "react";
import { useBackStep } from "../backStep";
import type { GalleryProps, Row } from "./galleryTypes";

/** The viewer's open file and the ONE writer of it (`showFile`) — see `directRef`. */
export function useGalleryOpen({ openFile, onClose }: Pick<GalleryProps, "openFile" | "onClose">) {
  // The open file, if any. Seeded from `openFile` so a notification tap lands
  // IN the viewer: the initialiser runs once, so closing the viewer leaves the
  // grid behind it rather than re-opening the same document for ever.
  const [open, setOpen] = useState<Row | null>(
    openFile
      ? { ...openFile, size: openFile.size ?? 0, mtime: openFile.mtime ?? 0, ctime: openFile.mtime ?? 0 }
      : null,
  );
  /**
   * Was this viewer opened STRAIGHT at a file, with no listing behind it?
   *
   * `openFile` is the `galleryCtxForFile` route — a notification about an
   * artifact, `AssessSheet`'s *read the plan* — where the outbox grid is
   * scenery the reader never asked for. Closing the document there used to
   * drop them INTO that grid, so the way back to the sheet they were reading
   * was a second tap through a listing that had nothing to do with it. So the
   * × on a direct open closes the whole gallery and goes back where the tap
   * came from (`returnTo`, honoured by the caller's `onClose`).
   *
   * A ref and not state: nothing renders differently for it, and a re-render
   * per close is exactly the cost this buys nothing with. It is cleared by
   * `showFile`, i.e. by ANY move of the viewer that is not this close —
   * swiping to the next image, following a markdown link, deleting an inbox
   * file — because from that moment there IS a listing behind the viewer and
   * the reader has been shown it. `showFile` is the ONE writer, so a new
   * `setOpen` call site cannot quietly opt out of the rule.
   */
  const directRef = useRef(!!openFile);
  /** Move the viewer to a file (or shut it). Everything but `closeDoc` goes
   *  through here — see `directRef`. */
  const showFile = (f: Row | null) => { directRef.current = false; setOpen(f); };
  /** Close the open document. On a direct open that means closing the gallery
   *  itself; on the ordinary browse-then-open path × still means "back to the
   *  pictures", which is the grid this viewer is sitting on top of. */
  const closeDoc = () => { if (directRef.current) { directRef.current = false; onClose(); return; } showFile(null); };
  // Back — the gesture as much as the arrow — shuts the document and leaves the
  // grid. A DIRECT open is no step: Back leaves the gallery, like its ×.
  useBackStep(open !== null && !directRef.current, () => showFile(null));
  return { open, showFile, closeDoc };
}
