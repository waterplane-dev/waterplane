/**
 * A picture of ANY window or screen on the machine the browser runs on — the
 * compose bar's "pick a window" button, for waterplane opened as a web app on a
 * desktop (macOS or Windows alike). The browser's own share picker
 * (`getDisplayMedia`) asks which window; one frame is kept, the stream is
 * stopped at once, and the picture takes the SAME route as a Cmd/Ctrl+V of a
 * screenshot (`useFileDrop`'s `attachFiles`): annotator, then attached.
 *
 * Browser-side on purpose, not a host route: the picker IS the person's
 * consent each time, it lists windows hidden behind the browser, and it works
 * the same against a host on another desktop. Nothing runs on the host.
 *
 * Where the browser has no `getDisplayMedia` (phones, the Android WebView) the
 * button is not drawn at all — that workflow is the camera/gallery's.
 */

/** Can this document offer the picker? Needs the API AND a secure context. */
export function canPickWindow(): boolean {
  try {
    return typeof window !== "undefined" && window.isSecureContext && typeof navigator.mediaDevices?.getDisplayMedia === "function";
  } catch {
    return false;
  }
}

export type WindowShot = { file: File } | { error: string } | { cancelled: true };

/** What a refused picker means, in words. `null` = the person cancelled — said by nothing. */
export function shotRefusal(name: string, message: string): string | null {
  if (name === "NotAllowedError") {
    // Chrome/Edge on macOS: the OS refused, not the person.
    return /system/i.test(message)
      ? "The system refused screen capture — allow this browser under Privacy & Security → Screen Recording, then restart it"
      : null;
  }
  if (name === "NotFoundError") return "No window or screen to capture was offered";
  if (name === "NotSupportedError" || name === "TypeError") return "This browser cannot capture a window";
  return `Window capture failed: ${message || name}`;
}

/** `window-20261102-142233.png` — local time, sortable. */
export function shotName(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `window-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.png`;
}

/** Ask for a window, keep one frame, stop sharing. Never throws. */
export async function pickWindowShot(): Promise<WindowShot> {
  let stream: MediaStream;
  try {
    // Chromium hints, ignored elsewhere: open on the "Window" tab, leave this
    // tab out, and don't jump focus to the captured window.
    const Ctl = (globalThis as { CaptureController?: new () => { setFocusBehavior?(b: string): void } }).CaptureController;
    const controller = Ctl ? new Ctl() : undefined;
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { displaySurface: "window" },
      audio: false,
      selfBrowserSurface: "exclude",
      surfaceSwitching: "exclude",
      monitorTypeSurfaces: "include",
      ...(controller ? { controller } : {}),
    } as DisplayMediaStreamOptions);
    try { controller?.setFocusBehavior?.("no-focus-change"); } catch { /* past the window for it — harmless */ }
  } catch (e) {
    const err = e as { name?: string; message?: string };
    const why = shotRefusal(err?.name ?? "", err?.message ?? "");
    return why ? { error: why } : { cancelled: true };
  }
  try {
    const blob = await oneFrame(stream);
    if (!blob) return { error: "The window gave no picture" };
    return { file: new File([blob], shotName(new Date()), { type: "image/png" }) };
  } catch (e) {
    return { error: `Window capture failed: ${(e as Error)?.message || e}` };
  } finally {
    for (const t of stream.getTracks()) t.stop();
  }
}

async function oneFrame(stream: MediaStream): Promise<Blob | null> {
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;
  try {
    await video.play();
    // The first decoded frame, not whatever the element shows before it: a
    // canvas drawn before then is black.
    await new Promise<void>((res) => {
      const v = video as HTMLVideoElement & { requestVideoFrameCallback?(cb: () => void): number };
      const t = setTimeout(res, 1000);
      if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(() => { clearTimeout(t); res(); });
      else if (video.readyState >= 2) { clearTimeout(t); res(); }
      else video.addEventListener("loadeddata", () => { clearTimeout(t); res(); }, { once: true });
    });
    const w = video.videoWidth, h = video.videoHeight;
    if (!w || !h) return null;
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0, w, h);
    return await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/png"));
  } finally {
    video.srcObject = null;
  }
}
