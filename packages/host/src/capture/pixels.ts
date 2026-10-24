/**
 * The pixel toolkit, shelled out — `thumbs.ts`'s model, for the same reason.
 *
 * Node has no image decoder and `sharp` is banned repo-wide (a native dep that
 * has to build on every host). So every measurement here is either a header
 * read or a subprocess, and EVERY one of them degrades to `null` rather than to
 * a number nobody measured. A `changedPct` of 0 means "ImageMagick compared the
 * two files and found no differing pixels"; `null` means "nothing on this
 * machine could look". They are opposite facts and the sidecar keeps them apart
 * (`diff.changedPct` vs `diff.reason`).
 *
 * ── Why byte-equality comes first ──────────────────────────────────────────
 *
 * The settle check only ever asks "did the screen stop moving", and two PNGs of
 * an identical screen written by one encoder are byte-identical. That check
 * needs no tool at all, which is what lets a machine with no ImageMagick still
 * reach `settled:stable`. The expensive comparison is only needed for the WATCH
 * gate, where the question is "how MUCH did it change" and a threshold is being
 * applied — and that one is allowed to come back `null`.
 */
import { spawn } from "node:child_process";
import { openSync, readSync, closeSync, statSync, readFileSync } from "node:fs";
import type { CaptureViewport } from "@waterplane/shared";
import { magickEnv } from "../thumbs.js";

/** A pathological source must not wedge a converter for ever. */
const TOOL_TIMEOUT_MS = 20_000;
/** Frames bigger than this are not byte-compared — a whole-desktop retina grab
 *  is ~10 MB and two of them per settle sample is not worth the read. */
const BYTE_COMPARE_MAX = 24 * 1024 * 1024;
/**
 * Below this standard deviation (ImageMagick's `%[fx:standard_deviation]`,
 * normalised 0–1) a frame is one flat colour: a page that never painted, a
 * simulator showing its loading fill, a black screen. Not "dark" — dark UI has
 * text in it, which is variance.
 */
export const BLANK_SD = 0.004;

interface Spawned { code: number | null; out: string; err: string }

function run(cmd: string, args: string[], env?: Record<string, string> | null): Promise<Spawned | null> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: Spawned | null) => { if (!done) { done = true; resolve(v); } };
    try {
      const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], ...(env ? { env: { ...process.env, ...env } } : {}) });
      let out = "", err = "";
      p.stdout.on("data", (d) => { out += d.toString(); });
      p.stderr.on("data", (d) => { err += d.toString(); });
      const timer = setTimeout(() => { try { p.kill("SIGKILL"); } catch { /* gone */ } finish(null); }, TOOL_TIMEOUT_MS);
      p.on("error", () => { clearTimeout(timer); finish(null); });
      p.on("exit", (code) => { clearTimeout(timer); finish({ code, out, err }); });
    } catch {
      finish(null);
    }
  });
}

/**
 * Which pixel tools exist here — probed once, lazily, exactly like
 * `thumbs.ts`'s `probeTools()`.
 *
 * ImageMagick 7 puts everything behind one `magick` binary; 6 ships `identify`
 * and `compare` as their own. Both are stored as full argv prefixes so no
 * caller has to know which generation it got.
 */
export interface PixelTools {
  identify: string[] | null;
  compare: string[] | null;
}

let tools: PixelTools | null = null;

export async function probePixelTools(): Promise<PixelTools> {
  if (tools) return tools;
  const ok = async (cmd: string, args: string[]) => {
    const r = await run(cmd, args);
    return !!r && r.code === 0;
  };
  if (await ok("magick", ["-version"])) {
    tools = { identify: ["magick", "identify"], compare: ["magick", "compare"] };
  } else {
    tools = {
      identify: (await ok("identify", ["-version"])) ? ["identify"] : null,
      // IM6's `compare` exits 1 on "the images differ", which is the NORMAL
      // outcome — so its presence is probed with `-version`, which exits 0.
      compare: (await ok("compare", ["-version"])) ? ["compare"] : null,
    };
  }
  return tools;
}

/** One human sentence naming what is missing, for `diff.reason`. */
export function pixelToolReason(t: PixelTools): string {
  return t.compare
    ? "measured with ImageMagick"
    : "no pixel tool on this machine (install ImageMagick for a measured difference)";
}

/**
 * Are these two frames the same bytes?
 *
 * The settle check. No tool, no decode, no approximation: PNG encoders are
 * deterministic, so an unchanged screen round-trips to an identical file. A
 * `false` here is never "probably moved" — it is "these files differ", which on
 * a noisy capture path (a desktop grab with a blinking cursor in it) is the
 * honest answer and simply means the run keeps sampling until its cap.
 */
export function framesIdentical(a: string, b: string): boolean {
  try {
    const sa = statSync(a), sb = statSync(b);
    if (sa.size !== sb.size) return false;
    if (sa.size > BYTE_COMPARE_MAX) return false;
    return readFileSync(a).equals(readFileSync(b));
  } catch {
    return false;
  }
}

/**
 * Geometry, out of the PNG's own IHDR chunk.
 *
 * A 24-byte header read, not an image library: the signature and then two
 * big-endian uint32s at a fixed offset. `null` when the file is not a PNG or is
 * truncated — which is exactly the `window`-backend case the sidecar's optional
 * `viewport` exists for, and the verdict's `n/a` arm prints.
 */
export function pngSize(path: string): CaptureViewport | null {
  let fd = -1;
  try {
    fd = openSync(path, "r");
    const buf = Buffer.alloc(24);
    if (readSync(fd, buf, 0, 24, 0) < 24) return null;
    if (buf.readUInt32BE(0) !== 0x89504e47) return null;         // \x89PNG
    if (buf.toString("latin1", 12, 16) !== "IHDR") return null;
    const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
    if (!w || !h || w > 100_000 || h > 100_000) return null;
    return { w, h };
  } catch {
    return null;
  } finally {
    if (fd >= 0) { try { closeSync(fd); } catch { /* gone */ } }
  }
}

/**
 * How flat this frame is, 0 (one solid colour) to ~1. `null` with no tool.
 *
 * Never turned into a boolean here: the caller compares against `BLANK_SD` and
 * an absent reading means the blank check did not run, which the verdict says
 * rather than guessing "not blank".
 */
export async function blankVariance(path: string): Promise<number | null> {
  const t = await probePixelTools();
  if (!t.identify) return null;
  // No policed environment: absent, never an unpoliced identify (`thumbs.ts`).
  const env = magickEnv();
  if (!env) return null;
  const [bin, ...pre] = t.identify;
  const r = await run(bin, [...pre, "-format", "%[fx:standard_deviation]", `png:${path}`], env);
  if (!r || r.code !== 0) return null;
  const n = Number(r.out.trim().split(/\s+/)[0]);
  return Number.isFinite(n) ? n : null;
}

/**
 * Percent of pixels that differ between two frames, or `null` when nothing here
 * could measure it.
 *
 * `compare -metric AE` counts absolutely-different pixels and prints the count
 * on STDERR; it exits 1 when the images differ, which is the expected outcome
 * and not an error. Exit 2 (different geometry, unreadable file) is a real
 * failure and comes back `null` — a resized window is not "0% changed".
 */
export async function changedPct(a: string, b: string): Promise<number | null> {
  if (framesIdentical(a, b)) return 0;
  const t = await probePixelTools();
  if (!t.compare) return null;
  const size = pngSize(a);
  const other = pngSize(b);
  if (!size || !other || size.w !== other.w || size.h !== other.h) return null;
  const [bin, ...pre] = t.compare;
  const r = await run(bin, [...pre, "-metric", "AE", a, b, "null:"]);
  if (!r || (r.code !== 0 && r.code !== 1)) return null;
  const m = /(\d+(?:\.\d+)?)/.exec(r.err.trim() || r.out.trim());
  if (!m) return null;
  const diff = Number(m[1]);
  const total = size.w * size.h;
  if (!Number.isFinite(diff) || total <= 0) return null;
  return Math.round((diff / total) * 1000) / 10;
}
