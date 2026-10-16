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
import { core, useStore } from "../../sdk";
import { useBesideRoom } from "../../besideRoom";
import { ann, collage, flow, newImages, swipe } from "./store";
import {
  afterText, afterUpload, closeAnnotator, closeSwipe, collageClose, collageCombine, collageSeparate, dispatchImage,
  markFromSwipe, parkAnnotated, refFromSwipe, sendAllBatch, setSwipe, skipImage,
} from "./actions";
import { isVideoPath, viewableStrip } from "./logic";

/** More than one image picked: one picture, or several? */
export function CombineSheet() {
  const c = useStore(collage);
  if (!c) return null;
  return <CollageSheet files={c.files} onCombine={collageCombine} onSeparate={collageSeparate} onClose={collageClose} />;
}

/**
 * The annotator drawn in a column BESIDE the session it is marking a picture
 * for (`core/layout/Workspace.tsx`), so the prompt is typed while marking. Only
 * the session flow (its result lands in that session's box — a backlog or
 * gallery round trip has no box beside it to type in), only with a session on
 * screen, and only where the window has room (`useBesideRoom`).
 */
export function useAnnBeside(): boolean {
  const a = useStore(ann);
  const room = useBesideRoom();
  return room && !!a && flow.ret === "session" && !!core().world.active;
}

/** The annotator, on the picture `ann` holds. */
export function MarkUpSheet() {
  const a = useStore(ann);
  const beside = useAnnBeside();
  if (!a) return null;
  // Read at render, like App's `imageReturnRef.current`: the flow is set before
  // the sheet opens and does not change while it is up.
  const sessionFlow = flow.ret === "session";
  const batch = !!a.total && a.total > 1;
  // The session's box, edited from here when it is not on screen beside the
  // annotator. `typeOn` is the compare-and-set edit: it refuses when the box no
  // longer holds what this render showed, so nothing typed elsewhere is lost.
  const c = core();
  const prompt = sessionFlow && !beside && c.world.active ? {
    value: c.compose.draft,
    onChange: (next: string) => {
      if (!core().compose.typeOn(core().compose.draft, next)) core().say.toast("The message box changed meanwhile — that key was not applied");
    },
  } : undefined;
  return <ImageAnnotator prompt={prompt} source={a.source} repoId={a.repoId} index={a.index} total={a.total} facts={a.facts}
    onUploaded={afterUpload}
    onDispatch={sessionFlow ? dispatchImage : undefined}
    // Backlog / gallery flows upload inline inside the sheet; with no tunnel
    // that used to throw away a picture that had just been marked up.
    onPark={parkAnnotated}
    onSkip={batch ? skipImage : undefined}
    onSendAll={batch && sessionFlow ? sendAllBatch : undefined}
    onText={afterText}
    onClose={closeAnnotator} />;
}

/** The full-screen viewer: a session's new-image strip (read live, so a
 *  dismissal or an arrival shows while it is open) or an ad-hoc list. */
export function ViewerSheet() {
  const s = useStore(swipe);
  const strips = useStore(newImages);
  if (!s) return null;
  // The strip's pictures only: its markdown tiles open the reader, not this.
  const strip = s.sessionId ? viewableStrip(strips.get(s.sessionId) ?? []) : [];
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
