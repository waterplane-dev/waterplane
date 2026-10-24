/**
 * The MIME type a pulled file's bytes are handed to the browser as — decided by
 * the file's NAME, never sniffed from its bytes.
 *
 * A `Blob` built without a type (the range engine merges chunks with
 * `new Blob([...])`) has type `""`, and a `blob:` URL of such a blob is
 * content-sniffed: an agent-written `report.pdf` holding HTML would render as a
 * page on the app's own origin, cookie and all. The host serves the same file
 * typed by extension with `nosniff` and a sandbox CSP; the local copy has to
 * make the same promise, so every object URL and every stored blob goes through
 * `typedBlob`. An extension nobody listed is `application/octet-stream`: the
 * browser offers it as a download and runs nothing.
 */
const BY_EXT: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", jfif: "image/jpeg", gif: "image/gif", webp: "image/webp",
  svg: "image/svg+xml", bmp: "image/bmp", avif: "image/avif", heic: "image/heic", heif: "image/heif", ico: "image/x-icon",
  tif: "image/tiff", tiff: "image/tiff",
  mp4: "video/mp4", m4v: "video/x-m4v", webm: "video/webm", mov: "video/quicktime", ogv: "video/ogg", mkv: "video/x-matroska",
  mp3: "audio/mpeg", m4a: "audio/mp4", aac: "audio/aac", wav: "audio/wav", ogg: "audio/ogg", flac: "audio/flac", opus: "audio/opus",
  pdf: "application/pdf",
  txt: "text/plain", log: "text/plain", md: "text/markdown", csv: "text/csv", json: "application/json",
  html: "text/html", htm: "text/html",
  apk: "application/vnd.android.package-archive", zip: "application/zip",
};

export const OCTET_STREAM = "application/octet-stream";

/** The type for a file name; `application/octet-stream` for an extension nobody listed. */
export function mimeFor(name: string): string {
  const m = /\.([A-Za-z0-9]+)$/.exec(name);
  return (m && BY_EXT[m[1].toLowerCase()]) || OCTET_STREAM;
}

/** A Blob whose type comes from the file NAME, so nothing is ever sniffed from its bytes. */
export function typedBlob(parts: BlobPart[], name: string): Blob {
  return new Blob(parts, { type: mimeFor(name) });
}
