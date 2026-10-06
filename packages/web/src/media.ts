import { LS, lsGet, lsSet } from "./storage";
/**
 * Image request sizing — the client half of server-side thumbnails (host
 * `thumbs.ts`). Every grid/strip that used to point an `<img>` at the ORIGINAL
 * artifact asks for a width instead, so a 600 KB screenshot arrives as ~20 KB.
 *
 * Widths must stay in sync with the host's allow-list; an unknown width is
 * ignored there and the original comes back (correct, just fat).
 */
export const THUMB_WIDTHS = [160, 240, 320, 480, 640, 960, 1280, 1600];

const DATA_SAVER_KEY = LS.dataSaver;

/**
 * "Data saver": on a roaming/hotel link the phone should ask for less of
 * everything. Per device, sticky in localStorage, toggled in Settings.
 */
export function dataSaver(): boolean {
  return lsGet(DATA_SAVER_KEY) === "1";
}
export function setDataSaver(on: boolean): void {
  lsSet(DATA_SAVER_KEY, on ? "1" : "0");
}

/** Snap up to an allowed width, honouring device pixel ratio (capped at 2 —
 *  a 3x phone does not need 3x bytes for a thumbnail). */
export function pickThumbWidth(cssPx: number): number {
  const dpr = Math.min(2, Math.max(1, typeof devicePixelRatio === "number" ? devicePixelRatio : 1));
  const want = Math.round(cssPx * (dataSaver() ? 1 : dpr));
  return THUMB_WIDTHS.find((w) => w >= want) ?? THUMB_WIDTHS[THUMB_WIDTHS.length - 1];
}

/** Widest image the full-screen viewer ever needs. Beyond this it is a zoom
 *  question, and the viewer offers an explicit "full res" swap. */
export function viewerWidth(): number {
  if (dataSaver()) return 960;
  const w = typeof innerWidth === "number" ? innerWidth : 400;
  return pickThumbWidth(Math.min(w, 800));
}

/**
 * Add `thumb`/`v` to an artifact or inbox URL. `v` (the file's mtime) makes the
 * URL change when the file does, which is what lets the host mark the response
 * `immutable` — a re-opened gallery then costs zero bytes, not even a 304.
 */
export function sized(url: string, width: number, mtime?: number): string {
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}thumb=${width}${mtime ? `&v=${Math.floor(mtime)}` : ""}`;
}

/**
 * Is this picked file something the annotator can put on a canvas?
 *
 * The routing rule for every picker in the app: an image opens in the
 * annotator, anything else goes straight up. It lives here rather than next to
 * one of its callers because the callers are in different sheets (the compose
 * bar, the Start sheet) and two copies would drift into the two entry points
 * disagreeing about what happens to the same JPEG — which is the bug this rule
 * exists to prevent. Deliberately the same net `accept="image/*"` casts on the
 * camera button. Some Android pickers hand over a File with an empty `type`,
 * hence the extension fallback.
 */
export function isAnnotatable(f: File): boolean {
  if (f.type) return f.type.startsWith("image/");
  return /\.(png|jpe?g|gif|webp|bmp|svg|heic|heif)$/i.test(f.name);
}
