/**
 * Gallery listings, offline.
 *
 * The grid ("Images & documents") is a pure HTTP view: every tab, kind chip and
 * time window is a request to the host, and with the tunnel down all four of
 * them answer with a spinner that never lands. That is the wrong answer twice
 * over — the phone HAS seen this listing (it painted it minutes ago, and the
 * thumbnails are still in the service worker's cache), and the files it lists
 * are the ones an agent left for you to read on a train.
 *
 * So a listing is cached, and a cached listing is re-filtered locally. Which
 * makes the rules below load-bearing, because a cache that answers the WRONG
 * question is worse than no cache: it shows files that were filtered out on
 * purpose and hides files that exist.
 *
 *  - `coversQuery` — a stored listing may only answer a question it is a
 *    superset of. An all-time listing can answer "last 4h" (filter by mtime);
 *    a 4h listing can NOT answer "all time", and an image-only listing can
 *    never answer "docs" no matter how wide its window.
 *  - `filterGalleryRows` — mirrors what the host does server-side
 *    (`files.ts discoverArtifacts`): the time window is cut on **mtime**, and
 *    the `image` kind includes VIDEO (that is the host's `kindExt`, not an
 *    oversight). The image/doc split is passed IN rather than duplicated here,
 *    so there is one extension list per side and no third one in `shared`.
 *
 * Nothing here is a source of truth: every value is last-known-good and is
 * replaced by the next live listing. Callers must LABEL rows that came from
 * here — "the newest files as of 20 minutes ago" is useful, "the newest files"
 * is a lie.
 */

export type GalleryKind = "all" | "image" | "doc";

/** What a listing (or a question) covers: a kind filter and a time window. */
export interface GalleryCoverage {
  /** Window in seconds; `undefined` = all time, the broadest there is. */
  since?: number;
  kind: GalleryKind;
}

/** The minimum of a file row the rules here need. Both `FileEntry` (web) and
 *  the host's artifact rows are structurally this. */
export interface GalleryRow {
  name: string;
  relPath: string;
  mtime: number;
}

export interface GalleryQuery extends GalleryCoverage {
  /** Name substring, matched case-insensitively — same as the host's `q`. */
  query?: string;
}

/**
 * Can `entry`'s rows answer `want` by filtering alone?
 *
 * Kind is a strict containment (`all` ⊇ image/doc, and image ⊉ doc), the window
 * is a numeric one with `undefined` as infinity. Deliberately NOT a single
 * "broadness" score: image/all-time and all-kinds/4h are incomparable, and a
 * scalar rank would happily serve one for the other.
 */
export function coversQuery(entry: GalleryCoverage, want: GalleryCoverage): boolean {
  if (entry.kind !== "all" && entry.kind !== want.kind) return false;
  if (entry.since == null) return true;               // all time covers everything
  if (want.since == null) return false;               // a window can't cover all time
  return want.since <= entry.since;
}

/**
 * The cached listing to answer `want` with, or null.
 *
 * An exact coverage match wins over a wider one (fewer rows discarded, and its
 * `truncated` flag still means what it said), and among equals the freshest
 * wins — with the link down, "saved 3 minutes ago" beats "saved yesterday" even
 * when the older one is broader.
 */
export function pickCoveringListing<T extends GalleryCoverage & { savedAt: number }>(
  entries: T[], want: GalleryCoverage,
): T | null {
  const usable = entries.filter((e) => coversQuery(e, want));
  if (!usable.length) return null;
  const exact = (e: T) => (e.kind === want.kind && e.since === want.since ? 1 : 0);
  return usable.reduce((best, e) =>
    (exact(e) !== exact(best) ? (exact(e) > exact(best) ? e : best) : e.savedAt > best.savedAt ? e : best));
}

/**
 * Apply a gallery question to rows the host already returned.
 *
 * `isImageKind` decides the image/doc split (pass the caller's own predicate —
 * on the web that is image OR video, matching the host's `kind=image`), and
 * `now` is injected so the window is testable without a clock.
 */
export function filterGalleryRows<T extends GalleryRow>(
  rows: T[], want: GalleryQuery, isImageKind: (relPath: string) => boolean, now: number,
): T[] {
  const q = (want.query ?? "").trim().toLowerCase();
  const cutoff = want.since == null ? 0 : now - want.since * 1000;
  return rows.filter((r) => {
    if (want.kind === "image" && !isImageKind(r.relPath)) return false;
    if (want.kind === "doc" && isImageKind(r.relPath)) return false;
    if (cutoff && r.mtime < cutoff) return false;
    return !q || r.name.toLowerCase().includes(q);
  });
}

/** Cache identity of one TAB: the box being listed, not what is filtered out of
 *  it. Repo-scoped tabs key on the repo; the all-repos tab keys on the repo SET,
 *  because adding a repo genuinely changes the listing. */
export function galleryScopeKey(scope: string, repoId?: string, repoKey?: string): string {
  return scope === "all" ? `all|${repoKey ?? ""}` : `${repoId ?? ""}|${scope}`;
}

/** Cache identity of one listing within a tab. A few coverages per tab is the
 *  point: incomparable ones (images-all-time, everything-4h) both earn a slot. */
export function galleryCacheKey(scopeKey: string, c: GalleryCoverage): string {
  return `${scopeKey}|${c.kind}|${c.since ?? "all"}`;
}
