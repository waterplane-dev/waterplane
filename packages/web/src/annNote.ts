/**
 * What a marked-up image SAYS, in the one line that rides beside its path.
 *
 * An image reaches the agent as `.claude/inbox/1000074539-mtjv8u52a489a0.jpg`
 * plus whatever the sender typed. The marks on it are pixels: a circle round the
 * broken button, an arrow at the row that is wrong. The reader can see them —
 * but it cannot see WHICH of three identical red circles the sentence "this one"
 * means, and it cannot say back "the second one" and be understood, because
 * nothing in the picture or the text gives a mark a name.
 *
 * That is what this file fixes, and why the note is not decoration:
 *
 *  - **Marks are NUMBERED, in the image and in the words, from one list.** The
 *    badge painted on the canvas and the `#2` in the sentence come from the same
 *    index (`ImageAnnotator`'s `drawBadge`), so a prompt can name a mark and a
 *    reply can name it back. The real prompt log has a message carrying six
 *    marks summarised as six copies of the sentence "red circle at left".
 *  - **Position is a PERCENTAGE, never a pixel.** The flattened PNG is
 *    re-encoded on the way up (`scaleForUpload` shrinks it to the link's width),
 *    so a pixel coordinate stated here names a grid the agent never receives.
 *    The pixel size of what was ACTUALLY uploaded is appended separately
 *    (`withUploadSize`), which is what makes the percentages convertible at all.
 *  - **Colour is said only when it distinguishes.** With numbers on the marks,
 *    "red" on every one of six marks is six tokens buying nothing. Mixed colours
 *    still carry theirs — there the colour IS the distinction.
 *  - **Identical marks collapse.** A double-tap that placed the same circle
 *    twice is one mark to a reader and must not read as two.
 *  - **Words win.** A typed label and text read off a highlighted band are the
 *    only parts that say something the geometry cannot, so they are quoted in
 *    full and never clipped.
 *
 * Pure and node-tested (`annNote.test.mjs`) because every rule above is a
 * sentence someone acts on, and the annotator it is called from needs a canvas,
 * a pointer and a phone to run at all.
 */

/** The tools that can leave a mark. `marker` is the highlighter: a translucent
 *  band over text, whose words the host may have read back (`read`). */
export type MarkTool = "circle" | "rect" | "arrow" | "line" | "text" | "blur" | "marker";

/** One mark, in the flattened image's own pixels. */
export interface Mark {
  tool: MarkTool;
  x0: number; y0: number; x1: number; y1: number;
  /** Radians the mark is turned about its own middle — only ever set by knob
   *  mode's turn knob, and only on a mark with an area (a box, an ellipse, a
   *  blur, a label). A segment turns by moving its two points instead. */
  angle?: number;
  color: string;
  /** What the sender typed onto the image (the `text` tool). */
  text?: string;
  /** What the host read INSIDE a highlighted band, verbatim. Absent whenever
   *  there is no reader, the call failed, or the band held no words — never a
   *  guess, and never a partial line dressed up as a full one. */
  read?: string;
}

export const COLOR_NAMES: Record<string, string> = {
  "#ff2d2d": "red", "#ffd400": "yellow", "#3fb950": "green", "#4c9aff": "blue", "#ffffff": "white",
};

/** Coarse "top-left / center / bottom-right"-style position of a point. */
export function posName(x: number, y: number, w: number, h: number): string {
  const vy = y / h, vx = x / w;
  const v = vy < 0.34 ? "top" : vy > 0.66 ? "bottom" : "middle";
  const hz = vx < 0.34 ? "left" : vx > 0.66 ? "right" : "center";
  if (v === "middle" && hz === "center") return "center";
  if (v === "middle") return hz;
  if (hz === "center") return v;
  return `${v}-${hz}`;
}

/** A percentage of the image's own width/height, clamped and rounded. */
export function pct(v: number): string {
  return `${Math.round(Math.max(0, Math.min(1, v)) * 100)}%`;
}

/** A point as `top-left (x 12%, y 8%)` — the coarse word to read, the numbers to
 *  point with. */
export function posDetail(x: number, y: number, w: number, h: number): string {
  return `${posName(x, y, w, h)} (x ${pct(x / w)}, y ${pct(y / h)})`;
}

/** A drawn region as its coarse position plus the box it actually covers. */
export function regionDetail(m: Mark, w: number, h: number): string {
  const x0 = Math.min(m.x0, m.x1), x1 = Math.max(m.x0, m.x1);
  const y0 = Math.min(m.y0, m.y1), y1 = Math.max(m.y0, m.y1);
  return `${posName((x0 + x1) / 2, (y0 + y1) / 2, w, h)} (x ${pct(x0 / w)}-${pct(x1 / w)}, y ${pct(y0 / h)}-${pct(y1 / h)})`;
}

/**
 * Words that came from a person or from a reader, verbatim and NEVER clipped —
 * they are the instruction, not a caption for one. Only whitespace is flattened
 * (the note is one line inside the prompt) and the quotes that delimit it are
 * neutralised, so a label containing one cannot make the summary read as two
 * marks.
 */
export function quoteText(t: string): string {
  return `"${t.replace(/\s+/g, " ").trim().replace(/"/g, "''")}"`;
}

/** The name a colour goes by, or the hex when it is not one of the five. */
const colorName = (c: string) => COLOR_NAMES[c.toLowerCase()] || c;

/** Two marks a reader could not tell apart: same tool, same colour, same box to
 *  the nearest percent, same words. A second tap that placed a twin is one mark. */
function markKey(m: Mark, w: number, h: number): string {
  return [
    m.tool, m.color.toLowerCase(),
    pct(Math.min(m.x0, m.x1) / w), pct(Math.min(m.y0, m.y1) / h),
    pct(Math.max(m.x0, m.x1) / w), pct(Math.max(m.y0, m.y1) / h),
    (m.text ?? "").trim(), (m.read ?? "").trim(),
  ].join("|");
}

/** The marks as the note will describe them: twins dropped, order kept.
 *  The annotator draws its badges off this same list, so the `#N` in the words
 *  and the number in the picture cannot drift apart. */
export function visibleMarks(marks: Mark[], w: number, h: number): Mark[] {
  if (w <= 0 || h <= 0) return [];
  const seen = new Set<string>();
  const out: Mark[] = [];
  for (const m of marks) {
    const k = markKey(m, w, h);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(m);
  }
  return out;
}

/** One mark, without its number or its colour — those are decided by the set. */
function markBody(m: Mark, w: number, h: number): string {
  switch (m.tool) {
    case "blur": return `blurred/redacted region at ${regionDetail(m, w, h)}`;
    case "text": return `text ${quoteText(m.text || "")} at ${posDetail(m.x0, m.y0, w, h)}`;
    case "marker": {
      const where = regionDetail(m, w, h);
      return m.read ? `highlight over ${quoteText(m.read)} at ${where}` : `highlight at ${where}`;
    }
    case "arrow": return `arrow pointing to ${posDetail(m.x1, m.y1, w, h)}`;
    case "line": return `line from ${posDetail(m.x0, m.y0, w, h)} to ${posDetail(m.x1, m.y1, w, h)}`;
    case "rect": return `box at ${regionDetail(m, w, h)}`;
    default: return `circle at ${regionDetail(m, w, h)}`;
  }
}

/**
 * The whole clause, ready to go inside `path (marked: …)`.
 *
 * `facts` is what the image IS rather than what was marked on it — today the
 * collage arrangement (`shared/collagePanelNote`), which the picture states only
 * in pixels. Empty string when there is nothing to say: an unmarked image gets
 * no parenthetical at all, which is the pre-existing behaviour and the right
 * one — a bare path is not improved by a sentence saying nothing was marked.
 */
export function markNote(marks: Mark[], w: number, h: number, facts?: string): string {
  const list = visibleMarks(marks, w, h);
  const parts: string[] = [];
  if (facts) parts.push(facts);
  // A number is only information when there is something to tell apart, and the
  // annotator paints badges under exactly the same condition.
  const numbered = list.length > 1;
  const colors = new Set(list.map((m) => m.color.toLowerCase()));
  // Blur says what it is; a colour on it describes the frame, not the mark.
  const uniform = colors.size <= 1;
  list.forEach((m, i) => {
    const num = numbered ? `#${i + 1} ` : "";
    const col = uniform || m.tool === "blur" ? "" : `${colorName(m.color)} `;
    parts.push(`${num}${col}${markBody(m, w, h)}`);
  });
  return parts.join("; ");
}

/**
 * The pixel grid the percentages above are percentages OF — appended once the
 * bytes that will actually be sent are known.
 *
 * Deliberately not part of `markNote`: the note is written while the annotator
 * still holds a full-resolution canvas, and the upload re-encodes it to the
 * link's width minutes later (`scaleForUpload`). Stating the size at the wrong
 * end of that is stating a grid nobody receives, so this is called where the
 * answer is a fact, and is simply absent when it is not one — an image whose
 * final size could not be established says nothing about its size.
 */
export function withUploadSize(note: string, size: { w: number; h: number } | null): string {
  if (!note) return note;
  if (!size || !(size.w > 0) || !(size.h > 0)) return note;
  return `${note}; image ${Math.round(size.w)}x${Math.round(size.h)}`;
}
