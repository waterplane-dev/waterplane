/**
 * ROOM FOR A COLUMN BESIDE THE SESSION — the annotator drawn next to the
 * session it is marking a picture for, so the person types the prompt while
 * marking (`core/layout/Workspace.tsx`). Wider than the workspace's own floor
 * (`WIDE_MIN_PX`, 1024) because three things share the width: the sidebar
 * (~320), a session still worth reading (~520) and an annotator worth drawing
 * on (~440). Below this the annotator takes the main pane, as before.
 *
 * Top-level, not in `core/layout`, because the images feature reads it too
 * (`local/feature-boundary`). The `layout.ts` shape: the media query is the
 * predicate, one store mirrors it, one listener writes it.
 */
import { createStore, useStore } from "./sdk/store.ts";

export const BESIDE_MIN_PX = 1280;
export const BESIDE_QUERY = `(min-width: ${BESIDE_MIN_PX}px)`;

const besideRoomStore = createStore<boolean>(false);

/**
 * The beside column, drawn over the WHOLE window for a while — the annotator's
 * full-screen key. An overlay of the same element, never a move to another
 * slot: moving it would remount the annotator and drop every mark on the
 * picture, and leaving the session where it is keeps its terminal width (no
 * resize, no repaint). Per page; a new picture starts beside again.
 */
export const besideFull = createStore<boolean>(false);
export function useBesideFull(): boolean {
  return useStore(besideFull);
}

/** True when a column beside the session fits. Implies the wide layout. */
export function useBesideRoom(): boolean {
  return useStore(besideRoomStore);
}

if (typeof window !== "undefined") {
  try {
    const mq = window.matchMedia?.(BESIDE_QUERY);
    if (mq) {
      const write = () => besideRoomStore.set(mq.matches);
      write();
      mq.addEventListener?.("change", write);
    }
  } catch { /* no matchMedia: never beside */ }
}

/**
 * The picture on the beside annotator, as something the compose bar's Send can
 * take along: with the column open, a Send in the session's box ASKS whether
 * the picture goes too (yes = the annotator's own Send & run, its marks
 * flattened in; no = the words alone, the picture stays open). Registered by
 * the annotator while it is drawn beside the session (`AnnHeadKeys`), so a
 * phone — where the box is not on screen — never asks.
 */
type PictureSend = (mode: "run" | "queue") => void;
let pictureSend: PictureSend | null = null;
export function offerPicture(fn: PictureSend): () => void {
  pictureSend = fn;
  return () => { if (pictureSend === fn) pictureSend = null; };
}
export function besidePicture(): PictureSend | null {
  return pictureSend;
}
