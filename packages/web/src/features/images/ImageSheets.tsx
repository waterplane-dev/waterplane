/**
 * The three picture sheets: the combine-or-not question (`collage`), the
 * annotator (`image`) and the full-screen viewer (`swipe`). Each is a thin
 * entry over an existing top-level component — the rules for what those draw
 * are theirs (skill `web-files`); what is here is where their taps go.
 * The manifest's render GUARDS (`index.ts`) decide whether each is on screen at
 * all; these read their store themselves so a change inside an open sheet (the
 * next picture of a batch, a swipe) re-renders it.
 */
import { CollageSheet } from "../../CollageSheet";
import { ImageAnnotator } from "../../ImageAnnotator";
import { ImageSwiper, type SwipeItem } from "../../ImageSwiper";
import { api } from "../../api";
import { sized, viewerWidth } from "../../media";
import { useStore } from "../../sdk";
import { ann, collage, flow, newImages, swipe } from "./store";
import {
  afterUpload, closeAnnotator, closeSwipe, collageClose, collageCombine, collageSeparate, dispatchImage,
  markFromSwipe, parkAnnotated, refFromSwipe, sendAllBatch, setSwipe, skipImage,
} from "./actions";
import { isVideoPath } from "./logic";

/** More than one image picked: one picture, or several? */
export function CombineSheet() {
  const c = useStore(collage);
  if (!c) return null;
  return <CollageSheet files={c.files} onCombine={collageCombine} onSeparate={collageSeparate} onClose={collageClose} />;
}

/** The annotator, on the picture `ann` holds. */
export function MarkUpSheet() {
  const a = useStore(ann);
  if (!a) return null;
  // Read at render, like App's `imageReturnRef.current`: the flow is set before
  // the sheet opens and does not change while it is up.
  const sessionFlow = flow.ret === "session";
  const batch = !!a.total && a.total > 1;
  return <ImageAnnotator source={a.source} repoId={a.repoId} index={a.index} total={a.total} facts={a.facts}
    onUploaded={afterUpload}
    onDispatch={sessionFlow ? dispatchImage : undefined}
    // Backlog / gallery flows upload inline inside the sheet; with no tunnel
    // that used to throw away a picture that had just been marked up.
    onPark={parkAnnotated}
    onSkip={batch ? skipImage : undefined}
    onSendAll={batch && sessionFlow ? sendAllBatch : undefined}
    onClose={closeAnnotator} />;
}

/** The full-screen viewer: a session's new-image strip (read live, so a
 *  dismissal or an arrival shows while it is open) or an ad-hoc list. */
export function ViewerSheet() {
  const s = useStore(swipe);
  const strips = useStore(newImages);
  if (!s) return null;
  const strip = s.sessionId ? strips.get(s.sessionId) ?? [] : [];
  const rows: SwipeItem[] = s.items ?? strip.map((im) => ({
    name: im.name,
    relPath: im.relPath,
    // Screen-sized copy for viewing; `fullUrl` is the original, behind the
    // viewer's explicit "full res" tap.
    url: isVideoPath(im.relPath)
      ? api.artifactUrl(im.repoId, im.relPath)
      : sized(api.artifactUrl(im.repoId, im.relPath), viewerWidth(), im.mtime),
    fullUrl: api.artifactUrl(im.repoId, im.relPath),
    video: isVideoPath(im.relPath),
  }));
  return <ImageSwiper items={rows} index={Math.min(s.i, Math.max(0, rows.length - 1))}
    onIndex={(i) => setSwipe((c) => (c ? { ...c, i } : c))}
    // A local-only picture (`revoke`) has no host copy to mark up, and the blob
    // it is drawn from is released the moment the viewer closes.
    onAnnotate={s.revoke ? undefined : (row) => markFromSwipe(row, strip)}
    onReference={(row) => refFromSwipe(row, strip)}
    onClose={closeSwipe} />;
}
