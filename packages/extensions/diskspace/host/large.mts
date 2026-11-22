/**
 * "Scan for large files" — no model call, no `claude -p`, zero tokens. Show-only: nothing here has
 * a delete path.
 *
 * mac: Spotlight's index (`mdfind -onlyin $HOME`), under a second. A plain `find` over a Mac home
 * (Library, millions of files) was measured at 120 s with ZERO files back, every time — so the
 * search always "timed out". Spotlight does not index hidden folders, so the result says so; if
 * mdfind cannot run (Spotlight off), the `find` below runs instead.
 *
 * Elsewhere: a plain `find` over $HOME, one filesystem (`-xdev`), the folders the lists already
 * cover pruned, killed at its time bound with whatever it found so far reported as PARTIAL.
 */
import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { LARGE_TOP, type LargeFile } from "../shared/wire.mjs";
import { coveredPaths, tilde, type Roots } from "./candidates.mjs";
import { pool, run } from "./run.mjs";

export interface LargeOutcome { items: LargeFile[]; found: number; stoppedAfterS: number | null; tookMs: number; error?: string; note?: string }

export const SPOTLIGHT_NOTE = "Found with Spotlight's index: hidden folders (a dot in front of the name) and folders Spotlight is told to skip are not searched.";

/** `find -size` form (`+500M`, `+2G`, `+1024k`) as bytes; null for anything else. */
export function sizeBytes(arg: string): number | null {
  const m = /^\+(\d+)([kMG])$/.exec(arg);
  if (!m) return null;
  return Number(m[1]) * { k: 1024, M: 1024 ** 2, G: 1024 ** 3 }[m[2] as "k" | "M" | "G"];
}

/** `more`: other disks to search besides $HOME (an external disk's mount point). */
export function mdfindArgs(r: Roots, bytes: number, more: readonly string[] = []): string[] {
  return [...[r.home, ...more].flatMap((p) => ["-onlyin", p]), `kMDItemFSSize > ${bytes}`];
}

/** Where the search looks besides $HOME, and how a found file is matched to its disk. */
export interface LargeOpts { mounts?: readonly string[]; volOf?: (path: string) => Promise<string | undefined> }

/** Drop what a list already covers (the same folders `find` prunes). */
export function outsideCovered(paths: readonly string[], r: Roots): string[] {
  const covered = coveredPaths(r).map((p) => (p.endsWith("/") ? p : `${p}/`));
  return paths.filter((p) => !covered.some((c) => p.startsWith(c)));
}

async function sized(paths: readonly string[], r: Roots, o: LargeOpts): Promise<LargeFile[]> {
  const stats = await pool([...paths], 8, async (p): Promise<LargeFile | null> => {
    try {
      const s = await stat(p);
      if (!s.isFile()) return null;
      const vol = await o.volOf?.(p);
      return { path: tilde(p, r.home), sizeKb: Math.round(s.size / 1024), mtime: s.mtimeMs, ...(vol ? { vol } : {}) };
    } catch { return null; }
  });
  return stats.filter((x): x is LargeFile => x != null).sort((a, b) => b.sizeKb - a.sizeKb);
}

/** Spotlight's answer, or null when it cannot give one (then `find` runs). */
async function spotlight(r: Roots, t0: number, o: LargeOpts): Promise<LargeOutcome | null> {
  const bytes = sizeBytes(r.largeMinSize);
  if (!r.mdfindBin || bytes == null) return null;
  const res = await run(r.mdfindBin, mdfindArgs(r, bytes, o.mounts), { timeoutMs: 30_000 });
  if (res.code !== 0 || res.timedOut) return null;
  const items = await sized(outsideCovered(res.stdout.split("\n").filter(Boolean), r), r, o);
  return { items: items.slice(0, LARGE_TOP), found: items.length, stoppedAfterS: null, tookMs: Date.now() - t0, note: SPOTLIGHT_NOTE };
}

export function findArgs(r: Roots): string[] {
  const prune = coveredPaths(r).flatMap((p, i) => (i ? ["-o", "-path", p] : ["-path", p]));
  return [r.home, "-xdev", "(", ...prune, ")", "-prune", "-o", "-type", "f", "-size", r.largeMinSize, "-print"];
}

/** mac: Spotlight over $HOME and `o.mounts` (other disks). Else, or when Spotlight cannot answer: `find` over $HOME. */
export async function findLarge(r: Roots, o: LargeOpts = {}): Promise<LargeOutcome> {
  const t0 = Date.now();
  return (await spotlight(r, t0, o)) ?? findWalk(r, t0, o);
}

function findWalk(r: Roots, t0: number, o: LargeOpts): Promise<LargeOutcome> {
  return new Promise((resolve) => {
    const paths: string[] = [];
    let buf = "";
    let stopped = false;
    let spawnError: string | undefined;
    const child = spawn(r.findBin, findArgs(r), { stdio: ["ignore", "pipe", "ignore"] });
    const timer = setTimeout(() => { stopped = true; child.kill("SIGKILL"); }, r.largeLimitMs);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d: string) => {
      buf += d;
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const l of lines) if (l) paths.push(l);
    });
    child.on("error", (e) => { spawnError = e.message; });
    child.on("close", async () => {
      clearTimeout(timer);
      if (buf && !stopped) paths.push(buf); // a half line from a killed find is dropped
      const items = await sized(paths, r, o);
      resolve({
        items: items.slice(0, LARGE_TOP), found: items.length, tookMs: Date.now() - t0,
        stoppedAfterS: stopped ? Math.round(r.largeLimitMs / 1000) : null,
        ...(spawnError ? { error: `find could not run: ${spawnError}` } : {}),
      });
    });
  });
}
