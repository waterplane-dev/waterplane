import { api } from "../api";
import { pickThumbWidth, sized, viewerWidth } from "../media";
import { isImage } from "../docKind";
import { THUMB_MIN_BYTES, type Row, type Scope } from "./galleryTypes";

// The pure halves of the viewer's URL helpers: what a row's repo, original,
// grid thumbnail and viewer copy are, given the tab. The hooks and the
// component close over these so the listing hook can warm thumbnails without
// reaching up into the component.

/** Resolve the repo a given row lives in (its own for all-repos hits, else context). */
export const repoOfRow = (repoId: string | undefined, f: Row) => f.repoId ?? repoId!;
/** The original file. Used for downloads, annotation and the "full res" swap. */
export const urlForRow = (scope: Scope, repoId: string | undefined, f: Row) =>
  scope === "inbox" ? api.inboxUrl(repoOfRow(repoId, f), f.name) : api.artifactUrl(repoOfRow(repoId, f), f.relPath);
/** Grid cell: a server-made thumbnail (~20 KB) instead of the original (~600 KB avg). */
export const thumbForRow = (scope: Scope, repoId: string | undefined, f: Row) =>
  sized(urlForRow(scope, repoId, f), pickThumbWidth(140), f.mtime);
/** Viewer: screen-width, not sensor-width. `fullRes` swaps in the original. */
export const viewForRow = (scope: Scope, repoId: string | undefined, fullRes: boolean, f: Row) =>
  (fullRes ? urlForRow(scope, repoId, f) : sized(urlForRow(scope, repoId, f), viewerWidth(), f.mtime));
/** Whether a "full res" offer is meaningful for this file. */
export const canFullRes = (f: Row) => isImage(f.relPath) && (f.size ?? 0) >= THUMB_MIN_BYTES;
