/** Desktop-host introspection: resource load + screen capture of the machine
 *  running the daemon. The phone uses these to peek at "what's going on there". */
import os from "node:os";
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { PLUGIN_READER_NAME_RE, PLUGIN_SCREEN_CAPTURE_TIMEOUT_MS, type HostStat, type PluginScreenCapture, type PluginScreenStill } from "@waterplane/shared";
import { execFileP as pexecFile } from "./proc.js";
import { encodePs, isWsl, psQuote } from "./ocrlocal.js";
import { windowsCpuNow } from "./wincpu.js";


/** CPU/memory/load snapshot of this machine. Cheap, synchronous, no shell. */
export function hostStat(): HostStat {
  const load = os.loadavg();
  const cores = os.cpus().length || 1;
  const win = windowsCpuNow();
  return {
    platform: process.platform,
    hostname: os.hostname(),
    cores,
    loadavg: [load[0], load[1], load[2]],
    // Under WSL the load average is the VM's own; Task Manager shows Windows-wide.
    cpuPct: win ? Math.round(win.pct) : Math.round((load[0] / cores) * 100),
    ...(win ? { cpuSource: "windows" as const } : {}),
    memTotal: os.totalmem(),
    memFree: os.freemem(),
    uptime: os.uptime(),
    checkedAt: Date.now(),
  };
}

export interface GpuStat { pct: number; memInUse: number }

/**
 * The bodies `/"PerformanceStatistics"\s*=\s*\{([^}]*)\}/g` would capture, without its `[^}]*`
 * re-scanning to the end from every opener when no `}` follows (quadratic on a dump of
 * unclosed openers). The head is matched alone; the body is the text up to the next `}`. With
 * no `}` after one opener there is none after any later one either, so the scan stops there.
 */
function perfBlocks(text: string): string[] {
  const head = /"PerformanceStatistics"\s*=\s*\{/g;
  const out: string[] = [];
  for (let m = head.exec(text); m; m = head.exec(text)) {
    const start = m.index + m[0].length;
    const close = text.indexOf("}", start);
    if (close < 0) break;
    out.push(text.slice(start, close));
    head.lastIndex = close + 1;
  }
  return out;
}

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
  const blocks = perfBlocks(text);
  if (blocks.length !== 1) return null;
  const body = blocks[0];
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
 * `screencapture`; a host in WSL asks Windows (PowerShell, the primary display,
 * DPI-aware so a scaled display is not captured at its logical size); other Linux
 * tries common tools in turn.
 */
export async function takeScreenshot(destPath: string): Promise<void> {
  if (process.platform === "darwin") {
    await pexecFile("screencapture", ["-x", destPath]); // -x = silent (no shutter)
    return;
  }
  if (process.platform === "linux" && isWsl()) {
    const { stdout } = await pexecFile("wslpath", ["-w", destPath], { timeout: 5000 });
    await pexecFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodePs(windowsScreenshotScript(stdout.trim()))], { timeout: 30_000 });
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

/** Screen captures contributed by plugins (`api.screenCapture`), by name. Looked up at CALL time, so
 *  one whose plugin was switched off takes nothing. */
const CAPTURES = new Map<string, PluginScreenCapture>();

/** Register a contributed screen capture. Throws a sentence on a bad or taken name. */
export function registerScreenCapture(name: string, capture: PluginScreenCapture): () => void {
  if (typeof name !== "string" || !PLUGIN_READER_NAME_RE.test(name)) {
    throw new Error(`a screen capture name must be a short lowercase word (letters, digits, dashes); got ${JSON.stringify(name)}`);
  }
  if (CAPTURES.has(name)) throw new Error(`a screen capture called \`${name}\` already exists`);
  if (typeof (capture as unknown as Record<string, unknown> | null)?.still !== "function") throw new Error(`the screen capture \`${name}\` has no still()`);
  CAPTURES.set(name, capture);
  return () => { if (CAPTURES.get(name) === capture) CAPTURES.delete(name); };
}

/** One contributed capture, asked once; a throw or a hang is a note. */
async function askCapture(name: string, capture: PluginScreenCapture): Promise<PluginScreenStill> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const r = await Promise.race([
      capture.still(),
      new Promise<PluginScreenStill>((res) => { timer = setTimeout(() => res({ note: `${name} did not answer in ${PLUGIN_SCREEN_CAPTURE_TIMEOUT_MS / 1000} s.` }), PLUGIN_SCREEN_CAPTURE_TIMEOUT_MS); }),
    ]);
    if (r && "jpeg" in r && r.jpeg?.byteLength) return r;
    return { note: r && "note" in r && r.note ? r.note : `${name} gave no picture.` };
  } catch (e) {
    return { note: `${name}: ${String((e as Error).message || e)}` };
  } finally {
    clearTimeout(timer);
  }
}

/** Why the core's own tool took no picture, for a person. macOS says only "could not create image
 *  from display", whether the permission is missing or there is no display to read: named as the usual
 *  reason, never as the reason. The grant is on the node BINARY, so a node upgrade loses it. */
export function screenshotProblem(err: unknown, platform: NodeJS.Platform = process.platform, node: string = process.execPath): string {
  const msg = String((err as Error)?.message || err).trim();
  if (platform !== "darwin" || !/could not create image/i.test(msg)) return msg;
  let real = node;
  try { real = realpathSync(node); } catch { /* as given */ }
  return `macOS gave the host no picture of the screen. The usual reason: Screen Recording is not granted to this node (${real}), and macOS forgets that grant when node is upgraded. On the Mac, open System Settings → Privacy & Security → Screen Recording and turn on node.`;
}

/**
 * The desktop's screen into a new file: the core's own tool (a PNG), and only when that fails each
 * contributed capture in turn (a JPEG), whose helper may hold the permission node lost. `newPath`
 * makes the target per extension. Throws a sentence naming every reason.
 */
export async function captureDesktop<T extends { full: string }>(newPath: (ext: ".png" | ".jpg") => T, native: (dest: string) => Promise<void> = takeScreenshot): Promise<T> {
  const png = newPath(".png");
  try {
    await native(png.full);
    return png;
  } catch (e) {
    const why = [screenshotProblem(e)];
    for (const [name, capture] of [...CAPTURES]) {
      const r = await askCapture(name, capture);
      if ("note" in r) { why.push(r.note); continue; }
      const jpg = newPath(".jpg");
      await writeFile(jpg.full, r.jpeg);
      return jpg;
    }
    throw new Error(why.join(" "));
  }
}

/** PowerShell 5.1: the primary display at its real pixel size, as a PNG at `winPath`. */
export function windowsScreenshotScript(winPath: string): string {
  return `$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public static class WpDpi { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }'
$null = [WpDpi]::SetProcessDPIAware()
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)
$bmp.Save(${psQuote(winPath)}, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
`;
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
