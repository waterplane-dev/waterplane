/**
 * Server-side thumbnails — the single biggest bandwidth item on a bad link.
 *
 * The gallery grid, the new-image strip and the backlog attachment row all
 * render `<img src=…/artifact?path=…>`, i.e. the ORIGINAL file. Measured on
 * this machine's outbox dirs: 1170 images, 607 KB average, 14 MB worst case —
 * so one scroll through a 300-row grid is well over 100 MB of a phone's
 * tethered/roaming data. A 320 px JPEG of the same screenshot is ~15-30 KB.
 *
 * No image library is added for this: node has no decoder and `sharp` is a
 * native dep that would have to build on every host. Instead we shell out to
 * whatever the platform already ships — `sips` on macOS (part of the OS),
 * ImageMagick or ffmpeg elsewhere — exactly like `host.ts` does for screen
 * capture. If none is available, `thumbnail()` returns null and the caller
 * serves the original, so the feature degrades to today's behaviour.
 *
 * Results are cached in `<STATE_DIR>/thumbs/` keyed by path+mtime+size+width,
 * so a regenerated file at the same path gets a fresh thumb and the cache never
 * serves a stale one. The dir is pruned to CACHE_MAX_BYTES (oldest first).
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { tmpdir } from "node:os";
import { BRAND } from "@waterplane/shared";
import { hostStateDir } from "./branddirs.js";
import { env } from "./env.js";

const ENABLED = env("THUMBS") !== "0";
/** Widths the client may ask for. An open list would let a caller fill the cache. */
const WIDTHS = [160, 240, 320, 480, 640, 960, 1280, 1600];
/** Below this the original is already thumbnail-sized — re-encoding costs more than it saves. */
const MIN_SOURCE_BYTES = 48 * 1024;
const CACHE_MAX_BYTES = 256 * 1024 * 1024;
/** Guard against a pathological source (a 200 MP PNG) wedging a converter. */
const CONVERT_TIMEOUT_MS = 20_000;

const THUMBABLE = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".heic", ".heif", ".tif", ".tiff"]);
const VIDEO = new Set([".mp4", ".webm", ".mov", ".m4v", ".ogv", ".mkv"]);

let cacheDir = "";
/** Set once at boot; until then thumbnails are off (no root = nowhere to cache). */
export function initThumbs(root: string): void {
  cacheDir = join(hostStateDir(root), "thumbs");
  try { mkdirSync(cacheDir, { recursive: true }); } catch { cacheDir = ""; }
}

/** Snap a requested width to the allow-list, or null if it isn't one. */
export function thumbWidth(raw: string | null): number | null {
  const n = Number(raw);
  return Number.isFinite(n) && WIDTHS.includes(n) ? n : null;
}

export function canThumb(path: string): boolean {
  const ext = extname(path).toLowerCase();
  return THUMBABLE.has(ext) || VIDEO.has(ext);
}

function run(cmd: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok: boolean) => { if (!done) { done = true; resolve(ok); } };
    try {
      const p = spawn(cmd, args, { stdio: "ignore" });
      const timer = setTimeout(() => { try { p.kill("SIGKILL"); } catch { /* gone */ } finish(false); }, CONVERT_TIMEOUT_MS);
      p.on("error", () => { clearTimeout(timer); finish(false); });
      p.on("exit", (code) => { clearTimeout(timer); finish(code === 0); });
    } catch {
      finish(false);
    }
  });
}

/** Which converters exist here — probed once, lazily. */
let tools: { sips: boolean; magick: string | null; ffmpeg: boolean } | null = null;
async function probeTools() {
  if (tools) return tools;
  const has = async (bin: string, ...args: string[]) => run(bin, args);
  const magick = (await has("magick", "-version")) ? "magick"
    : (await has("convert", "-version")) ? "convert" : null;
  tools = {
    sips: process.platform === "darwin" && (await has("sips", "--version")),
    magick,
    ffmpeg: await has("ffmpeg", "-version"),
  };
  return tools;
}

/** Encode `src` down to `width` px wide as JPEG at `out`. */
async function convert(src: string, out: string, width: number, isVideo: boolean): Promise<boolean> {
  const t = await probeTools();
  if (isVideo) {
    // One frame a second in (past a black lead-in), scaled, never upscaled.
    return t.ffmpeg && run("ffmpeg", [
      "-y", "-loglevel", "error", "-ss", "1", "-i", src, "-frames:v", "1",
      "-vf", `scale='min(${width},iw)':-2`, "-q:v", "6", out,
    ]);
  }
  if (t.sips) {
    // sips resamples in place-ish: --out writes the copy. -Z bounds the LONGEST
    // edge, which is what we want for a grid cell either orientation.
    return run("sips", ["-s", "format", "jpeg", "-s", "formatOptions", "60", "-Z", String(width), src, "--out", out]);
  }
  if (t.magick) {
    // `Wx>` = shrink only. -auto-orient so an EXIF-rotated phone photo isn't sideways.
    // Both `magick` and legacy `convert` take `<in> [ops] <out>`.
    return run(t.magick, [src, "-auto-orient", "-resize", `${width}x${width}>`, "-quality", "60", "-strip", out]);
  }
  if (t.ffmpeg) {
    return run("ffmpeg", ["-y", "-loglevel", "error", "-i", src, "-vf", `scale='min(${width},iw)':-2`, "-q:v", "6", out]);
  }
  return false;
}

/** Trim the cache to CACHE_MAX_BYTES, oldest-used first. Best-effort. */
function prune(): void {
  if (!cacheDir) return;
  try {
    const files = readdirSync(cacheDir).map((n) => {
      try { const st = statSync(join(cacheDir, n)); return { n, size: st.size, at: st.mtimeMs }; } catch { return null; }
    }).filter((x): x is { n: string; size: number; at: number } => !!x);
    let total = files.reduce((s, f) => s + f.size, 0);
    if (total <= CACHE_MAX_BYTES) return;
    files.sort((a, b) => a.at - b.at);
    for (const f of files) {
      if (total <= CACHE_MAX_BYTES * 0.8) break;
      try { rmSync(join(cacheDir, f.n)); total -= f.size; } catch { /* raced */ }
    }
  } catch { /* best-effort */ }
}

/** In-flight generations, so N parallel grid requests for one file run ONE convert. */
const inflight = new Map<string, Promise<Buffer | null>>();

export interface Thumb { buf: Buffer; mime: string; key: string }

/**
 * A JPEG thumbnail of `absPath` at `width`, or null when we can't/shouldn't make
 * one (disabled, no converter, unsupported type, source already small enough,
 * conversion failed). Null always means "serve the original".
 */
export async function thumbnail(absPath: string, width: number): Promise<Thumb | null> {
  if (!ENABLED || !cacheDir || !canThumb(absPath)) return null;
  let st;
  try { st = statSync(absPath); } catch { return null; }
  const isVideo = VIDEO.has(extname(absPath).toLowerCase());
  // A small still is already its own thumbnail. A video never is — one frame of
  // it is always smaller than the file, so size doesn't gate there.
  if (!isVideo && st.size < MIN_SOURCE_BYTES) return null;

  const key = createHash("sha1").update(`${absPath}\0${st.mtimeMs}\0${st.size}\0${width}`).digest("hex");
  const cached = join(cacheDir, `${key}.jpg`);
  if (existsSync(cached)) {
    try { return { buf: readFileSync(cached), mime: "image/jpeg", key }; } catch { /* fall through, regenerate */ }
  }

  let job = inflight.get(key);
  if (!job) {
    job = (async () => {
      // Convert to a temp path and rename in, so a concurrent reader never sees
      // a half-written JPEG at the cache path.
      const tmp = join(tmpdir(), `${BRAND.slug}-thumb-${key}-${process.pid}.jpg`);
      try {
        const ok = await convert(absPath, tmp, width, isVideo);
        if (!ok || !existsSync(tmp)) return null;
        const buf = readFileSync(tmp);
        // A "thumbnail" bigger than the source is a failed optimisation — drop it.
        if (!isVideo && buf.length >= st.size) return null;
        try { renameSync(tmp, cached); prune(); } catch { /* cache write is optional */ }
        return buf;
      } catch {
        return null;
      } finally {
        try { if (existsSync(tmp)) rmSync(tmp); } catch { /* gone */ }
      }
    })().finally(() => inflight.delete(key));
    inflight.set(key, job);
  }
  const buf = await job;
  return buf ? { buf, mime: "image/jpeg", key } : null;
}

/** What this cache holds right now: files and bytes. Its own function because
 *  the storage report must not readdir a directory whose layout is this
 *  module's business — `.jpg` keyed by a hash is an implementation detail, and
 *  a foreign walk of it would break the day it stops being one. */
export function thumbCacheUsage(): { count: number; bytes: number } | null {
  if (!cacheDir) return null;
  try {
    let count = 0;
    let bytes = 0;
    for (const n of readdirSync(cacheDir)) {
      try {
        const st = statSync(join(cacheDir, n));
        if (!st.isFile()) continue;
        count++;
        bytes += st.size;
      } catch { /* raced with a prune */ }
    }
    return { count, bytes };
  } catch {
    return null;
  }
}

/**
 * Throw away cached thumbnails written at or before `before` — the storage
 * screen's clear.
 *
 * **The owner clears its own cache.** A foreign `rmSync` over this directory
 * would race `thumbnail()`'s rename-in at a path an `inflight` promise is
 * about to resolve from, and would have to know the naming scheme to avoid
 * deleting a partial file it does not own.
 *
 * **`before` is the contract, not a name list.** A person was shown "1541
 * files · 21 MB" measured at an instant, and the promise a clear makes is that
 * nothing outside that reading goes. Sending 1541 filenames would keep the same
 * promise with a 90 KB request body; an instant keeps it in one number — and
 * unlike the transport sweep, the individual rows here were never the decision,
 * because nobody chooses which thumbnails to keep.
 *
 * Files only, no recursion, symlinks skipped: the cache is flat by
 * construction, so anything else in there is not this module's and is left
 * alone.
 */
export function clearThumbCache(before: number): { deleted: number; bytes: number; failed: number } {
  const out = { deleted: 0, bytes: 0, failed: 0 };
  if (!cacheDir) return out;
  let names: string[];
  try { names = readdirSync(cacheDir); } catch { return out; }
  for (const n of names) {
    const full = join(cacheDir, n);
    let st;
    try { st = lstatSync(full); } catch { continue; }
    if (!st.isFile()) continue;              // a symlink or a directory is not ours
    if (st.mtimeMs > before) continue;       // written since the reading — never on screen
    try { rmSync(full); out.deleted++; out.bytes += st.size; } catch { out.failed++; }
  }
  return out;
}
