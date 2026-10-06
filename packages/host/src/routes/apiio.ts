/**
 * The HTTP API's plumbing, shared by every `routes/api*.ts` table: the JSON
 * reply, the body readers and their ceilings, the multipart parser, and the
 * file server (thumbnails, byte ranges, `if-range`, streaming past
 * `STREAM_MIN`). Moved verbatim out of `api.ts`
 * (host-architecture.md, "api.ts — the HTTP routes as tables").
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { createReadStream } from "node:fs";
import { extname } from "node:path";
import { readInTree, resolveInTree, statInTree, type TreeReadOpts } from "../files.js";
import { WIRE, recordWireHttp } from "../wirerecord.js";
import { sendBody, notModified, statTag } from "../httpio.js";
import { canThumb, thumbnail, thumbWidth } from "../thumbs.js";
import { env } from "../env.js";

// 64 MB. The inbox takes documents now, not just photos — a scanned PDF or a
// zip clears the old 32 MB ceiling routinely. The body is buffered in RAM, so
// this is a deliberate ceiling rather than an oversight.
export const MAX_UPLOAD = Number(env("MAX_UPLOAD") || 64 * 1024 * 1024);

export const MIME: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".bmp": "image/bmp", ".svg": "image/svg+xml", ".heic": "image/heic",
  ".heif": "image/heif", ".avif": "image/avif", ".tif": "image/tiff", ".tiff": "image/tiff",
  ".ico": "image/x-icon", ".jfif": "image/jpeg",
  ".pdf": "application/pdf", ".md": "text/markdown; charset=utf-8", ".txt": "text/plain; charset=utf-8",
  ".csv": "text/csv", ".json": "application/json", ".log": "text/plain; charset=utf-8",
  ".html": "text/html; charset=utf-8", ".zip": "application/zip", ".apk": "application/vnd.android.package-archive",
  ".aab": "application/octet-stream", ".ipa": "application/octet-stream", ".jar": "application/java-archive",
  ".tar": "application/x-tar", ".gz": "application/gzip", ".tgz": "application/gzip",
  ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime",
  ".m4v": "video/x-m4v", ".ogv": "video/ogg", ".mkv": "video/x-matroska",
  // Office / productivity — the phone shares these as readily as a photo.
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".odt": "application/vnd.oasis.opendocument.text",
  ".ods": "application/vnd.oasis.opendocument.spreadsheet",
  ".odp": "application/vnd.oasis.opendocument.presentation",
  ".rtf": "application/rtf", ".epub": "application/epub+zip",
  // Structured text. Anything text/* also gets br/gzip out of `sendBody`.
  ".xml": "application/xml", ".yaml": "text/plain; charset=utf-8", ".yml": "text/plain; charset=utf-8",
  ".toml": "text/plain; charset=utf-8", ".ini": "text/plain; charset=utf-8",
  ".conf": "text/plain; charset=utf-8", ".cfg": "text/plain; charset=utf-8",
  ".properties": "text/plain; charset=utf-8", ".tsv": "text/tab-separated-values",
  ".diff": "text/plain; charset=utf-8", ".patch": "text/plain; charset=utf-8",
  ".sql": "text/plain; charset=utf-8", ".srt": "text/plain; charset=utf-8",
  ".vtt": "text/vtt", ".ics": "text/calendar", ".plist": "application/xml",
  ".jsonl": "application/json", ".ndjson": "application/json",
  ".markdown": "text/markdown; charset=utf-8", ".mdx": "text/markdown; charset=utf-8",
  ".rst": "text/plain; charset=utf-8", ".tex": "text/plain; charset=utf-8",
  // Audio — a voice memo plays inline in the gallery viewer.
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4", ".aac": "audio/aac",
  ".ogg": "audio/ogg", ".oga": "audio/ogg", ".opus": "audio/ogg", ".flac": "audio/flac",
  ".aiff": "audio/aiff", ".caf": "audio/x-caf", ".amr": "audio/amr",
  // Archives / fonts / misc payloads.
  ".7z": "application/x-7z-compressed", ".bz2": "application/x-bzip2",
  ".xz": "application/x-xz", ".zst": "application/zstd", ".iso": "application/x-iso9660-image",
  ".ttf": "font/ttf", ".otf": "font/otf", ".woff": "font/woff", ".woff2": "font/woff2",
  ".gpx": "application/gpx+xml", ".kml": "application/vnd.google-earth.kml+xml",
  ".stl": "model/stl", ".obj": "model/obj",
};

/**
 * JSON response, br/gzip-negotiated. Listings, transcripts and diffs are highly
 * compressible text and were previously sent raw; `res.req` gives us the request
 * without threading it through every call site.
 */
export function json(res: ServerResponse, data: unknown, status = 200): void {
  const body = Buffer.from(JSON.stringify(data), "utf8");
  if (WIRE) recordWireHttp(res.req.method ?? "GET", res.req.url ?? "", status, body);
  sendBody(res.req, res, status, body, { "content-type": "application/json" });
}

/**
 * Serve an in-memory buffer with HTTP byte-range support (206). <video> on
 * Safari/iOS refuses to play a 200 full-body response — it needs `Accept-Ranges`
 * and honours `Range`. The buffer is already resident so we just slice it.
 */
export function serveRange(
  req: IncomingMessage,
  res: ServerResponse,
  buf: Buffer,
  contentType: string,
  extra?: Record<string, string>,
): void {
  const range = req.headers.range;
  const m = range && /^bytes=(\d*)-(\d*)/.exec(range);
  if (m) {
    let start = m[1] ? parseInt(m[1], 10) : 0;
    let end = m[2] ? parseInt(m[2], 10) : buf.length - 1;
    if (!Number.isFinite(start) || start < 0) start = 0;
    if (!Number.isFinite(end) || end >= buf.length) end = buf.length - 1;
    // Unsatisfiable: say 416, the same as the streaming path. Falling back to
    // the whole file under a 206 is what makes a resuming client append a second
    // copy to the prefix it already holds and call the result complete.
    if (start > end || start >= buf.length) {
      res.writeHead(416, { "content-range": `bytes */${buf.length}`, "accept-ranges": "bytes", ...extra });
      res.end();
      return;
    }
    const slice = buf.subarray(start, end + 1);
    res.writeHead(206, {
      "content-type": contentType,
      "content-range": `bytes ${start}-${end}/${buf.length}`,
      "accept-ranges": "bytes",
      "content-length": String(slice.length),
      ...extra,
    });
    res.end(slice);
    return;
  }
  res.writeHead(200, {
    "content-type": contentType,
    "accept-ranges": "bytes",
    "content-length": String(buf.length),
    ...extra,
  });
  res.end(buf);
}

/**
 * Size past which a file is streamed off disk instead of buffered. Below it the
 * buffered path is better: small text artifacts get br/gzip out of `sendBody`,
 * and the whole file is one read anyway.
 */
export const STREAM_MIN = 2 * 1024 * 1024;

/**
 * Stream a file from disk with byte-range support — the resumable-download path.
 *
 * This exists because `readInTree` reads the WHOLE file into a Buffer. That is
 * fine for a screenshot and wrong for a build deliverable in two ways: the host
 * holds the file's full size in RAM per concurrent request, and a phone resuming
 * a 300 MB APK re-requests ranges of that same file, so every resume would
 * re-read all 300 MB to hand back the last 20. Streaming makes a resume cost the
 * bytes it actually asks for.
 *
 * Never compressed: `sendBody` refuses a 206 anyway, and these are already-packed
 * binaries. `accept-ranges` on the 200 is what tells the client resuming is even
 * possible — without it a fallback downloader has no choice but to restart.
 */
export function serveFileStream(
  req: IncomingMessage,
  res: ServerResponse,
  full: string,
  size: number,
  contentType: string,
  extra?: Record<string, string>,
): void {
  const m = /^bytes=(\d*)-(\d*)/.exec(req.headers.range || "");
  let start = 0, end = size - 1, status = 200;
  if (m && (m[1] || m[2])) {
    if (m[1]) {
      start = parseInt(m[1], 10);
      if (m[2]) end = parseInt(m[2], 10);
    } else {
      // `bytes=-N` — the trailing N bytes.
      start = size - parseInt(m[2], 10);
    }
    if (!Number.isFinite(start) || start < 0) start = 0;
    if (!Number.isFinite(end) || end >= size) end = size - 1;
    // An unsatisfiable range must say so (416), not silently hand back the whole
    // file: a resuming client would append the full body to what it already has.
    if (start > end || start >= size) {
      res.writeHead(416, { "content-range": `bytes */${size}`, "accept-ranges": "bytes", ...extra });
      res.end();
      return;
    }
    status = 206;
  }
  const head: Record<string, string> = {
    "content-type": contentType,
    "content-length": String(end - start + 1),
    "accept-ranges": "bytes",
    ...extra,
  };
  if (status === 206) head["content-range"] = `bytes ${start}-${end}/${size}`;
  res.writeHead(status, head);
  const stream = createReadStream(full, { start, end });
  // A phone that walks away mid-download leaves the socket half-open; destroy the
  // read stream with it so a dropped tunnel can't leak file handles.
  stream.on("error", () => res.destroy());
  res.on("close", () => stream.destroy());
  stream.pipe(res);
}

/**
 * The upload's original filename, off the `x-file-name` header.
 *
 * The client percent-encodes it: an HTTP header is Latin-1, and a browser
 * REFUSES to set one containing anything else — so a document called
 * "Angebot Übersicht.pdf" threw at `setRequestHeader` and the upload never
 * happened at all. A bare (un-encoded) name still decodes to itself, which is
 * what makes an older client keep working.
 */
export function headerFilename(raw: string | string[] | undefined): string {
  const v = String(Array.isArray(raw) ? raw[0] : raw || "").trim();
  if (!v) return "upload.bin";
  try { return decodeURIComponent(v) || "upload.bin"; } catch { return v; }
}

/**
 * Serve a file out of a worktree: thumbnail when asked for one, byte-range when
 * asked for one, and always with a validator so a revisit costs a 304 instead of
 * the bytes again.
 *
 * `thumb=<w>` is the bandwidth lever — the gallery grid and the image strips ask
 * for a few-KB JPEG instead of the multi-MB original (see thumbs.ts). It is a
 * hint, not a contract: if no converter exists or the source is already small,
 * the original is sent, so a client can always ask.
 */
export async function serveTreeFile(
  req: IncomingMessage,
  res: ServerResponse,
  wt: string,
  rel: string,
  name: string,
  url: URL,
  /** `anyType` = serve whatever extension it has (the inbox — see files.ts). */
  opts: TreeReadOpts = {},
): Promise<void> {
  const dispo = url.searchParams.get("download") === "1"
    ? { "content-disposition": `attachment; filename="${name.replace(/[^\w. -]/g, "_")}"` }
    : undefined;

  const want = thumbWidth(url.searchParams.get("thumb"));
  if (want && !dispo) {
    const full = resolveInTree(wt, rel);
    if (full && canThumb(full)) {
      const t = await thumbnail(full, want);
      if (t) {
        // A thumb is content-addressed (path+mtime+size+width hashed into `key`),
        // so it can be cached hard. `v` in the URL (the client passes the file's
        // mtime) makes the URL itself change when the file does — only then is
        // `immutable` safe.
        const etag = `"t-${t.key}"`;
        const cc = url.searchParams.has("v")
          ? "private, max-age=604800, immutable"
          : "private, max-age=86400";
        if (notModified(req, res, etag, cc)) return;
        res.writeHead(200, {
          "content-type": t.mime,
          "content-length": String(t.buf.length),
          "cache-control": cc,
          etag,
        });
        res.end(t.buf);
        return;
      }
    }
    // No thumbnail possible. For an image, falling through to the original is
    // right (correct, just fat). For a VIDEO it is not: the caller asked for a
    // poster frame and would otherwise get the whole movie into an <img>/poster.
    if (full && /\.(mp4|webm|mov|m4v|ogv|mkv)$/i.test(full)) {
      json(res, { error: "no poster" }, 404);
      return;
    }
  }

  const st = statInTree(wt, rel, opts);
  if (!st) { json(res, { error: "not found" }, 404); return; }
  const etag = statTag(st.size, st.mtime);
  const cc = "private, max-age=0, must-revalidate";
  if (!req.headers.range && notModified(req, res, etag, cc)) return;
  const mime = MIME[extname(rel).toLowerCase()] || "application/octet-stream";
  const headers = { ...(dispo ?? {}), "cache-control": cc, etag };

  // `if-range`: the resuming client is saying "only continue if this is still
  // the same file". Without honouring it, a rebuilt APK at the same path answers
  // the old offset with bytes from the NEW build, which the client appends to
  // the old prefix — a corrupt file that looks complete and passes every check
  // the client can make. Mismatch ⇒ drop the range and send the whole thing,
  // which is exactly the signal `pull.ts` restarts from.
  const ifRange = req.headers["if-range"];
  if (ifRange && ifRange !== etag) delete req.headers.range;

  // Big files stream (resumable download, no full-size Buffer); small ones keep
  // the buffered path so text artifacts still get compressed.
  if (st.size >= STREAM_MIN) { serveFileStream(req, res, st.full, st.size, mime, headers); return; }
  const buf = readInTree(wt, rel, opts);
  if (!buf) { json(res, { error: "not found" }, 404); return; }
  serveRange(req, res, buf, mime, headers);
}

export async function readBody(req: IncomingMessage, max = MAX_UPLOAD): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const c of req) {
    total += (c as Buffer).length;
    if (total > max) {
      req.destroy();
      throw new Error("payload too large");
    }
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

export async function readJson(req: IncomingMessage, limit = 1_000_000): Promise<any> {
  // JSON control bodies are tiny; cap independently of the file-upload limit.
  // The one exception is a file save (tree write), which carries up to
  // MAX_EDIT_BYTES of source — and JSON escaping can multiply that.
  const buf = await readBody(req, limit);
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString("utf8"));
  } catch {
    return {};
  }
}

// ── Minimal multipart/form-data parser (file parts only) ──────────────
export function parseMultipart(body: Buffer, contentType: string): { filename: string; data: Buffer }[] {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  const boundary = (m?.[1] || m?.[2] || "").trim();
  if (!boundary) return [];
  const delim = Buffer.from("--" + boundary);
  const out: { filename: string; data: Buffer }[] = [];
  let start = body.indexOf(delim);
  while (start !== -1) {
    const next = body.indexOf(delim, start + delim.length);
    if (next === -1) break;
    let chunk = body.subarray(start + delim.length, next);
    if (chunk.subarray(0, 2).toString() === "\r\n") chunk = chunk.subarray(2);
    const sep = chunk.indexOf("\r\n\r\n");
    if (sep !== -1) {
      const header = chunk.subarray(0, sep).toString("utf8");
      let data = chunk.subarray(sep + 4);
      if (data.subarray(-2).toString() === "\r\n") data = data.subarray(0, -2);
      const fn = /filename\*?=(?:"([^"]+)"|([^;\r\n]+))/i.exec(header);
      const filename = (fn?.[1] || fn?.[2] || "").trim();
      if (filename) out.push({ filename, data });
    }
    start = next;
  }
  return out;
}

/** Is this socket peer the machine itself? The one predicate behind both hook sinks. */
export function isLoopbackAddr(ra: string | undefined): boolean {
  const a = ra || "";
  return a === "127.0.0.1" || a === "::1" || a === "::ffff:127.0.0.1" || a.startsWith("127.");
}
