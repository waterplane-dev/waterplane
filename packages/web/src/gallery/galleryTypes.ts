import { BRAND, type RepoTarget } from "@waterplane/shared";
import type { ArtifactKind, FileEntry } from "../api";

export interface GalleryProps {
  /** Active repo context. Omit when opened from the overview (all-repos search). */
  repoId?: string;
  /** Visible repos to scope an all-repos search to (respects the hidden-repo filter). */
  repos?: RepoTarget[];
  /** Tab to open on (e.g. "outbox" when launched from the unread badge). */
  initialScope?: "inbox" | "outbox" | "repo" | "all";
  /** Drop the tab's default time window. Set when opened from an unread COUNT:
   *  that count is "since you last looked", which is routinely older than the
   *  outbox's 4h default — filtering it away is how a badge saying 42 opens on
   *  an empty grid. */
  initialAllTime?: boolean;
  /**
   * The badge's own EDGE and its number: open showing exactly the files it
   * counted, and say so.
   *
   * `initialAllTime` got the grid to stop being empty, which was the urgent
   * half. It did not make the number true: "42" then opened every outbox file
   * this repo has ever held, newest first, with the 42 somewhere at the top and
   * nothing marking where they stop. A count on a control is a filter, and a
   * filter needs the edge the count was taken at.
   */
  initialNew?: { since: number; count: number };
  /** Open straight into the VIEWER on this file, with the grid behind it.
   *  What a tapped notification about an outbox drop does: the file is already
   *  named in the alert, so making you find it again in a grid is a second
   *  search for something you were just handed. The row is rendered from this
   *  payload alone — no listing has to have landed, which is the point on a
   *  cold start over a bad tunnel. */
  openFile?: { repoId: string; relPath: string; name: string; size?: number; mtime?: number };
  onInsertPath: (relPath: string) => void;
  onAnnotate: (url: string, name: string, repoId: string) => void;
  /** Combine picked pictures into one and mark it (collage sheet, annotator), in TAP order. Absent ⇒ no pick control. */
  onCombine?: (items: { url: string; name: string; repoId: string }[]) => void;
  /** Pull this file into a coding session and seed its path: the live session
   *  `sessionId` the person picked, or a new one in the file's repo when null.
   *  Omitted when the gallery is feeding the backlog draft. */
  onContinueInSession?: (relPath: string, repoId: string, sessionId: string | null) => void;
  /** The live sessions in a repo, for the viewer's *to session* picker. */
  sessionsIn?: (repoId: string) => { id: string; label: string; onScreen: boolean }[];
  /**
   * Clear out old files in the transport directory currently on screen.
   *
   * Offered only for `inbox`/`outbox` and only in a single repo, because those
   * are the two directories a sweep may touch (`files.ts deleteArtifact`'s
   * guard) — "this repo" is a whole worktree and "all repos" has no single
   * outbox. It hands over the tab you are LOOKING at: clearing the outbox from
   * the inbox tab is a different decision from the one that was asked for.
   */
  onSweep?: (scope: "inbox" | "outbox") => void;
  /**
   * Open the cross-repo storage survey — the answer to the question this
   * toolbar could not answer on the "all repos" scope.
   *
   * `clear out…` is drawn only on a single repo's transport scopes, because
   * those are the only directories a sweep may touch. On "all repos" there was
   * therefore nothing at all, which is precisely the scope somebody is on when
   * the question is *which* repo is holding the gigabytes.
   */
  onSurvey?: () => void;
  onClose: () => void;
}

export type Scope = "inbox" | "outbox" | "repo" | "all";
/** A row in the grid — a file plus, for all-repos hits, its owning repo. */
export type Row = FileEntry & { repoId?: string; repoName?: string };

/** The time toggles. None lit = all time, so there is no "All" chip: a second chip spelled
 *  "all" beside the kind row's was two answers to two questions under one word. */
export const SINCE: { label: string; long: string; secs: number }[] = [
  { label: "10m", long: "10 minutes", secs: 600 },
  { label: "4h", long: "4 hours", secs: 14400 },
  { label: "24h", long: "24 hours", secs: 86400 },
];

/** Default time window per scope: outbox → last 4h, everything else → All time. */
export function defaultSince(scope: Scope): number | undefined {
  return scope === "outbox" ? 14400 : undefined;
}

/** The kind toggles. None lit = `all`, which is therefore not a chip of its own. */
export const KINDS: { label: string; value: Exclude<ArtifactKind, "all"> }[] = [
  { label: "images", value: "image" },
  { label: "docs", value: "doc" },
];

/** Bytes of a text artifact fetched for inline preview. Beyond this the tail is
 *  dropped (with a note) — a phone doesn't want a 10 MB log in the DOM, and the
 *  download button is right there for the whole thing. */
export const PREVIEW_MAX = 400_000;

/** Grid rows fetched per page. The host still walks the whole tree (cheap, local)
 *  but only the newest PAGE rows are sent, and only their thumbnails are pulled.
 *  Before this the grid asked for 300 rows and pointed an <img> at each original
 *  file — measurably >100 MB for one outbox scroll. */
export const PAGE = 60;

/** Files smaller than this are served whole even when a thumb is requested, so
 *  offering "full res" for them would be a no-op button. */
export const THUMB_MIN_BYTES = 48 * 1024;

/** Rows whose thumbnail is warmed into this device's cache as soon as a LIVE
 *  listing lands, whether or not they were ever drawn (thumbCache.ts).
 *  Deliberately about a screenful: the grid loads its pictures lazily, so
 *  without this the offline grid holds exactly what happened to scroll past the
 *  viewport — and a gallery you opened, glanced at and closed would come back
 *  on the train as a page of grey boxes. */
export const THUMB_WARM = 24;

// The badge's own wording used to live here, in a fourth table — and it said
// "already downloaded to this phone" for a record whose bytes had been evicted
// weeks ago. It is `downloadStatus()` now, the same sentence the button under
// the file says (`downloadState.ts`), so the grid and the viewer cannot
// disagree about where a file is.

/** Hover/long-press text for the grid badges. */
export const MARK_TITLE: Record<string, string> = {
  new: "new — not opened on this device yet",
  opened: `opened in ${BRAND.name} on this device`,
  downloaded: "downloaded to this phone",
};

/** "created" timestamp, falling back to mtime. Compact relative for recent, else date. */
export function fmtCreated(ms: number): string {
  if (!ms) return "";
  const diff = Date.now() - ms;
  const min = Math.floor(diff / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = new Date(ms);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
export function fmtCreatedFull(ms: number): string {
  return ms ? new Date(ms).toLocaleString() : "";
}
