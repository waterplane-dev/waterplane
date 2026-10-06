/**
 * What a file IS, by its name — the one extension table on this side of the wire.
 *
 * These lived inside `Gallery.tsx`, which was fine while the gallery was the
 * only screen that rendered a file. It is not: a notification about an outbox
 * drop has to decide, before any viewer exists, whether tapping it should OPEN
 * the file or download it — and a second copy of "is this markdown" is exactly
 * how the feed and the viewer come to disagree about the same `.md`.
 *
 * The split mirrors the host's `kindExt` (`host/src/files.ts`) deliberately
 * loosely: this answers "can the viewer PAINT it", the host answers "does this
 * belong in that tab's listing". Neither is derived from the other, and shared
 * holds no third list on purpose (`shared/gallery.ts` takes the split as a
 * parameter rather than owning it).
 */

/** Images the browser paints. */
export function isImage(p: string): boolean {
  return /\.(png|jpe?g|gif|webp|bmp|svg|heic|heif)$/i.test(p);
}

/** Video the browser plays inline. */
export function isVideo(p: string): boolean {
  return /\.(mp4|webm|mov|m4v|ogv|mkv)$/i.test(p);
}

/** The host's `kind=image` — which INCLUDES video (files.ts `kindExt`). The
 *  offline filter has to split rows the same way the server does, or the same
 *  chip would list different files depending on whether the tunnel was up. */
export function isImageKind(p: string): boolean {
  return isImage(p) || isVideo(p);
}

/** Audio the browser can play inline — a voice memo dropped in the inbox is a
 *  file you want to HEAR on the phone, not download. */
export function isAudio(p: string): boolean {
  return /\.(mp3|wav|m4a|aac|ogg|oga|opus|flac|aiff|caf|amr)$/i.test(p);
}

/** PDFs render in the viewer's own frame. Some mobile browsers (iOS Safari)
 *  only paint the first page in an embedded frame, so the "Open …" fallback
 *  stays right underneath rather than being replaced by it. */
export function isPdf(p: string): boolean {
  return /\.pdf$/i.test(p);
}

/** HTML — a deck or a report written to be LOOKED at, not read as tags. Same
 *  deal as markdown: rendered by default, with a toggle back to the source.
 *  The viewer paints it in a SANDBOXED frame (no `allow-same-origin`), so the
 *  document runs on an opaque origin and its `Origin: null` is refused by the
 *  host's own guard (`host/src/origin.ts`) — an artifact cannot call the API
 *  that spawned it. */
export function isHtml(p: string): boolean {
  return /\.html?$/i.test(p);
}

/** The two kinds this viewer shows FORMATTED first and as source on request.
 *  One predicate so the toolbar, the render branch and the "saved copy" line
 *  cannot disagree about which files have a toggle. */
export function isRich(p: string): boolean {
  return isMarkdown(p) || isHtml(p);
}

/** Markdown — rendered formatted by default, with a toggle back to the source. */
export function isMarkdown(p: string): boolean {
  return /\.(md|markdown|mdx)$/i.test(p);
}

/** Text the viewer can show inline instead of handing off to a browser tab.
 *  An outbox drop is usually a report meant to be READ on the phone; making
 *  that a download-and-hope-something-opens-it was the whole complaint. */
export function isText(p: string): boolean {
  return isMarkdown(p) || /\.(txt|log|csv|json|ya?ml|toml|ini|diff|patch|sh|html?)$/i.test(p);
}

/**
 * Whether the gallery's viewer can show this file in place.
 *
 * This is the predicate a notification tap turns on: true ⇒ one tap opens the
 * file and the download stays available beside it; false (an `.apk`, a `.zip`)
 * ⇒ the tap is the download it always was, because opening a viewer that can
 * only say "nothing here can render this" is a worse answer than the transfer.
 */
export function viewerHandles(p: string): boolean {
  return isText(p) || isPdf(p) || isImageKind(p) || isAudio(p);
}
