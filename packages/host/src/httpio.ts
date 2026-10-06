/**
 * Response compression + conditional-GET helpers.
 *
 * Everything the phone pulls over HTTP was previously sent raw and uncacheable:
 * transcript documents (hundreds of KB of JSON, refetched on every turn while a
 * turn is in flight), artifact listings, git diffs, the app bundle, and every
 * image — with no `ETag`, so a revisit re-downloaded bytes the phone already
 * had. On a hotel/roaming link that is the whole cost. These two helpers add
 * br/gzip negotiation and 304 handling in one place so every route gets both.
 *
 * Ranges are deliberately NOT compressed: a 206 is for <video> seeking, and a
 * compressed byte range is meaningless.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { brotliCompressSync, constants as zc, gzipSync } from "node:zlib";
import { env } from "./env.js";

/** Under this, framing + CPU cost more than the saved bytes. */
const MIN_COMPRESS = 1024;
/** Above this we skip brotli (CPU) and use gzip, which is ~10x faster to encode. */
const BROTLI_MAX = 4 * 1024 * 1024;

const COMPRESSIBLE = /^(?:text\/|application\/(?:json|javascript|xml|x-ndjson)|image\/svg)/;

const enabled = env("COMPRESS") !== "0";

/** True when this content type is worth compressing (already-compressed media isn't). */
export function compressible(mime: string): boolean {
  return COMPRESSIBLE.test(mime);
}

/**
 * Compressed-body cache for content that never changes for a given key (the
 * static bundle). Lets those use max-effort brotli — ~20% smaller than the
 * quality-4 setting a per-request encode can afford — without paying the CPU on
 * every cold client. Bounded by entry count; the app ships a handful of assets.
 */
const CACHE_MAX_ENTRIES = 32;
const bodyCache = new Map<string, Buffer>();
function cached(key: string, make: () => Buffer): Buffer {
  const hit = bodyCache.get(key);
  if (hit) return hit;
  const made = make();
  if (bodyCache.size >= CACHE_MAX_ENTRIES) bodyCache.delete(bodyCache.keys().next().value as string);
  bodyCache.set(key, made);
  return made;
}

/**
 * Send a body with content negotiation. Callers pass the UNcompressed buffer;
 * this picks br/gzip/identity.
 *
 * `cacheKey` marks the body as immutable for that key (pass something that
 * changes when the bytes do, e.g. the ETag): the compressed form is memoised and
 * encoded at maximum brotli quality instead of the fast per-request setting.
 */
export function sendBody(
  req: IncomingMessage,
  res: ServerResponse,
  status: number,
  buf: Buffer,
  headers: Record<string, string>,
  cacheKey?: string,
): void {
  const mime = headers["content-type"] || "application/octet-stream";
  const accept = String(req.headers["accept-encoding"] || "");
  let body = buf;
  const out: Record<string, string> = { ...headers };
  if (enabled && buf.length >= MIN_COMPRESS && compressible(mime)) {
    try {
      if (/\bbr\b/.test(accept) && buf.length <= BROTLI_MAX) {
        // Quality 4 is the knee for a one-shot encode: near-gzip speed, better
        // ratio than gzip -6. A cacheable body pays 11 once and keeps it.
        const q = cacheKey ? 11 : 4;
        const enc = () => brotliCompressSync(buf, {
          params: { [zc.BROTLI_PARAM_QUALITY]: q, [zc.BROTLI_PARAM_SIZE_HINT]: buf.length },
        });
        body = cacheKey ? cached(`br:${q}:${cacheKey}`, enc) : enc();
        out["content-encoding"] = "br";
      } else if (/\bgzip\b/.test(accept)) {
        const enc = () => gzipSync(buf, { level: cacheKey ? 9 : 6 });
        body = cacheKey ? cached(`gz:${cacheKey}`, enc) : enc();
        out["content-encoding"] = "gzip";
      }
    } catch {
      body = buf; // compression is an optimisation, never a failure mode
      delete out["content-encoding"];
    }
    if (out["content-encoding"]) out["vary"] = out["vary"] ? `${out["vary"]}, Accept-Encoding` : "Accept-Encoding";
  }
  out["content-length"] = String(body.length);
  res.writeHead(status, out);
  if (req.method === "HEAD") res.end();
  else res.end(body);
}

/**
 * Answer 304 when the client's `If-None-Match` matches. Returns true if it did
 * (the caller must then send nothing else).
 */
export function notModified(
  req: IncomingMessage,
  res: ServerResponse,
  etag: string,
  cacheControl: string,
): boolean {
  const inm = req.headers["if-none-match"];
  if (!inm) return false;
  const tags = String(inm).split(",").map((s) => s.trim());
  if (!tags.includes(etag) && !tags.includes("*")) return false;
  res.writeHead(304, { etag, "cache-control": cacheControl });
  res.end();
  return true;
}

/** Weak validator from a file stat — cheap and good enough for local files. */
export function statTag(size: number, mtimeMs: number): string {
  return `W/"${size.toString(36)}-${Math.floor(mtimeMs).toString(36)}"`;
}
