/**
 * The whole picture's words, read ON THIS DESKTOP — the "send the text, not the
 * photo" path of the annotator (`POST /api/host/ocr`).
 *
 * ── Why this exists beside `readtext.ts` ────────────────────────────────────
 *
 * The highlighter's reader (`readImageText`) sends one marked band to Gemini.
 * That is fine for a strip of a screenshot. It is the wrong tool for the case
 * that asked for this: a PHOTO of another screen — an error a person cannot
 * copy, on a machine they cannot screenshot — taken with their own face, room
 * or colleague in the frame. What they want an agent to see is the words; what
 * they do not want is the picture leaving the house, to an agent OR to a second
 * cloud model. So the reading is local and nothing else is:
 *
 *  - macOS: Apple's Vision framework (`VNRecognizeTextRequest`, accurate +
 *    language correction), through a tiny Swift helper compiled ONCE with
 *    `swiftc` into the state dir. Measured on a 1.4 MB phone photo: the
 *    interpreted `swift file.swift` took ~29 s (compile every time); the
 *    compiled helper is the read alone.
 *  - Windows (WSL2, the supported route, or a native host): the OS's own
 *    `Windows.Media.Ocr`, driven through `powershell.exe` — on-device, nothing
 *    to install beyond a language with OCR, which most installs already have.
 *    From WSL the picture is copied to the Windows %TEMP% by PowerShell itself
 *    and deleted there in its own `finally`.
 *  - elsewhere, or when Windows OCR has no language: `tesseract` on PATH.
 *  - neither: a SENTENCE naming what to install, as a 200.
 *
 * Same posture as `readImageText` and `dictate.ts`: it DECIDES nothing. The text
 * goes back to the phone, which shows it in an editable box; the person edits or
 * drops it, and only what they then send reaches an agent. There is no repo in
 * this module, nothing is written anywhere but a `tmpdir()` file removed in a
 * `finally`, and the failure log never carries the words.
 *
 * Degrades to a REASON, never to a guess: off, no engine, unreadable image,
 * an engine that failed and a picture with no words are different sentences.
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BRAND, envName } from "@waterplane/shared";
import { env, STATE_DIR } from "./env.js";

export type OcrEngine = "vision" | "windows" | "tesseract";
export type OcrStatus = { available: true; engine: OcrEngine } | { available: false; reason: string };
export type OcrAnswer = { text: string; engine: string; ms: number } | { error: string };

const RUN_TIMEOUT_MS = 60_000;
const COMPILE_TIMEOUT_MS = 180_000;
/** A photo of a screen is a few thousand characters at most; past this the
 *  engine is reading wallpaper, and the phone's box would be unusable anyway. */
export const OCR_MAX_CHARS = 40_000;

/** Where the compiled Vision helper lives — outside every repo, rebuilt when
 *  the source below changes (the version is in the name). */
const HELPER_VERSION = 1;
function helperPath(): string { return join(STATE_DIR, "bin", `ocr-vision-v${HELPER_VERSION}`); }

/** The Swift helper: one image path in, recognised lines out, in reading order.
 *  Exit 2 = the image could not be decoded (a reason, not a crash). */
export const VISION_SWIFT = `import Foundation
import Vision
import AppKit
let path = CommandLine.arguments[1]
guard let img = NSImage(contentsOfFile: path),
      let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
  FileHandle.standardError.write("cannot decode image\\n".data(using: .utf8)!)
  exit(2)
}
let req = VNRecognizeTextRequest()
req.recognitionLevel = .accurate
req.usesLanguageCorrection = true
if #available(macOS 13.0, *) { req.automaticallyDetectsLanguage = true }
do { try VNImageRequestHandler(cgImage: cg, options: [:]).perform([req]) } catch {
  FileHandle.standardError.write("vision failed: \\(error)\\n".data(using: .utf8)!)
  exit(3)
}
for o in (req.results ?? []) { if let c = o.topCandidates(1).first { print(c.string) } }
`;

function run(bin: string, args: string[], timeout: number): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout, maxBuffer: 8 * 1024 * 1024 }, (err: any, stdout, stderr) => {
      const code = err ? (typeof err.code === "number" ? err.code : -1) : 0;
      resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") || (err && code === -1 ? String(err.message || err) : "") });
    });
  });
}

let onPath = new Map<string, boolean>();
async function has(bin: string): Promise<boolean> {
  if (!onPath.has(bin)) {
    const probe = process.platform === "win32" ? run("where", [bin], 5000) : run("/usr/bin/env", ["which", bin], 5000);
    onPath.set(bin, (await probe).code === 0);
  }
  return onPath.get(bin)!;
}

/** One compile at a time, shared by every caller that arrives during it. */
let compiling: Promise<string | null> | null = null;
/** Compile the Vision helper if it is not there yet. Answers the binary path, or
 *  null with the reason left in `lastCompileError`. */
async function visionHelper(): Promise<string | null> {
  const bin = helperPath();
  if (existsSync(bin)) return bin;
  if (!(await has("swiftc"))) return null;
  compiling ??= (async () => {
    const dir = await mkdtemp(join(tmpdir(), `${BRAND.slug}-ocrc-`));
    try {
      const src = join(dir, "ocr.swift");
      await writeFile(src, VISION_SWIFT);
      const out = join(dir, "ocr-vision");
      const r = await run("swiftc", ["-O", src, "-o", out], COMPILE_TIMEOUT_MS);
      if (r.code !== 0) { lastCompileError = r.stderr.split("\n").find((l) => l.trim()) || `swiftc exited ${r.code}`; return null; }
      await mkdir(join(STATE_DIR, "bin"), { recursive: true });
      // Copy then rename INSIDE the state dir: tmpdir may be another volume
      // (EXDEV), and a half-copied binary must never sit at the final name.
      await copyFile(out, `${bin}.tmp`);
      await chmod(`${bin}.tmp`, 0o755);
      await rename(`${bin}.tmp`, bin);
      return bin;
    } catch (e: any) {
      lastCompileError = String(e?.message || e);
      return null;
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
      compiling = null;
    }
  })();
  return compiling;
}
let lastCompileError = "";

/** Whether this Linux is WSL — the Windows side (and its OCR) is one
 *  `powershell.exe` away through interop. */
export function isWsl(e: NodeJS.ProcessEnv = process.env, procVersion?: string): boolean {
  if (e.WSL_DISTRO_NAME || e.WSL_INTEROP) return true;
  try { return /microsoft/i.test(procVersion ?? readFileSync("/proc/version", "utf8")); } catch { return false; }
}

/** Windows' own OCR is reachable: a native Windows host, or WSL with interop on. */
async function windowsOcrReachable(platform: string): Promise<boolean> {
  if (platform === "win32") return true;
  return platform === "linux" && isWsl() && (await has("powershell.exe"));
}

/** A string literal PowerShell takes verbatim: single quotes, doubled inside. */
export function psQuote(s: string): string { return `'${s.replace(/'/g, "''")}'`; }

/**
 * The Windows reader, as one PowerShell 5.1 script (`-EncodedCommand`, so no
 * script file, no execution-policy prompt and no quoting through two shells).
 * Exit codes mirror the Vision helper's: 2 = not decodable, 4 = no OCR
 * language installed, 5 = past `OcrEngine.MaxImageDimension`.
 */
export function windowsOcrScript(winPath: string): string {
  return `$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime]
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' })[0]
function Await($op, [Type]$t) { $task = $asTask.MakeGenericMethod($t).Invoke($null, @($op)); $null = $task.Wait(-1); $task.Result }
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
if ($null -eq $engine) { [Console]::Error.WriteLine('no OCR language installed'); exit 4 }
$src = ${psQuote(winPath)}
$local = Join-Path $env:TEMP ('${BRAND.slug}-ocr-' + [guid]::NewGuid().ToString('N') + [IO.Path]::GetExtension($src))
$code = 0
$stream = $null
try {
  Copy-Item -LiteralPath $src -Destination $local
  $bitmap = $null
  try {
    $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($local)) ([Windows.Storage.StorageFile])
    $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
    $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
  } catch { [Console]::Error.WriteLine("cannot decode image: $_"); $code = 2 }
  $max = [Windows.Media.Ocr.OcrEngine]::MaxImageDimension
  if ($code -eq 0 -and ($bitmap.PixelWidth -gt $max -or $bitmap.PixelHeight -gt $max)) { [Console]::Error.WriteLine("larger than $max px"); $code = 5 }
  if ($code -eq 0) {
    $result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
    foreach ($line in $result.Lines) { [Console]::Out.WriteLine($line.Text) }
  }
} catch { [Console]::Error.WriteLine("windows ocr failed: $_"); $code = 3 }
finally {
  if ($stream) { $stream.Dispose() }
  Remove-Item -LiteralPath $local -Force -ErrorAction SilentlyContinue
}
exit $code
`;
}

/** The script, encoded the way `-EncodedCommand` takes it: base64 of UTF-16LE. */
export function encodePs(script: string): string { return Buffer.from(script, "utf16le").toString("base64"); }

async function runWindowsOcr(file: string, platform: string): Promise<{ code: number; stdout: string; stderr: string }> {
  let winPath = file;
  if (platform !== "win32") {
    const w = await run("wslpath", ["-w", file], 5000);
    if (w.code !== 0) return { code: -1, stdout: "", stderr: "wslpath could not translate the image path" };
    winPath = w.stdout.trim();
  }
  return run("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodePs(windowsOcrScript(winPath))], RUN_TIMEOUT_MS);
}

export const WINDOWS_OCR_LANG_HINT =
  "Windows has no OCR language installed: Settings → Time & language → Language & region → add a language, then tick its optical character recognition feature";

/** Which engine would answer, without reading anything. Asked BEFORE the phone
 *  offers the verb, so a button is never shown for a reader that is not there. */
export async function ocrStatus(platform: string = process.platform): Promise<OcrStatus> {
  if (env("LOCAL_OCR") === "0") return { available: false, reason: `on-device text reading is off on this host (${envName("LOCAL_OCR")}=0)` };
  if (platform === "darwin" && existsSync(helperPath())) return { available: true, engine: "vision" };
  if (platform === "darwin" && (await has("swiftc"))) {
    // The first compile is ~27 s (measured); start it the moment the phone asks
    // whether the verb exists, so the read that follows pays only the read (~0.7 s).
    void visionHelper();
    return { available: true, engine: "vision" };
  }
  if (await windowsOcrReachable(platform)) return { available: true, engine: "windows" };
  if (await has("tesseract")) return { available: true, engine: "tesseract" };
  return { available: false, reason: ocrInstallHint(platform) };
}

export function ocrInstallHint(platform: string = process.platform, wsl: boolean = platform === "linux" && isWsl()): string {
  if (platform === "darwin") return "this Mac cannot read images on-device yet: install the Xcode command line tools (xcode-select --install) or tesseract (brew install tesseract)";
  if (wsl) return "this WSL host cannot reach Windows' own text reader (powershell.exe is not on PATH — WSL interop is off): turn interop on, or install tesseract (sudo apt install tesseract-ocr)";
  return "this desktop cannot read images on-device: install tesseract (e.g. apt install tesseract-ocr)";
}

/** Tidy the engine's lines: trim trailing spaces, collapse runs of blank lines. */
export function tidyOcr(raw: string): string {
  return raw.replace(/\r/g, "").split("\n").map((l) => l.replace(/\s+$/, "")).join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Every word in one image, read on this desktop. Never throws. */
export async function readImageLocal(image: Buffer, mime: string): Promise<OcrAnswer> {
  const st = await ocrStatus();
  if (!st.available) return { error: st.reason };
  const t0 = Date.now();
  const ext = /png/.test(mime) ? "png" : /webp/.test(mime) ? "webp" : /heic|heif/.test(mime) ? "heic" : "jpg";
  const dir = await mkdtemp(join(tmpdir(), `${BRAND.slug}-ocr-`));
  try {
    const file = join(dir, `in.${ext}`);
    await writeFile(file, image);
    let r: { code: number; stdout: string; stderr: string } | null = null;
    let engine: string = st.engine;
    /** Why the preferred engine could not answer, said if nothing after it can. */
    let why = "";
    if (st.engine === "vision") {
      const bin = await visionHelper();
      if (bin) r = await run(bin, [file], RUN_TIMEOUT_MS);
      else why = `the on-device reader could not be built${lastCompileError ? `: ${lastCompileError}` : ""}`;
    } else if (st.engine === "windows") {
      r = await runWindowsOcr(file, process.platform);
      // No OCR language on Windows is a setup gap, not a verdict on the picture:
      // tesseract, when present, still answers.
      if (r.code === 4) { why = WINDOWS_OCR_LANG_HINT; r = null; }
    }
    if (!r && (await has("tesseract"))) {
      engine = "tesseract";
      r = await run("tesseract", [file, "-", "--psm", "3"], RUN_TIMEOUT_MS);
    }
    if (!r) return { error: why || ocrInstallHint() };
    if (r.code === 2) return { error: "that image could not be decoded on the desktop" };
    if (r.code === 5) return { error: "that picture is larger than Windows' text reader takes — crop it first" };
    if (r.code !== 0) {
      console.warn(`[ocr] ${engine} exited ${r.code} after ${Date.now() - t0}ms (${image.length} bytes)`);
      return { error: `the on-device reader failed (${engine}, exit ${r.code})` };
    }
    const text = tidyOcr(r.stdout);
    if (!text) return { error: "no readable text in that picture" };
    if (text.length > OCR_MAX_CHARS) return { error: `that picture held more than ${OCR_MAX_CHARS.toLocaleString("en")} characters — crop it first` };
    return { text, engine, ms: Date.now() - t0 };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Tests only: forget what `which` answered. */
export function _resetOcrProbe(): void { onPath = new Map(); }
