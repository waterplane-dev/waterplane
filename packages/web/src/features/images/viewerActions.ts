/**
 * The images feature's viewer and its "new N" strip: opening a picture or a
 * tapped file mention full-screen, the cold-start route, and the per-session
 * strip of what a turn produced. The annotator-bound buttons stay in actions.ts.
 */
import type { NewImage } from "@waterplane/shared";
import type { Overlay } from "../../routing";
import type { AttachOpenDetail } from "../../attachments";
import { localPreview } from "../../attachments";
import { api } from "../../api";
import { ensureMtime, knownMtime } from "../../fileMtime";
import { sized, viewerWidth } from "../../media";
import type { SwipeItem } from "../../ImageSwiper";
import { core } from "../../sdk";
import { ann, galleryCtx, minimizedNewImg, newImages, swipe } from "../../features/images/store";
import {
  dropStrip, findInStrips, newFilesToast, viewableStrip, galleryCtxForFile, isVideoPath, isViewable, mergeNewImages,
  type NewImg, type SwipeState,
} from "../../features/images/logic";
import { goTo, insertPath } from "./navActions";

// ── Seeding (App, once) ──────────────────────────────────────────────

/** One ad-hoc viewer row for a repo-relative file. */
function swipeRow(repoId: string, relPath: string): SwipeItem {
  const url = api.artifactUrl(repoId, relPath);
  const video = isVideoPath(relPath);
  // Versioned when this device has seen the file's mtime (fileMtime.ts) — the
  // viewer opened from a tapped mention would otherwise be the one screen whose
  // picture no cache is allowed to keep. `ensureMtime` learns it for next time.
  ensureMtime(repoId, relPath);
  const mtime = knownMtime(repoId, relPath);
  return { name: relPath.split("/").pop() || relPath, relPath, url: video ? url : sized(url, viewerWidth(), mtime), fullUrl: url, video, repoId };
}

/**
 * The cold-start route: a notification tap that encoded a picture (→ the
 * viewer) or a file the viewer renders (→ the gallery, straight on it). App
 * calls this with its first `parseHash()`, before the first render reads
 * a sheet. The strip is persisted, so a cold start can still open the picture
 * at its place in that session's batch and swipe the rest. Once per page:
 * App calls it in render, and every render after the first is a no-op.
 */
let seeded = false;
export function seedFromRoute(r: { image?: { repoId: string; relPath: string }; file?: { repoId: string; relPath: string; name?: string; mtime?: number } }, fileViewable: boolean): void {
  if (seeded) return;
  seeded = true;
  if (r.image) {
    const hit = findInStrips(newImages.get(), r.image);
    swipe.set(hit ?? { items: [swipeRow(r.image.repoId, r.image.relPath)], repoId: r.image.repoId, i: 0 });
  }
  if (r.file && fileViewable) galleryCtx.set(galleryCtxForFile(r.file));
}

/** The viewer's state, with the object URL it drew from released the moment it
 *  lets go of it — on close, on a swap to another file, alike. Keyed on the
 *  URL so no exit from the viewer can be the one that leaks. */
export function setSwipe(next: SwipeState | null | ((cur: SwipeState | null) => SwipeState | null)): void {
  const prev = swipe.get()?.revoke;
  swipe.set(next);
  const now = swipe.get()?.revoke;
  if (prev && prev !== now) URL.revokeObjectURL(prev);
}

// ── The viewer ───────────────────────────────────────────────────────

/** Open an agent-produced image FULL-SCREEN (notification tap, cold-tap route,
 *  service-worker message). Viewing is what a "new screenshot" tap means; the
 *  viewer's `mark` button opens the annotator (and its send puts the marked copy
 *  back in `.claude/inbox`), so the previous straight-to-annotator jump only
 *  ever cost a step. When the file is part of a session's new-image batch, the
 *  whole batch is swipeable from it. */
export function viewImage(im: { repoId: string; relPath: string }, sessionId?: string): void {
  const hit = findInStrips(newImages.get(), im, sessionId);
  ann.set(null);
  setSwipe(hit ?? { items: [swipeRow(im.repoId, im.relPath)], repoId: im.repoId, i: 0 });
  core().nav.open("swipe");
}
/** Tap on a row's new-image COUNT: the same full-screen batch, from the first
 *  one. The launcher row has no thumbs to aim at — the badge is the only thing
 *  there that says the pictures exist, so it has to be the way into them. */
export function openNewImages(sessionId: string): void {
  core().say.track("action:newimg.open");
  setSwipe({ sessionId, i: 0 });
  core().nav.open("swipe");
}
/** Tap on a strip thumb: open the session's new images full-screen, starting at
 *  this one, so the batch can be swiped through instead of open-close-open. */
export function browseNewImages(sessionId: string, im: NewImg): void {
  core().say.track("action:newimg.open");
  const items = viewableStrip(newImages.get().get(sessionId) ?? []);
  setSwipe({ sessionId, i: Math.max(0, items.findIndex((x) => x.relPath === im.relPath)) });
  core().nav.open("swipe");
}
/** Tap on an `.claude/inbox` / `.claude/outbox` path mentioned in the reader
 *  view, or on a file a queued prompt names. Images (and videos) open in the
 *  full-screen viewer; everything else opens in the GALLERY's document viewer
 *  (`openArtifact`'s surface) — markdown rendered, text shown, and a download
 *  one tap away inside it for what has no preview. It used to download
 *  straight away, so tapping `.claude/outbox/plan.md` in a reply saved a file
 *  instead of showing it; before that it opened a tab, which in the Android
 *  shell opens nothing at all. `back` is the screen to return to when the
 *  viewer closes: the reader is not an overlay and passes none, a sheet passes
 *  its own, or the tap would close the sheet the file was tapped in. */
export function openFileRef(repoId: string, relPath: string, back?: Overlay): void {
  core().say.track("action:read.fileref");
  if (isViewable(relPath)) {
    setSwipe({ items: [swipeRow(repoId, relPath)], repoId, i: 0, back });
    core().nav.open("swipe");
    return;
  }
  // Not `openArtifact`: that counts a notification tap when handed no return.
  galleryCtx.set(galleryCtxForFile({ repoId, relPath }, back));
  core().nav.open("gallery");
}

/**
 * A file a queued prompt names, opened from wherever that prompt is shown
 * (`AttachStrip` → `requestAttachOpen`).
 *
 * Two copies can answer and they are not interchangeable. On the host it is the
 * ordinary viewer — screen-sized, full-res behind a tap, annotatable. Off it,
 * the only bytes that exist are this phone's own (a queued upload, or one kept
 * after the upload died), and those are precisely the pictures with no other
 * route to them: not in the gallery, not at any URL, gone the moment the ledger
 * drops them. So they open too, from a blob this state owns.
 */
export function onAttachOpen(d: AttachOpenDetail): void {
  const back = core().nav.overlay;
  if (d.state === "host" && d.repoId) { openFileRef(d.repoId, d.relPath, back); return; }
  void localPreview(d.relPath, d.state, [...core().queue.entries]).then((url) => {
    if (!url) { core().say.toast("no copy of this file on this phone"); return; }
    core().say.track("action:attach.openlocal");
    setSwipe({
      items: [{ name: d.relPath.split("/").pop() || d.relPath, relPath: d.relPath, url, repoId: d.repoId ?? undefined }],
      repoId: d.repoId ?? undefined, i: 0, back, revoke: url,
    });
    core().nav.open("swipe");
  });
}

/** The viewer's close: back to the screen it was opened from. */
export function closeSwipe(): void {
  const back = swipe.get()?.back ?? null;
  goTo(back);
  setSwipe(null);
}
// ── The "new N" strip ────────────────────────────────────────────────

/** `session.images`: the files this turn produced join the session's strip,
 *  which unfolds if it was minimized — they are news. */
export function onSessionImages(sessionId: string, repoId: string, images: readonly NewImage[]): void {
  newImages.set((prev) => mergeNewImages(prev, sessionId, repoId, images));
  restoreNewImages(sessionId);
  core().say.toast(newFilesToast(images));
}
/** Reference a new image by path in the compose box without annotating. */
export function referenceNewImage(im: NewImg): void {
  core().say.track("action:newimg.ref");
  insertPath(im.relPath);
}
export function dismissNewImages(sessionId: string): void {
  newImages.set((prev) => dropStrip(prev, sessionId));
  restoreNewImages(sessionId);
}
/** Fold the strip down to its "new N" pill without losing the images —
 *  unlike `dismissNewImages`, which deletes them. */
export function minimizeNewImages(sessionId: string): void {
  minimizedNewImg.set((prev) => (prev.has(sessionId) ? prev : new Set(prev).add(sessionId)));
}
export function restoreNewImages(sessionId: string): void {
  minimizedNewImg.set((prev) => { if (!prev.has(sessionId)) return prev; const n = new Set(prev); n.delete(sessionId); return n; });
}
