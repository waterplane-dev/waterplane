/** Desktop-host introspection: resource load + screen capture of the machine
 *  running the daemon. The phone uses these to peek at "what's going on there". */
import os from "node:os";
import { spawn } from "node:child_process";
import type { HostStat } from "@waterplane/shared";
import { execFileP as pexecFile } from "./proc.js";


/** CPU/memory/load snapshot of this machine. Cheap, synchronous, no shell. */
export function hostStat(): HostStat {
  const load = os.loadavg();
  const cores = os.cpus().length || 1;
  return {
    platform: process.platform,
    hostname: os.hostname(),
    cores,
    loadavg: [load[0], load[1], load[2]],
    cpuPct: Math.round((load[0] / cores) * 100),
    memTotal: os.totalmem(),
    memFree: os.freemem(),
    uptime: os.uptime(),
    checkedAt: Date.now(),
  };
}

export interface GpuStat { pct: number; memInUse: number }

/**
 * Parse `ioreg -r -d 1 -c IOAccelerator`'s text dump for the two
 * `PerformanceStatistics` fields this app draws.
 *
 * Exported so the shape is pinned with no GPU present — the same reason
 * `parsePs` is exported from `localrt.ts`. This is not plist/JSON, just a
 * key=value dump; it degrades to `null` on a miss rather than a 0 standing in
 * for "unreadable" (this repo's rule: a heuristic degrades to absent, never
 * to a plausible wrong number).
 *
 * **Both keys are read from the SAME `PerformanceStatistics` block, and only
 * when there is exactly one.** A machine with two accelerators (an Intel
 * iGPU+dGPU pair, a Mac Pro) prints one block per device; scanning the two
 * keys independently over the whole dump could pair one device's utilization
 * with the OTHER device's memory figure — a composite neither device reports,
 * which is the "plausible wrong number" this rule exists to forbid. Several
 * blocks is therefore `null`, the same as none.
 */
export function parseGpuIoreg(text: string): GpuStat | null {
  const blocks = [...text.matchAll(/"PerformanceStatistics"\s*=\s*\{([^}]*)\}/g)];
  if (blocks.length !== 1) return null;
  const body = blocks[0][1];
  const pct = /"Device Utilization %"=(\d+)/.exec(body);
  const mem = /"In use system memory"=(\d+)/.exec(body);
  if (!pct || !mem) return null;
  return { pct: Number(pct[1]), memInUse: Number(mem[1]) };
}

/**
 * GPU utilization + memory in use, off `ioreg` — Apple Silicon only. No other
 * platform has a reader here, so this returns `null` on anything but macOS
 * with no subprocess spawned at all, and `null` again on any failure of the
 * one it does spawn (`ioreg` missing, no accelerator, unparsable output).
 * Costs one subprocess call, so it is only worth polling from a loop that is
 * already paying for one (`localrt.ts`).
 */
export async function readGpuStat(): Promise<GpuStat | null> {
  if (process.platform !== "darwin") return null;
  try {
    const { stdout } = await pexecFile("ioreg", ["-r", "-d", "1", "-c", "IOAccelerator"],
      { timeout: 1500, maxBuffer: 8 * 1024 * 1024 });
    return parseGpuIoreg(stdout);
  } catch {
    return null;
  }
}

/**
 * Capture the whole desktop screen to `destPath` (a .png). Platform-specific;
 * throws if no capture tool is available. macOS uses the built-in
 * `screencapture`; Linux tries common tools in turn.
 */
export async function takeScreenshot(destPath: string): Promise<void> {
  if (process.platform === "darwin") {
    await pexecFile("screencapture", ["-x", destPath]); // -x = silent (no shutter)
    return;
  }
  if (process.platform === "linux") {
    const attempts: [string, string[]][] = [
      ["gnome-screenshot", ["-f", destPath]],
      ["scrot", ["-o", destPath]],
      ["import", ["-window", "root", destPath]], // ImageMagick
    ];
    let lastErr: unknown;
    for (const [bin, args] of attempts) {
      try { await pexecFile(bin, args); return; } catch (e) { lastErr = e; }
    }
    throw new Error(`no screenshot tool (install gnome-screenshot/scrot/imagemagick): ${String(lastErr)}`);
  }
  throw new Error(`screenshot unsupported on ${process.platform}`);
}

/**
 * Set the desktop host's system clipboard to `text` (phone→desktop paste).
 * Platform-specific: macOS `pbcopy`, Windows `clip`, Linux tries the common
 * tools in turn. Throws if no clipboard tool is available.
 */
export async function setHostClipboard(text: string): Promise<void> {
  const candidates: [string, string[]][] =
    process.platform === "darwin" ? [["pbcopy", []]]
    : process.platform === "win32" ? [["clip", []]]
    : [["wl-copy", []], ["xclip", ["-selection", "clipboard"]], ["xsel", ["--clipboard", "--input"]]];
  let lastErr: unknown;
  for (const [bin, args] of candidates) {
    try { await pipeToStdin(bin, args, text); return; } catch (e) { lastErr = e; }
  }
  throw new Error(`no clipboard tool available on ${process.platform}: ${String(lastErr)}`);
}

/** Run `bin args`, writing `input` to its stdin; resolve on clean exit. */
function pipeToStdin(bin: string, args: string[], input: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args);
    child.on("error", reject); // ENOENT: tool not installed
    child.stdin.on("error", reject); // EPIPE: tool bailed before reading
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${bin} exited ${code}`))));
    child.stdin.end(input);
  });
}
