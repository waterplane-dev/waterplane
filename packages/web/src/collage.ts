/**
 * Several pictures as ONE picture — the canvas half.
 *
 * `@waterplane/shared`'s `collage.ts` decides WHERE each panel goes (and is pinned by
 * `node --test`, since the arrangement is the part that can be wrong); this
 * pushes the pixels. Kept apart on purpose: everything below needs a DOM, and
 * everything above needs to be provable without one.
 *
 * Decoding is done ONCE, up front, and the bitmaps are held by the sheet while
 * the layout is being chosen — a re-render on every tap of the picker would
 * otherwise decode four 12 MP screenshots again per tap, which on a phone is
 * seconds of frozen UI and, with `createImageBitmap` unavailable, a stack of
 * `<img>` decodes that may never finish. `release()` when the sheet closes, or
 * a batch of ImageBitmaps leaks GPU memory for the life of the tab.
 *
 * The panels are NUMBERED by default, and that is not decoration: the whole
 * point of the combined image is a mark that spans screens ("the id in ① is the
 * one missing in ③"), and without numbers the prompt has no way to name a panel
 * other than by position, which stops being true the moment the layout is
 * changed.
 */
import { collageLabel, defaultGap, layoutCollage, pickCols, type CollageLayout, type ImageSize } from "@waterplane/shared";
import { decodeImage, encodeCanvas, withTimeout } from "./uploadScale";

export type CollageGap = "none" | "thin" | "wide";

/** One decoded source, ready to draw. */
export interface CollageItem {
  name: string;
  /** The picked file this came from — kept so the sheet can show a thumbnail of
   *  it while the order is being set, and so a reorder can be handed back to the
   *  caller if the images end up being sent separately after all. */
  file: File;
  img: CanvasImageSource;
  w: number;
  h: number;
}

export interface CollageOptions {
  /** Images per row; omitted ⇒ the automatic pick. */
  cols?: number;
  gap?: CollageGap;
  labels?: boolean;
  /** Longest side of the output. The preview asks for a small one. */
  maxSide?: number;
  /** Cap on width alone — the width this image will be uploaded at, so nothing
   *  is drawn that the upload would throw away. */
  maxWidth?: number;
}

export interface CollageResult {
  blob: Blob;
  layout: CollageLayout;
  /** What the picker calls this arrangement ("2 across", "2 × 2"). */
  label: string;
  /** True when the asked-for size failed on this device and a smaller one was
   *  drawn instead. The sheet says so — a picture quietly half the resolution
   *  the header promised is the kind of thing found only after sending. */
  reduced: boolean;
}

/** Background behind the panels, and therefore the colour of every seam. Dark
 *  because the app is, and because a white seam between two dark screenshots
 *  reads as part of the screenshots. */
const BG = "#0d1013";
// Opaque, and ringed: the badge lands on whatever the source screenshot had in
// its top-left corner. A translucent black box over a dark status bar is not a
// badge at all — it reads as one more piece of the phone's own chrome — and the
// number is the only way a prompt can name a panel.
const LABEL_BG = "#000000";
const LABEL_RING = "#ffffff";
const LABEL_HALO = "rgba(0,0,0,0.75)";

/**
 * Decode every picked file, keeping the ones that decode.
 *
 * A file that cannot be decoded is REPORTED, never silently dropped: the sheet
 * says which ones it could not use, because a collage quietly missing the one
 * screenshot the prompt is about is worse than no collage at all.
 */
export async function decodeForCollage(files: File[]): Promise<{ items: CollageItem[]; failed: string[] }> {
  const items: CollageItem[] = [];
  const failed: string[] = [];
  for (const f of files) {
    const img = await withTimeout(decodeImage(f), null);
    const w = img ? (img as { width: number }).width : 0;
    const h = img ? (img as { height: number }).height : 0;
    if (img && w > 0 && h > 0) items.push({ name: f.name, file: f, img: img as CanvasImageSource, w, h });
    else failed.push(f.name);
  }
  return { items, failed };
}

/** Let go of the decoded bitmaps. Call it once, when the sheet closes. */
export function releaseCollage(items: CollageItem[]): void {
  for (const it of items) {
    if (typeof ImageBitmap !== "undefined" && it.img instanceof ImageBitmap) it.img.close();
  }
}

const sizes = (items: CollageItem[]): ImageSize[] => items.map((i) => ({ w: i.w, h: i.h }));

/** Gap in native pixels for a preset. `thin` is the resolution-relative default. */
export function gapPx(items: CollageItem[], gap: CollageGap): number {
  if (gap === "none") return 0;
  const base = defaultGap(sizes(items));
  return gap === "wide" ? base * 3 : base;
}

/** The automatic column count for these images — what "auto" resolves to. */
export function autoCols(items: CollageItem[], gap: CollageGap): number {
  return pickCols(sizes(items), gapPx(items, gap));
}

/** Every arrangement the picker offers, in the order it shows them. */
export function colChoices(count: number): number[] {
  return Array.from({ length: count }, (_, i) => i + 1);
}

export { collageLabel };

/**
 * The geometry a full-size render would produce — dimensions and arrangement
 * with no drawing done.
 *
 * The sheet needs this because the PREVIEW is deliberately small (a 24 MP
 * canvas per tap of the picker is what makes a phone drop frames), so the
 * preview's own layout cannot answer "how big is the thing I am about to send".
 */
export function planCollage(items: CollageItem[], opts: CollageOptions = {}): CollageLayout {
  return layoutCollage(sizes(items), {
    cols: opts.cols,
    gap: gapPx(items, opts.gap ?? "thin"),
    ...(opts.maxWidth ? { maxWidth: opts.maxWidth } : {}),
  });
}

/**
 * Draw the combined image, at the largest size this device will actually
 * produce.
 *
 * The ladder is the load-bearing part. A canvas of six megapixels is nothing on
 * a desktop and is exactly where an Android WebView gives up: `getContext`
 * succeeds, the draws succeed, and `toBlob` hands back `null` (or never calls
 * back at all) because the encode could not be allocated. The first version of
 * this reported "couldn't draw the combined image" and offered the one thing
 * that throws the work away — send them separately — for a picture the device
 * could have made at 2600 px without anyone noticing the difference.
 *
 * So: try the asked-for size, then successively smaller budgets, and say which
 * one came out. Two independent fallbacks under that, because both halves fail
 * differently — `toDataURL` is synchronous and often works where `toBlob`
 * returns null, and every canvas is released before the next attempt so the
 * retry is not competing with the memory the failed one is still holding.
 *
 * Returns null only when even the smallest budget fails; the caller then keeps
 * the images separate, which is the same degradation every other image path
 * here takes. JPEG rather than PNG for the same reason `scaleForUpload` does:
 * the sources are screenshots and photos, and a lossless 24 MP canvas is not
 * something to push up a roaming uplink.
 */
/** Longest side to fall back to, in order, when the asked-for size won't draw. */
const FALLBACK_SIDES = [2600, 1800, 1200, 800];

export async function renderCollage(items: CollageItem[], opts: CollageOptions = {}): Promise<CollageResult | null> {
  if (!items.length) return null;
  const budgets: (number | undefined)[] = opts.maxSide
    ? [opts.maxSide, ...FALLBACK_SIDES.filter((s) => s < opts.maxSide!)]
    : [undefined, ...FALLBACK_SIDES];
  for (let attempt = 0; attempt < budgets.length; attempt++) {
    const side = budgets[attempt];
    const layout = layoutCollage(sizes(items), {
      cols: opts.cols,
      gap: gapPx(items, opts.gap ?? "thin"),
      ...(opts.maxWidth ? { maxWidth: opts.maxWidth } : {}),
      ...(side ? { maxSide: side, maxPixels: side * side } : {}),
    });
    const blob = await drawOnce(items, layout, opts.labels !== false && items.length > 1);
    if (blob) return { blob, layout, label: collageLabel(items.length, layout.cols), reduced: attempt > 0 };
  }
  return null;
}

/** One attempt at one size. Releases its canvas whatever happens — a retry that
 *  runs while the failed attempt's bitmap is still allocated fails too. */
async function drawOnce(items: CollageItem[], layout: CollageLayout, labels: boolean): Promise<Blob | null> {
  const canvas = document.createElement("canvas");
  try {
    canvas.width = layout.width;
    canvas.height = layout.height;
    // A canvas the device refused to allocate reports a size it did not get.
    if (canvas.width !== layout.width || canvas.height !== layout.height) return null;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingQuality = "high";
    for (const cell of layout.cells) {
      const it = items[cell.i];
      if (!it) continue;
      try { ctx.drawImage(it.img, cell.x, cell.y, cell.w, cell.h); } catch { /* skip an undrawable panel */ }
      if (labels) drawLabel(ctx, cell.x, cell.y, cell.w, cell.h, cell.i + 1);
    }
    return await encodeCanvas(canvas, "image/jpeg", 0.9);
  } catch {
    return null;
  } finally {
    // Zeroing is what actually frees the backing store in a WebView; dropping
    // the reference leaves it live until a GC that may not come first.
    canvas.width = 0;
    canvas.height = 0;
  }
}

/** The panel number, big enough to survive the phone-sized re-encode that
 *  happens on the way up (`scaleForUpload`) and to be readable in the reader.
 *
 *  Drawn as an opaque disc with a white ring inside a dark halo, so it is the
 *  same badge over a black status bar and over a white toolbar; contrast that
 *  depends on what was underneath is contrast that fails on half the panels. */
function drawLabel(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, n: number) {
  const size = Math.max(22, Math.round(Math.min(w, h) * 0.095));
  const pad = Math.round(size * 0.5);
  const text = String(n);
  ctx.font = `800 ${size}px system-ui, -apple-system, sans-serif`;
  ctx.textBaseline = "middle";
  ctx.textAlign = "center";
  const boxH = size + pad;
  const box = Math.max(boxH, ctx.measureText(text).width + pad * 2);
  const ring = Math.max(2, Math.round(size * 0.11));
  // Inset by the ring too, or half of it is drawn outside the panel.
  const bx = x + Math.round(size * 0.35) + ring;
  const by = y + Math.round(size * 0.35) + ring;
  roundRect(ctx, bx, by, box, boxH, Math.round(size * 0.32));
  ctx.fillStyle = LABEL_BG;
  ctx.fill();
  ctx.lineJoin = "round";
  // Halo first, wider, then the ring over it: the white ring carries the badge
  // on a dark screenshot, the dark halo carries the white ring on a light one.
  ctx.lineWidth = ring * 2.4;
  ctx.strokeStyle = LABEL_HALO;
  ctx.stroke();
  ctx.lineWidth = ring;
  ctx.strokeStyle = LABEL_RING;
  ctx.stroke();
  ctx.fillStyle = "#ffffff";
  ctx.fillText(text, bx + box / 2, by + boxH / 2);
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  // `roundRect` is not in every WebView this app runs in; the manual path is.
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/**
 * The name the combined file gets.
 *
 * It says what it is and how many screens went into it, because this name is
 * what the minted inbox path is built from (`plannedInboxPath`) and therefore
 * the only human-readable thing about the path the prompt ends up naming.
 */
export function collageFileName(count: number): string {
  return `combined-${count}-screens.jpg`;
}
