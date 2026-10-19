/**
 * The images feature's pure half — node-tested by `logic.test.mjs`. Nothing
 * here reads a store, the core or the DOM.
 */
import type { NewImage, SweepScope } from "@waterplane/shared";
import type { Overlay } from "../../routing";
import type { SwipeItem } from "../../ImageSwiper";

/** A file the host reported as new this turn, tagged with the repo it is in. */
export type NewImg = NewImage & { repoId: string };
/** The "new N" strip, per session id. */
export type NewImages = ReadonlyMap<string, NewImg[]>;

/** Per-session cap on the persisted strip. */
export const NEWIMG_CAP = 60;

/** Where the annotator's result goes. "send" is the Send sheet: the annotator
 *  REPLACES that sheet (one overlay at a time), so its result goes into the
 *  sheet's persisted draft and the sheet is reopened — see `annotateForSend`. */
export type ImageReturn = "session" | "backlog-item" | "send" | "pad";

/** Where the full-screen viewer is: a session's live new-image strip, or an
 *  ad-hoc list (a tapped file mention, a notification for a single file). */
export type SwipeState = {
  sessionId?: string; items?: SwipeItem[]; repoId?: string; i: number;
  /**
   * Where closing it goes back to.
   *
   * The viewer is an overlay, and an overlay REPLACES the sheet it was opened
   * from (App returns one overlay). Opened from the pad or the queue, closing to
   * null would drop the user two screens away from the row they tapped — so the
   * screen underneath is remembered rather than assumed. Null for the reader,
   * which is not an overlay at all.
   */
  back?: Overlay;
  /** An object URL this state owns (a picture that exists only on this phone).
   *  Revoked when the viewer lets go of it — see `setSwipe` in actions.ts. */
  revoke?: string;
};

/** What the gallery is opened FOR, when it is opened from somewhere other than
 *  a session: a repo, the backlog draft, a tab, a window — and one file to land
 *  straight in the viewer on. */
export type GalleryCtx = {
  repoId?: string;
  scope?: "inbox" | "outbox" | "repo" | "all";
  allTime?: boolean;
  /** The badge's own edge and number, when the gallery was opened by tapping a
   *  count. `allTime` keeps the grid from being empty; this makes the number
   *  true — the grid opens on exactly what was counted, and says so. */
  newCut?: { since: number; count: number };
  /** Overlay to return to when the gallery closes. A file opened FROM the
   *  notification feed closes back into the feed — the alert that sent you
   *  there is usually one of several. */
  returnTo?: Overlay;
  /**
   * Where *insert path* puts the path it hands back.
   *
   * `compose` (the default) is the live session's box, which is the only place
   * it ever went — and that is why "reference a picture that is already in this
   * repo" had no route at all from the send sheet. What was left was: open the
   * gallery, tap a file, rely on `copyText` (which needs a SECURE context, and
   * a plain `http://100.x` tunnel is not one), close the gallery, reopen the
   * sheet, paste. On the APK over plain http that route does not exist.
   *
   * The sheet's own draft is the right destination and already survives this
   * round trip — it is the same buffer the annotator returns through.
   */
  insertInto?: "compose" | "send";
  openFile?: { repoId: string; relPath: string; name: string; size?: number; mtime?: number };
};

/** The sweep sheet's scope, and the screen its close returns to. */
export type SweepFor = { repoId: string; scope: SweepScope; back: Overlay };

/**
 * Open the gallery straight on one artifact.
 *
 * The scope is `outbox` and the window is all-time because that is the tab
 * whose listing is most likely to hold the file the alert was about — but the
 * viewer does NOT wait for that listing: `openFile` renders from this payload
 * alone, so a tap works with the grid still spinning, or never landing at all.
 * The name falls back to the basename because a cold-start hash may carry none.
 */
export function galleryCtxForFile(f: { repoId: string; relPath: string; name?: string; size?: number; mtime?: number }, returnTo?: Overlay): GalleryCtx {
  return {
    repoId: f.repoId,
    scope: "outbox",
    allTime: true,
    returnTo,
    openFile: { ...f, name: f.name || f.relPath.split("/").pop() || f.relPath },
  };
}

const VIDEO_RE = /\.(mp4|webm|mov|m4v|ogv|mkv)$/i;
const PICTURE_RE = /\.(png|jpe?g|gif|webp|bmp|avif|heic|svg)$/i;

export function isVideoPath(relPath: string): boolean { return VIDEO_RE.test(relPath); }
/** A markdown file in the strip — a document tile that opens the reader, not the viewer. */
export function isMarkdownPath(relPath: string): boolean { return /\.(md|markdown|mdx)$/i.test(relPath); }
/** A path the full-screen viewer draws (images and videos); anything else is a download. */
export function isViewable(relPath: string): boolean { return VIDEO_RE.test(relPath) || PICTURE_RE.test(relPath); }

/** The strip's pictures and videos — what the viewer swipes through; its
 *  markdown tiles open the reader instead. */
export function viewableStrip<T extends { relPath: string }>(list: readonly T[]): T[] {
  return list.filter((x) => isViewable(x.relPath));
}

/** The toast a turn's new files say: pictures and markdown counted apart. */
export function newFilesToast(images: readonly NewImage[]): string {
  const md = images.filter((i) => isMarkdownPath(i.relPath));
  const edited = md.filter((i) => i.changed).length;
  const pics = images.length - md.length;
  const parts: string[] = [];
  if (pics) parts.push(`${pics} new image${pics > 1 ? "s" : ""}`);
  if (md.length - edited) parts.push(`${md.length - edited} new markdown`);
  if (edited) parts.push(`${edited} markdown edited`);
  return parts.join(" · ");
}

/** Where a picture opened from a notification sits: its place in a session's
 *  persisted batch (so the rest are swipeable), or null for a one-item list. */
export function findInStrips(strips: NewImages, im: { repoId: string; relPath: string }, prefer?: string): { sessionId: string; i: number } | null {
  const at = (sid: string) => viewableStrip(strips.get(sid) ?? []).findIndex((x) => x.repoId === im.repoId && x.relPath === im.relPath);
  if (prefer && at(prefer) >= 0) return { sessionId: prefer, i: at(prefer) };
  for (const k of strips.keys()) { const i = at(k); if (i >= 0) return { sessionId: k, i }; }
  return null;
}

/** `session.images`: append what is new to that session's strip, by path, in
 *  arrival order — a file reported twice is one thumb. A markdown file
 *  reported again (rewritten) moves to the end with its new mtime, and stays
 *  `changed` only if it was not new to the strip's whole run. */
export function mergeNewImages(prev: NewImages, sessionId: string, repoId: string, images: readonly NewImage[]): Map<string, NewImg[]> {
  const n = new Map(prev);
  const merged = [...(n.get(sessionId) ?? [])];
  for (const im of images) {
    const at = merged.findIndex((x) => x.relPath === im.relPath);
    if (at < 0) { merged.push({ ...im, repoId }); continue; }
    if (!isMarkdownPath(im.relPath) || im.mtime <= merged[at].mtime) continue;
    const [old] = merged.splice(at, 1);
    const { changed: _rewritten, ...fresh } = im;
    merged.push(old.changed ? { ...im, repoId } : { ...fresh, repoId });
  }
  n.set(sessionId, merged);
  return n;
}

/** The strip without one session's entry; `prev` itself when it had none, so
 *  the store emits nothing. (`sdk`'s `mapWithout`, which its index does not
 *  export yet.) */
export function dropStrip(prev: NewImages, sessionId: string): NewImages {
  if (!prev.has(sessionId)) return prev;
  const n = new Map(prev);
  n.delete(sessionId);
  return n;
}

/** What the strip persists: empty lists dropped, each kept to its newest `NEWIMG_CAP`. */
export function trimNewImages(all: NewImages): Record<string, NewImg[]> {
  const out: Record<string, NewImg[]> = {};
  for (const [id, list] of all) if (list.length) out[id] = list.slice(-NEWIMG_CAP);
  return out;
}

/**
 * Replace an item's old image path — plus any stale `(marked: …)` note right
 * after it — with the new path+note, so re-marking doesn't pile up notes.
 * The note itself CONTAINS parentheses (each mark states its position as
 * `top-left (x 12%, y 8%)`), so the group tolerates one level of nesting; a
 * `[^)]*` stops at the first coordinate and leaves half the old note behind.
 */
export function swapImageRef(text: string, oldPath: string, ref: string): string {
  const esc = oldPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`${esc}(?:\\s*\\(marked:(?:[^()]|\\([^()]*\\))*\\))?`);
  return re.test(text) ? text.replace(re, ref) : `${text} ${ref}`;
}

/**
 * Words read off a picture, as the agent receives them INSTEAD of the picture
 * (the annotator's "text only"). Fenced so the agent sees where the reading
 * starts and ends, and labelled as a reading so a misread glyph is taken for
 * what it is rather than as the person's own typing. A fence inside the text is
 * lengthened past, never stripped — the words are the person's, as edited.
 */
export function ocrBlock(text: string): string {
  const body = text.trim();
  const longest = Math.max(2, ...[...body.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(longest + 1);
  return `Text read off a photo (on-device OCR, the photo itself not sent — glyphs may be misread):\n${fence}\n${body}\n${fence}\n`;
}

/** The agent gets the path PLUS what was marked, so it knows where to look. */
export function markedRef(relPath: string, note?: string): string {
  return note ? `${relPath} (marked: ${note})` : relPath;
}

/**
 * Which sheet the annotator came from — it REPLACED that sheet, so closing it
 * has to put it back rather than dropping the user on the launcher.
 */
export function annReturnOverlay(r: ImageReturn, sendSeeded: boolean): Overlay {
  if (r === "backlog-item") return "backlog";
  if (r === "send") return sendSeeded ? "send" : null;
  if (r === "pad") return "pad";
  return null;
}

/**
 * The lane an annotated picture is parked in: where its path will be SENT
 * from, never a key of its own.
 *
 * The session flow's result goes into the compose box (the active session, or
 * the repo when none). The Start sheet's result is sent from a queued
 * `session.create`, so its lane is that create's — the image has to be in
 * `.claude/inbox` before the prompt naming it is typed into the session it
 * opens. A pad note has not chosen a destination yet, so its lane is the one
 * it is most likely to end up in (that repo's create); ordering is safe either
 * way, because text naming an upload adopts that upload's lane
 * (`adoptReferencedUploads`). A backlog item's is the repo.
 */
export function parkLane(r: ImageReturn, dir: string, activeId: string | null, sendRepoPath?: string | null, padRepoPath?: string | null): string {
  if (r === "session") return activeId ?? dir;
  if (r === "send") return `create:${sendRepoPath ?? dir}`;
  if (r === "pad") return `create:${padRepoPath ?? dir}`;
  return dir;
}

/** The outbox badge's own edge, so the gallery opens on exactly what it counted. */
export function outboxCut(r: { outboxSeenAt?: number | null; outboxCount: number } | undefined): { since: number; count: number } | undefined {
  return r?.outboxSeenAt != null && r.outboxCount > 0 ? { since: r.outboxSeenAt, count: r.outboxCount } : undefined;
}


/**
 * What a paste carrying files does (Cmd/Ctrl+V of a screenshot or a copied
 * file). Only the session's own box, or nowhere editable with no sheet up,
 * takes it: every other text field belongs to a sheet with its own attach
 * route (the pad, the Send sheet), and a picture routed past that sheet into
 * the session would land somewhere the person was not looking. A picture
 * already on the annotator is the last copy of its marks, so a second paste
 * never replaces it: `ask` — append it to the batch, or leave it. A paste
 * some nearer handler already took (`handled`: the compose box's own onPaste
 * ran first and called preventDefault) is never taken a second time — that
 * was two copies of every Ctrl+V'd screenshot.
 */
/**
 * Whether every pasted picture is one the annotator ALREADY holds, byte for
 * byte. A Ctrl+V landing while its own picture is on screen is a repeat, not a
 * second picture: asking "Append?" there made the yes the easy answer, and the
 * same screenshot went up twice (25 of 31 desktop pastes once took that yes).
 * Bytes, not names or sizes alone: every clipboard picture is `image.png`.
 */
export function pasteRepeatsHeld(pasted: readonly Uint8Array[], held: readonly Uint8Array[]): boolean {
  const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);
  return pasted.length > 0 && pasted.every((p) => held.some((h) => same(p, h)));
}

export type PasteRoute = "route" | "ask" | "ignore";
export function pasteRoute(p: {
  files: number; editable: boolean; inCompose: boolean; sheet: boolean; annotating: boolean; repoId: string | null;
  handled?: boolean;
}): PasteRoute {
  if (p.handled || !p.files || !p.repoId) return "ignore";
  if (p.editable && !p.inCompose) return "ignore";
  if (p.annotating) return "ask";
  if (p.sheet && !p.inCompose) return "ignore";
  return "route";
}
