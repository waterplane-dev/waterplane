/**
 * Several pictures as ONE picture — the geometry half.
 *
 * The reason this exists is marking, not tidiness. A bug that spans three
 * screens (tap here, then this list, then this error) can only be circled
 * across all three if all three are on one canvas: the annotator marks one
 * image at a time, and an arrow cannot leave it. Sending three separately means
 * describing the link between them in words, which is the thing a screenshot
 * was supposed to replace.
 *
 * Pure, and here rather than in `web/` for the usual reason: the arrangement is
 * the part that can be wrong (a column of phone screenshots is a 1:8 ribbon
 * nobody can read on a phone), and pinning it needs `node --test`, not a
 * browser. The pixels are pushed in `web/src/collage.ts`.
 *
 * Two rules carry the feature:
 *
 *  - **Rows normalize on HEIGHT, columns on nothing.** Each row scales its
 *    images to a common height, so panels sit on a shared baseline and no
 *    letterbox is needed in the direction that matters. Rows are then centered
 *    inside the widest row, which is the only place slack can appear.
 *  - **`pickCols` optimizes the resulting ASPECT, not the count.** Two portrait
 *    screenshots side by side are ~0.9:1 and read perfectly; stacked they are
 *    0.23:1, i.e. a ribbon that is 200 px wide by the time it fits a phone —
 *    the marks on it would be unclickable. The same rule stacks landscape
 *    captures, for the same reason in the other direction. That is the
 *    "clever automatism": one number (`COLLAGE_TARGET_ASPECT`) and a search
 *    over every column count, never a per-orientation special case.
 */

/** Natural size of one source image. */
export interface ImageSize { w: number; h: number }

/** Where one image lands on the combined canvas, in output pixels. */
export interface CollageCell {
  /** Index into the input array — the panel's number, and its draw order. */
  i: number;
  x: number; y: number; w: number; h: number;
}

export interface CollageLayout {
  cols: number;
  rows: number;
  gap: number;
  width: number;
  height: number;
  /** Global downscale applied to keep the canvas inside the caps. 1 = native. */
  scale: number;
  cells: CollageCell[];
}

export interface CollageOpts {
  /** Images per row. Omitted ⇒ `pickCols` decides. */
  cols?: number;
  /** Space between panels, in native pixels. Omitted ⇒ `defaultGap`. */
  gap?: number;
  maxSide?: number;
  /**
   * Cap on WIDTH alone, separate from `maxSide`.
   *
   * The combined image is re-encoded to a width before it is uploaded
   * (`uploadScale.ts`), so drawing it wider than that is bytes and memory spent
   * on pixels nothing will ever see — and on a phone that is exactly where the
   * final `toBlob` fails. Capping the SIDE would be wrong for the same job: a
   * stacked collage is legitimately 1200 × 6000, and the upload rule would keep
   * every one of those rows.
   */
  maxWidth?: number;
  maxPixels?: number;
  targetAspect?: number;
}

/**
 * The shape the automatic pick aims at: slightly wider than tall.
 *
 * Not 1:1 and not 16:9. Square would put four phone screenshots in a 2×2 grid
 * (right) but also three of them in a 2+1 grid with a hole in it (wrong — they
 * are a sequence and read left to right). Anything wide enough to fix that
 * would put four in a row, at which point each panel is a quarter of the phone
 * wide. 1.25 is the value that gets both cases right, and the picker is one tap
 * away for the case it doesn't.
 */
export const COLLAGE_TARGET_ASPECT = 1.25;
/** Canvas caps. A phone re-encodes this before upload anyway (`uploadScale.ts`);
 *  these exist so the CANVAS itself can be allocated on a mid-range device. */
export const COLLAGE_MAX_SIDE = 4096;
export const COLLAGE_MAX_PIXELS = 24e6;

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** Sanitize a source size — a decode that reported 0 must not divide by it. */
function norm(sizes: ImageSize[]): ImageSize[] {
  return sizes.map((s) => ({
    w: Number.isFinite(s.w) && s.w > 0 ? s.w : 1,
    h: Number.isFinite(s.h) && s.h > 0 ? s.h : 1,
  }));
}

/** Row-major chunks of `cols`. The last row may be short — see `pickCols`. */
function rowsOf<T>(items: T[], cols: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += cols) out.push(items.slice(i, i + cols));
  return out;
}

/**
 * The gap between panels, derived from the images rather than fixed.
 *
 * A 12 px seam is a clear divider between two 400 px thumbnails and invisible
 * between two 4K screenshots — and the second is the case this feature is for.
 * Scaling it with the mean panel size keeps "these are two pictures" readable
 * at every source resolution.
 */
export function defaultGap(sizes: ImageSize[]): number {
  const s = norm(sizes);
  if (s.length < 2) return 0;
  const mean = s.reduce((a, x) => a + (x.w + x.h) / 2, 0) / s.length;
  return clamp(Math.round(mean * 0.012), 4, 40);
}

/** Geometry at native scale, before the caps are applied. */
function measure(sizes: ImageSize[], cols: number, gap: number) {
  const rows = rowsOf(sizes.map((s, i) => ({ ...s, i })), cols);
  const rowBoxes = rows.map((row) => {
    // Common height per row: the tallest member. Upscaling a small panel costs
    // sharpness; letting rows disagree costs the shared baseline that makes a
    // sequence readable, which is worth more.
    const h = Math.max(...row.map((s) => s.h));
    const cells = row.map((s) => ({ i: s.i, w: (s.w / s.h) * h, h }));
    const w = cells.reduce((a, c) => a + c.w, 0) + gap * (row.length - 1);
    return { h, w, cells };
  });
  const width = Math.max(...rowBoxes.map((r) => r.w));
  const height = rowBoxes.reduce((a, r) => a + r.h, 0) + gap * (rowBoxes.length - 1);
  const cells: CollageCell[] = [];
  let y = 0;
  for (const row of rowBoxes) {
    // A short last row is centered, not left-aligned: a hole on one side reads
    // as a missing panel, a hole on both reads as the end of the sequence.
    let x = (width - row.w) / 2;
    for (const c of row.cells) {
      cells.push({ i: c.i, x, y, w: c.w, h: c.h });
      x += c.w + gap;
    }
    y += row.h + gap;
  }
  return { width, height, cells, rows: rowBoxes.length };
}

/**
 * How many images per row, judged only by the shape that comes out.
 *
 * Score is the log-distance from the target aspect, so 2× too wide and 2× too
 * tall cost the same — a plain ratio would quietly prefer wide ribbons. The
 * small raggedness penalty is the tie-break: with equal shapes on offer, the
 * grid that leaves no hole wins.
 */
export function pickCols(sizes: ImageSize[], gap = 0, targetAspect = COLLAGE_TARGET_ASPECT): number {
  const s = norm(sizes);
  if (s.length < 2) return 1;
  let best = 1;
  let bestScore = Infinity;
  for (let cols = 1; cols <= s.length; cols++) {
    const m = measure(s, cols, gap);
    const ar = m.width / m.height;
    const holes = cols * m.rows - s.length;
    const score = Math.abs(Math.log(ar / targetAspect)) + 0.05 * (holes / s.length);
    if (score < bestScore - 1e-9) { bestScore = score; best = cols; }
  }
  return best;
}

/**
 * The full arrangement, capped to something a phone can actually allocate.
 *
 * Rounding happens once, at the end, on already-scaled numbers: rounding the
 * native geometry first and scaling the rounded values afterwards drifts the
 * seams by a pixel per row, which is visible as a wobbling gap.
 */
export function layoutCollage(sizes: ImageSize[], opts: CollageOpts = {}): CollageLayout {
  const s = norm(sizes);
  if (!s.length) return { cols: 0, rows: 0, gap: 0, width: 0, height: 0, scale: 1, cells: [] };
  const gap = Math.max(0, Math.round(opts.gap ?? defaultGap(s)));
  const cols = clamp(Math.round(opts.cols ?? pickCols(s, gap, opts.targetAspect)), 1, s.length);
  const raw = measure(s, cols, gap);
  const maxSide = opts.maxSide ?? COLLAGE_MAX_SIDE;
  const maxPixels = opts.maxPixels ?? COLLAGE_MAX_PIXELS;
  const scale = Math.min(
    1,
    maxSide / Math.max(raw.width, raw.height),
    opts.maxWidth && opts.maxWidth > 0 ? opts.maxWidth / raw.width : 1,
    Math.sqrt(maxPixels / (raw.width * raw.height)),
  );
  const width = Math.max(1, Math.round(raw.width * scale));
  const height = Math.max(1, Math.round(raw.height * scale));
  const cells = raw.cells.map((c) => {
    const x = Math.round(c.x * scale);
    const y = Math.round(c.y * scale);
    return {
      i: c.i,
      x, y,
      // Clamped so a rounded cell can never poke past the canvas it was
      // measured inside — a drawImage past the edge is silently cropped, and
      // the crop lands on the marked-up part as often as not.
      w: Math.max(1, Math.min(Math.round(c.w * scale), width - x)),
      h: Math.max(1, Math.min(Math.round(c.h * scale), height - y)),
    };
  });
  return { cols, rows: raw.rows, gap: Math.round(gap * scale), width, height, scale, cells };
}

/** "2 across", "stacked", "2 × 2" — how a layout is named in the picker. */
export function collageLabel(count: number, cols: number): string {
  if (count <= 1) return "single";
  if (cols === 1) return "stacked";
  if (cols >= count) return `${count} across`;
  return `${cols} × ${Math.ceil(count / cols)}`;
}

/**
 * What the combined image IS, in one clause, for the agent that receives it.
 *
 * The panel numbers are drawn as PIXELS and nowhere else, so a prompt saying
 * "the id in ② is the one missing in ③" is asking the reader to trust a badge it
 * has to find first — and when the labels are off there is no badge at all, only
 * an order the layout implies and the text never states. Both cases were the
 * same silence: three screenshots arrived as one picture with no word about
 * which end of it came first.
 *
 * So the arrangement is SAID: how many panels, how they run, and whether the
 * numbers on them are real. It rides in the same `(marked: …)` clause as the
 * marks (`web/src/annNote.ts`), which is the one place this repo lets an image
 * carry words.
 */
export function collagePanelNote(count: number, cols: number, labelled: boolean): string {
  if (count <= 1) return "";
  const run = cols === 1
    ? "stacked top to bottom"
    : cols >= count
      ? "in one row, left to right"
      : `${cols} per row, left to right then down`;
  return `collage of ${count} panels ${run}${labelled ? `, numbered 1-${count} in that order` : ", not numbered"}`;
}
