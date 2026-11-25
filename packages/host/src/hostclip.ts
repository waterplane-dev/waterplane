/**
 * A screenshot of this desktop left in this desktop's own clipboard, as a picture: no file stays, and
 * the picture never travels. The capture is `captureDesktop`'s (host.ts), never a second one; what is
 * here is only putting an image file on the clipboard.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureDesktop } from "./host.js";
import { encodePs, isWsl, psQuote } from "./ocrlocal.js";
import { execFileP } from "./proc.js";

/**
 * JXA, run by `osascript -l JavaScript`: argv[0] the image, argv[1] a private pasteboard's name
 * (tests; empty = the general one). Decoded first, so an unreadable picture leaves what the clipboard
 * held. Written as PNG whatever came in (the fallback capture is a JPEG, which some apps do not paste).
 */
export const MAC_CLIP_SCRIPT = `ObjC.import("AppKit");
function run(argv) {
  var d = $.NSData.dataWithContentsOfFile($(argv[0]));
  var rep = d.isNil() ? null : $.NSBitmapImageRep.imageRepWithData(d);
  if (!rep || rep.isNil()) throw new Error("the picture could not be read");
  var png = rep.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $.NSDictionary.dictionary);
  if (png.isNil()) throw new Error("the picture could not be made a PNG");
  var pb = argv[1] ? $.NSPasteboard.pasteboardWithName($(argv[1])) : $.NSPasteboard.generalPasteboard;
  pb.clearContents;
  if (!pb.setDataForType(png, $.NSPasteboardTypePNG)) throw new Error("macOS did not take the picture");
  return "ok";
}`;

/** PowerShell 5.1: the image at `winPath` into the Windows clipboard, kept after this process ends. */
export function windowsClipScript(winPath: string): string {
  return `$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$img = [System.Drawing.Image]::FromFile(${psQuote(winPath)})
[System.Windows.Forms.Clipboard]::SetImage($img)
$img.Dispose()
`;
}

/** The image file at `path` into this machine's clipboard. Throws in words. `pasteboard`: tests only. */
export async function imageToClipboard(path: string, pasteboard = ""): Promise<void> {
  if (process.platform === "darwin") {
    await execFileP("/usr/bin/osascript", ["-l", "JavaScript", "-e", MAC_CLIP_SCRIPT, path, pasteboard], { timeout: 30_000 });
    return;
  }
  if (process.platform === "linux" && isWsl()) {
    const { stdout } = await execFileP("wslpath", ["-w", path], { timeout: 5000 });
    // -Sta: the Windows clipboard refuses any other thread.
    await execFileP("powershell.exe", ["-NoProfile", "-NonInteractive", "-Sta", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodePs(windowsClipScript(stdout.trim()))], { timeout: 30_000 });
    return;
  }
  throw new Error(`putting a picture in the clipboard is not supported on ${process.platform}`);
}

/** Capture, copy, and take the file away again, whichever step failed. */
export async function screenshotToClipboard(
  capture: typeof captureDesktop = captureDesktop, toClipboard: (path: string) => Promise<void> = imageToClipboard,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "wp-shot-"));
  try {
    const { full } = await capture((ext) => ({ full: join(dir, `shot${ext}`) }));
    await toClipboard(full);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
