import { api } from "./api";

/**
 * A full-resolution screenshot of the desktop into `repoId`'s `.claude/outbox/` (the gallery's
 * folder) — the existing `POST /api/host/screenshot`, never a second capture path. Resolves to the
 * file or a reason; never throws. The live desktop view's camera button (the SDK's `desktopScreenshot`)
 * is its one caller.
 */
export async function desktopScreenshot(repoId: string): Promise<{ file: { name: string; relPath: string; size: number; mtime: number } } | { error: string }> {
  try {
    const r = await api.screenshot(repoId);
    return r.file ? { file: r.file } : { error: r.error || "the desktop gave no reason" };
  } catch {
    return { error: "the desktop could not be reached" };
  }
}

/**
 * The same capture into the desktop's own clipboard (`POST /api/host/screenshot/clipboard`): no file,
 * and never this device's clipboard. `null` when it is there, else the reason; never throws.
 */
export async function desktopScreenshotToClipboard(): Promise<{ error: string } | null> {
  try {
    const r = await api.screenshotToClipboard();
    return r.ok ? null : { error: r.error || "the desktop gave no reason" };
  } catch {
    return { error: "the desktop could not be reached" };
  }
}
