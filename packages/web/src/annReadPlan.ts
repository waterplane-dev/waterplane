/**
 * The pure half of reading a mark's words ON THE PHONE (R-images-015): which marks to read, which
 * reads to call off, and the rectangle and scale of the crop handed to the reader. The DOM half —
 * the crop canvas, the call, landing the words — is `annotator/annAutoRead.ts`.
 *
 * Only an enabled text-in-marks extension reads (`core/extensionPoints.ts` `imageTextReader()`);
 * with none, nothing here runs and a mark carries only the words a person typed. Never the desktop
 * or a cloud model (R-images-012).
 */
import { turnedBounds } from "./annClip.ts";
import type { Mark } from "./annNote";

/** The marks whose area holds words worth reading. An arrow or a line points; a label IS words. */
export const READ_TOOLS: ReadonlySet<string> = new Set(["marker", "rect", "circle"]);

/** How long a read may take before it is called off and the mark says so. */
export const READ_TIMEOUT_MS = 10_000;

/** The crop's long side never goes past this, however large the mark. */
export const READ_MAX_SIDE = 2000;
/** …and small text is enlarged at most this much (a reader wants ~30 px letters). */
export const READ_MAX_SCALE = 4;

/** What the plan needs to know about a mark. `readBy` "hand": the person typed or dropped its
 *  words, and a reader never touches them again. */
export interface ReadMark extends Pick<Mark, "tool" | "x0" | "y0" | "x1" | "y1" | "angle"> {
  id: number;
  readBy?: "hand" | "phone";
}

/** The geometry a read was made for: a move, a resize, a turn or a crop changes it, and re-reads. */
export function readKey(m: ReadMark): string {
  const r = (v: number) => Math.round(v);
  return [m.tool, r(m.x0), r(m.y0), r(m.x1), r(m.y1), Math.round((m.angle ?? 0) * 1000)].join("|");
}

/**
 * `known` is id → the geometry key last sent to the reader. A mark of a reading tool whose words
 * are not the person's, never read or read for other geometry, is STARTED; a known id that is gone,
 * or whose words the person has since typed, is ABORTED (and forgotten). No reader: nothing starts,
 * and every read still out is called off.
 */
export function planReads(marks: readonly ReadMark[], known: ReadonlyMap<number, string>, hasReader: boolean): { start: ReadMark[]; abort: number[] } {
  const live = new Map(marks.map((m) => [m.id, m]));
  const abort: number[] = [];
  for (const id of known.keys()) {
    const m = live.get(id);
    if (!hasReader || !m || m.readBy === "hand") abort.push(id);
  }
  if (!hasReader) return { start: [], abort };
  const start = marks.filter((m) => READ_TOOLS.has(m.tool) && m.readBy !== "hand" && known.get(m.id) !== readKey(m));
  return { start, abort };
}

export interface CropRect { x: number; y: number; w: number; h: number }

/**
 * The pixels to read, in image px: the mark's box (a turned one's upright bounds; a circle's box;
 * a highlight at least as tall as its ink, `bandMinH`), padded a little so a letter the stroke
 * touches is whole, and clamped to the picture on BOTH edges. Null when nothing is left.
 */
export function readCropRect(m: ReadMark, imgW: number, imgH: number, bandMinH: number): CropRect | null {
  let b = { x0: Math.min(m.x0, m.x1), y0: Math.min(m.y0, m.y1), x1: Math.max(m.x0, m.x1), y1: Math.max(m.y0, m.y1) };
  if (m.tool === "marker" && b.y1 - b.y0 < bandMinH) {
    const cy = (b.y0 + b.y1) / 2;
    b = { ...b, y0: cy - bandMinH / 2, y1: cy + bandMinH / 2 };
  }
  if (m.angle && m.tool !== "marker") b = turnedBounds(b, m.angle);
  const pad = Math.max(4, Math.round(Math.min(b.x1 - b.x0, b.y1 - b.y0) * 0.08));
  const x0 = Math.max(0, Math.floor(b.x0 - pad)), y0 = Math.max(0, Math.floor(b.y0 - pad));
  const x1 = Math.min(imgW, Math.ceil(b.x1 + pad)), y1 = Math.min(imgH, Math.ceil(b.y1 + pad));
  if (x1 - x0 < 2 || y1 - y0 < 2) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** How much to enlarge a crop: small text up to `READ_MAX_SCALE`×, never a long side past
 *  `READ_MAX_SIDE` (a big crop shrinks to it). At least 2× whenever the long side is ≤ 1000 px. */
export function readScale(w: number, h: number): number {
  const long = Math.max(w, h, 1);
  return Math.min(READ_MAX_SCALE, READ_MAX_SIDE / long);
}

/** A reader's answer as the words on the mark: whitespace flattened, empty ⇒ null (absent). */
export function cleanRead(t: string | null | undefined): string | null {
  const s = (t ?? "").replace(/\s+/g, " ").trim();
  return s ? s : null;
}
