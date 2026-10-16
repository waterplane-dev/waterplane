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

// ── JSON request bodies ─────────────────────────────────────────────

/**
 * A request body that is not the JSON its route reads: unparsable (usually a
 * body cut off on the way), not an object, missing where the route needs one,
 * or over the route's cap. Thrown by `readJsonBody` and answered in ONE place
 * per HTTP edge (`api.ts`'s `handleApi`, `server/http.ts`'s error path) as
 * `{ ok: false, error }` with `status` — so the phone reads "the body was bad",
 * not a downstream refusal about a field that was never really absent.
 * Before this, every such body read as `{}`.
 */
export class BadBody extends Error {
  readonly status: 400 | 413;
  constructor(message: string, status: 400 | 413 = 400) {
    super(message);
    this.name = "BadBody";
    this.status = status;
  }
}

export interface ReadJsonOpts {
  /** Byte cap on the raw body (default 1 MB). Past it ⇒ `BadBody` 413. */
  limit?: number;
  /** An EMPTY body reads as `{}` — for a route whose every field is optional.
   *  Never covers a malformed one: empty is "nothing to say", garbage is not. */
  optional?: boolean;
  /** Accept any JSON value, not only an object/array (a plugin's own payload). */
  anyJson?: boolean;
}

const NOTHING_DONE = "nothing was done with it";

function sizeWords(n: number): string {
  return n >= 1_000_000 ? `${Math.round(n / 100_000) / 10} MB` : `${Math.round(n / 1000)} kB`;
}

/** Collect the body up to `limit`. Past it the stream is PAUSED, not destroyed,
 *  so the 413 can still be written (the reply asks for `connection: close`). */
function collect(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (req.readableEnded) { resolve(Buffer.alloc(0)); return; }
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      req.off("data", onData); req.off("end", onEnd); req.off("error", onError); req.off("close", onClose);
      fn();
    };
    const onData = (c: Buffer) => {
      total += c.length;
      if (total > limit) {
        req.pause();
        done(() => reject(new BadBody(`the request body is over ${sizeWords(limit)}; ${NOTHING_DONE}`, 413)));
        return;
      }
      chunks.push(c);
    };
    const onEnd = () => done(() => resolve(Buffer.concat(chunks)));
    const onError = (e: Error) => done(() => reject(e));
    const onClose = () => done(() => reject(new Error("request closed before its body arrived")));
    req.on("data", onData); req.on("end", onEnd); req.on("error", onError); req.on("close", onClose);
  });
}

/**
 * Read a JSON request body, or throw `BadBody`. Returns `any` on purpose:
 * the ~45 routes destructure what they read and check each field themselves;
 * this guarantees only that what they destructure is a JSON object that
 * arrived whole.
 */
export async function readJsonBody(req: IncomingMessage, opts: ReadJsonOpts = {}): Promise<any> {
  const buf = await collect(req, opts.limit ?? 1_000_000);
  if (!buf.length) {
    if (opts.optional) return {};
    throw new BadBody(`this request needs a JSON body and arrived with none; ${NOTHING_DONE}`);
  }
  let v: unknown;
  try {
    v = JSON.parse(buf.toString("utf8"));
  } catch {
    throw new BadBody(`malformed JSON body — it may have been cut off on the way; ${NOTHING_DONE}`);
  }
  if (!opts.anyJson && (v === null || typeof v !== "object")) {
    throw new BadBody(`the request body must be a JSON object; ${NOTHING_DONE}`);
  }
  return v;
}

/** The reply for a `BadBody`; `false` (nothing written) for any other error.
 *  `headers` carries what the caller's edge adds (CORS on the auth path). */
export function answerBadBody(res: ServerResponse, err: unknown, headers: Record<string, string> = {}): boolean {
  if (!(err instanceof BadBody)) return false;
  if (res.headersSent) { res.end(); return true; }
  const body = Buffer.from(JSON.stringify({ ok: false, error: err.message }), "utf8");
  res.writeHead(err.status, {
    "content-type": "application/json", "content-length": String(body.length), ...headers,
    // An over-cap body was left unread: this connection cannot carry another request.
    ...(err.status === 413 ? { connection: "close" } : {}),
  });
  res.end(body);
  return true;
}
