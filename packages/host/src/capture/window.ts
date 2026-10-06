/**
 * The `window` backend — whatever is on this desktop right now.
 *
 * The catch-all: a native app, an emulator nobody has a CLI for, a device
 * mirroring session. There is nothing to query, so there is no oracle, and this
 * backend's ceiling is `settled:stable` FOR EVER — two frames agreeing is the
 * strongest thing a screen grab can honestly claim. `verificationLevel()`
 * enforces that; `oracle()` returning null is how it is told.
 *
 * ── Why the window is resolved by BOUNDS and not by id ─────────────────────
 *
 * `screencapture -l` wants a CGWindowID, and AppleScript cannot hand one back —
 * `id of window` in System Events is an accessibility element reference, not
 * that number, so the obvious one-liner silently grabs the wrong thing. What
 * System Events CAN answer honestly is position and size, which is exactly what
 * `screencapture -R` takes. Anything in the way of that (no Accessibility
 * permission, no process with a matching title, a non-macOS host) falls back to
 * the whole desktop through `takeScreenshot` — the SAME implementation
 * `/api/host/screenshot` uses, imported and never forked.
 *
 * A fallback is never silent. It is said in the run's output and it is why
 * `CaptureSidecar.viewport` is optional: a whole-desktop grab is not the
 * geometry the target asked for, and the verdict prints what the file actually
 * turned out to be — or `n/a` when even the PNG header will not parse.
 */
import type { CaptureBackendInfo, CaptureTarget } from "@waterplane/shared";
import { takeScreenshot } from "../host.js";
import type {
  CaptureBackend, CaptureCtx, CapturePass, CaptureSession, FrameResult,
} from "./types.js";
import { execFileP as pexec } from "../proc.js";

const OSASCRIPT_MS = 10_000;

/** `x,y,w,h` of the first visible window whose title contains `title`. */
async function windowBounds(title: string): Promise<string | null> {
  if (process.platform !== "darwin") return null;
  const script = `
tell application "System Events"
  repeat with p in (every application process whose background only is false)
    repeat with w in (every window of p)
      try
        if name of w contains ${JSON.stringify(title)} then
          set {x, y} to position of w
          set {ww, hh} to size of w
          return (x as text) & "," & (y as text) & "," & (ww as text) & "," & (hh as text)
        end if
      end try
    end repeat
  end repeat
end tell
return "none"`;
  try {
    const { stdout } = await pexec("osascript", ["-e", script], { timeout: OSASCRIPT_MS });
    const s = stdout.trim();
    return /^-?\d+,-?\d+,\d+,\d+$/.test(s) ? s : null;
  } catch {
    return null;   // no Accessibility permission, or osascript is not here
  }
}

class WindowSession implements CaptureSession {
  /** Resolved once per pass: re-asking between settle samples would let a
   *  window that moved mid-run produce two frames of different regions, which
   *  the stability check would read as "still moving" for ever. */
  private region: string | null | undefined;
  private saidFallback = false;

  constructor(private t: CaptureTarget, private ctx: CaptureCtx) {}

  async frame(absPath: string): Promise<FrameResult> {
    if (this.region === undefined) {
      this.region = this.t.windowTitle ? await windowBounds(this.t.windowTitle) : null;
    }
    if (this.region) {
      await pexec("screencapture", ["-x", "-o", "-R", this.region, absPath], { timeout: 30_000 });
      return { path: absPath };
    }
    if (!this.saidFallback) {
      this.saidFallback = true;
      const why = this.t.windowTitle
        ? `no visible window matching "${this.t.windowTitle}" (or Accessibility is not granted to this daemon)`
        : "no window title set";
      this.ctx.log(`[capture] ${why} — capturing the whole desktop instead.`);
    }
    await takeScreenshot(absPath);
    return {
      path: absPath,
      note: this.t.windowTitle ? "whole desktop (the named window was not found)" : "whole desktop",
    };
  }

  /** There is nobody to ask. This is the ceiling, stated once. */
  async oracle(): Promise<null> { return null; }

  async end(): Promise<void> { /* nothing is held open */ }
}

export const windowBackend: CaptureBackend = {
  id: "window",

  async probe(): Promise<CaptureBackendInfo> {
    if (process.platform === "darwin") {
      return { id: "window", available: true, reason: "screencapture (window bounds need Accessibility permission)" };
    }
    if (process.platform === "linux") {
      return { id: "window", available: true, reason: "whole-desktop grab (gnome-screenshot/scrot/import)" };
    }
    return { id: "window", available: false, reason: `screen capture is not implemented on ${process.platform}.` };
  },

  /** One desktop, one grab at a time. */
  leaseKey(): string { return "window:host"; },

  validate(): string | null { return null; },

  passes(): CapturePass[] { return [{ label: "desktop" }]; },

  async open(t: CaptureTarget, ctx: CaptureCtx): Promise<CaptureSession> {
    return new WindowSession(t, ctx);
  },
};
