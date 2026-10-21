import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, Pencil, X } from "lucide-react";
import { ZoomableImage } from "./ZoomableImage";
import { DownloadButton } from "./DownloadButton";
import { Button } from "./kit/Button";

/** One browsable item — enough to render it and to act on it (annotate / ref). */
export interface SwipeItem {
  name: string;
  relPath: string;
  /** What to render — a screen-sized copy when the host can make one. */
  url: string;
  /** The original bytes, behind the "full res" tap. Omit when `url` already is it. */
  fullUrl?: string;
  video?: boolean;
  /** Which repo it belongs to — only set for ad-hoc lists (a file mention opened
   *  from the reader), where the caller can't look the item up again. */
  repoId?: string;
}

interface Props {
  items: SwipeItem[];
  index: number;
  onIndex: (i: number) => void;
  /** Open the current image in the annotator (mark & send). Omitted when there
   *  is nothing to mark ON the host — a picture that exists only as this
   *  phone's own bytes has no repo copy for the marked one to replace, and a
   *  button that can only fail is worse than no button. */
  onAnnotate?: (item: SwipeItem) => void;
  /** Insert the current path into the compose box. */
  onReference: (item: SwipeItem) => void;
  onClose: () => void;
}

/**
 * Full-screen viewer for a KNOWN list of images (the new-image strip), so a batch
 * of agent screenshots can be swiped through instead of open-close-open per file.
 * Swipe/arrow-key steps the list; pinch, double-tap zoom come from ZoomableImage.
 * The gallery grid has the same viewer built into it (same zoom stage).
 */
export function ImageSwiper({ items, index, onIndex, onAnnotate, onReference, onClose }: Props) {
  const cur = items[index];

  // Per-image opt-in to the original file. Reset on every step, so swiping a
  // batch never silently pulls full-size bytes for images you only glanced at.
  const [fullRes, setFullRes] = useState(false);
  useEffect(() => { setFullRes(false); }, [index]);
  // Step within bounds — no wrap-around, so a swipe at the end can't silently
  // jump back to the first image and look like nothing happened.
  const nav = (dir: 1 | -1) => {
    const next = index + dir;
    if (next >= 0 && next < items.length) onIndex(next);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight") nav(1);
      else if (e.key === "ArrowLeft") nav(-1);
      // preventDefault: answered here, so `core/layout/escape.ts` adds no second Back.
      else if (e.key === "Escape") { e.preventDefault(); onClose(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // The list can shrink under us (images dismissed while open).
  useEffect(() => { if (!cur) onClose(); }, [cur, onClose]);
  if (!cur) return null;

  return (
    <div className="viewer" onClick={onClose}>
      <button className="viewer-close" onClick={onClose} aria-label="close"><X size={22} /></button>
      <div className="viewer-body" onClick={(e) => e.stopPropagation()}>
        {cur.video
          ? <video key={cur.relPath} className="viewer-video" src={cur.url} controls autoPlay playsInline />
          : <ZoomableImage key={`${cur.relPath}:${fullRes ? "full" : "fit"}`} src={fullRes && cur.fullUrl ? cur.fullUrl : cur.url} alt={cur.name} onNav={items.length > 1 ? nav : undefined} />}
        <div className="viewer-path mono">{cur.relPath}</div>
        <div className="sheet-actions">
          {items.length > 1 && (
            <>
              <Button onClick={() => nav(-1)} disabled={index === 0} aria-label="previous"><ChevronLeft size={16} /></Button>
              <span className="viewer-count">{index + 1} / {items.length}</span>
              <Button onClick={() => nav(1)} disabled={index === items.length - 1} aria-label="next"><ChevronRight size={16} /></Button>
            </>
          )}
          {!cur.video && cur.fullUrl && cur.fullUrl !== cur.url && !fullRes && (
            <Button title="load the original file instead of the screen-sized copy" onClick={() => setFullRes(true)}>full res</Button>
          )}
          {!cur.video && onAnnotate && <Button onClick={() => onAnnotate(cur)}><Pencil size={16} /> mark</Button>}
          {/* Keeping a picture used to be impossible from here: the viewer could
              show it and mark it, and the only way at the file itself was to find
              it again in the gallery. Shown only for a HOST file — an item
              rendered from this phone's own bytes has nothing to fetch. */}
          {cur.repoId && (
            <DownloadButton target={{ repoId: cur.repoId, relPath: cur.relPath, name: cur.name }} trackId="action:swipe.download" />
          )}
          <button className="send" onClick={() => onReference(cur)}>ref path</button>
        </div>
      </div>
    </div>
  );
}
