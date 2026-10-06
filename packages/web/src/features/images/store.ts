/**
 * The images feature's state, out of App. Each store is written only by
 * `actions.ts` (and the `session.images` handler, through it).
 *
 * `flow` is the one exception to "stores only": the annotator's ROUTING refs
 * (where its result goes, which repo the sheet that opened it attached into,
 * which backlog item is being re-marked). They were `useRef`s in App for the
 * reason they are plain here — nothing renders from them; they are read at the
 * moment an upload lands, and a render-cycle copy would be the stale one.
 */
import type { Overlay } from "../../routing";
import type { AnnSource } from "../../ImageAnnotator";
import type { RepoTarget } from "@waterplane/shared";
import { createStore, useStore } from "../../sdk";
import { LS, lsJson } from "../../storage";
import type { GalleryCtx, ImageReturn, NewImages, NewImg, SwipeState, SweepFor } from "./logic";

/** The picture on the annotator. `rest`/`total`/`index` drive a multi-image
 *  batch through it one by one; `facts` is what the image IS rather than what
 *  was marked on it — a collage's arrangement, which the combined picture
 *  states in pixels and nowhere else. */
export type AnnState = { source: AnnSource; repoId: string; rest?: AnnSource[]; total?: number; index?: number; facts?: string };
export const ann = createStore<AnnState | null>(null);

/** More than one image was picked, and the combine-or-not question is on
 *  screen. `separate` is the flow that WOULD have run — held as a closure so
 *  each pick site keeps its own answer (a batch through the annotator for the
 *  session/start/pad flows, a plain multi-upload for the backlog one) instead
 *  of this sheet re-deriving it from a ref and getting one of them wrong. */
export type CollageAsk = { files: File[]; repoId: string; separate: (files: File[]) => void };
export const collage = createStore<CollageAsk | null>(null);

/** New-image strip → full-screen browse. Only the position is held for a
 *  session's strip; the list is read live from `newImages`, so a dismissal or
 *  an arrival is reflected while it is open. Seeded from the route by
 *  `seedFromRoute` (a cold notification tap). */
export const swipe = createStore<SwipeState | null>(null);

/** When the gallery is opened from somewhere other than a session. */
export const galleryCtx = createStore<GalleryCtx | null>(null);

/** The sweep sheet's target; null = nothing to sweep (the sheet falls through). */
export const sweepFor = createStore<SweepFor | null>(null);

/** Repo the file tree opens on when it was picked on the LAUNCHER (`⋯` →
 *  browse files, on a repo that may have no session): `activeRepo` is derived
 *  from the ACTIVE SESSION, so without this the sheet had nothing to open on.
 *  Cleared on close, so the toolbar's own `browse` goes on meaning "the repo I
 *  am looking at". */
export const browseRepoId = createStore<string | null>(null);
/** A file the tree opens STRAIGHT into, and the screen its close returns to —
 *  set together by a sheet that names a file (the readings' longest-files
 *  tape), cleared together on close. Null back = the ordinary close. */
export const browseAim = createStore<{ file: string; back: Overlay } | null>(null);

/**
 * New images produced by sessions, keyed by session id (repo-tagged).
 *
 * Hydrated from localStorage: the host reports each artifact once (at turn end)
 * and then marks it seen, so it never re-broadcasts — and the phone reloads
 * often (the zombie-socket watchdog), which would wipe it and lose the strip for
 * ever. Written through on every change (`bootImages`).
 */
export const newImages = createStore<NewImages>(new Map(Object.entries(lsJson<Record<string, NewImg[]>>(LS.newImages, {}))));

/** Sessions whose new-image strip is folded down to its pill. In memory only —
 *  it is not a dismissal (`dismissNewImages` still deletes the whole entry), so
 *  there is nothing here worth surviving a reload. */
export const minimizedNewImg = createStore<ReadonlySet<string>>(new Set());

export const flow: {
  /** Where `afterUpload` routes the path. */
  ret: ImageReturn;
  /** Repo the next file pick targets. */
  pickRepo: string | null;
  /** The repo the open sheet attached into, read when the annotator comes back:
   *  neither a Send seed nor a pad note necessarily names one until a file is
   *  picked, and by then the sheet that knew has been unmounted. */
  sendRepo: RepoTarget | null;
  padRepo: RepoTarget | null;
  /** Editing an image a backlog item references: the item + the path being
   *  marked, so the marked result can be swapped back into the item's text. */
  backlogEdit: { id: string; oldPath: string; text: string } | null;
} = { ret: "session", pickRepo: null, sendRepo: null, padRepo: null, backlogEdit: null };

/** This session's new images, [] when none. */
export function useNewImagesOf(sessionId: string): NewImg[] {
  return useStore(newImages).get(sessionId) ?? EMPTY;
}
const EMPTY: NewImg[] = [];

/** Whether this session's strip is folded to its pill. */
export function useNewImagesMinimized(sessionId: string): boolean {
  return useStore(minimizedNewImg).has(sessionId);
}
