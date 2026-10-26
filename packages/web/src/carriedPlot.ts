/**
 * Geometry and words for the "What every turn carries" strip (`CarriedSection.tsx`) — pure, no
 * imports but types, so `carriedPlot.test.mjs` loads it bare under `node --test`.
 *
 * Rules it holds (skills `web-numbers`, `dataviz`):
 * - **The strip is the FIRST REQUEST**: 100% = `firstRequestTok`, the parts as their `~chars/4`
 *   estimate, the remainder its own NEUTRAL segment last. When the request cannot be the whole (not
 *   answered yet, or the parts' estimate already exceeds it) the strip is the parts' own sum and
 *   `scaleNote` says so — never a silently re-based bar.
 * - **Colour is a CLASS, not an identity**: a logged attachment, an undocumented record (hatched as
 *   well as hued, so it never rests on hue alone), the remainder (neutral). Nine parts would need
 *   nine hues and the palette has four; identity is the tap's readout and the list under the strip.
 * - **No false precision**: shares are whole percents ("<1%" below one), tokens keep the shared `~`/`≈`.
 */
import type { CarriedRow } from "@waterplane/shared";

export type CarriedClass = "doc" | "undoc" | "rest";

export interface CarriedSeg {
  key: string;
  label: string;
  tok: number;
  /** The shared words (`~19.6k tokens · 78.4k chars`, `≈21k tokens`). */
  words: string;
  cls: CarriedClass;
  /** Left edge and width, in percent of the strip. */
  x: number;
  w: number;
}

export interface CarriedStrip {
  segs: CarriedSeg[];
  /** What 100% is, in tokens. */
  whole: number;
  /** "request": the first request; "parts": the parts' own sum (and `scaleNote` says why). */
  scale: "request" | "parts";
}

/** Largest part first, the remainder last — the list below the strip uses the same order. */
export function carriedOrder<T extends Pick<CarriedRow, "key" | "tok">>(rows: readonly T[]): T[] {
  const rest = rows.filter((r) => r.key === "remainder");
  return [...rows.filter((r) => r.key !== "remainder").sort((a, b) => b.tok - a.tok), ...rest];
}

export const classOf = (r: Pick<CarriedRow, "key" | "undocumented">): CarriedClass =>
  r.key === "remainder" ? "rest" : r.undocumented ? "undoc" : "doc";

/**
 * The strip. `rows` are `carriedRows`' (the remainder row is present only when it could be placed).
 * Null when there is nothing to draw (no part with a token in it and no remainder).
 */
export function carriedStrip(rows: readonly CarriedRow[], firstRequestTok: number | null): CarriedStrip | null {
  const ordered = carriedOrder(rows);
  const hasRest = ordered.some((r) => r.key === "remainder");
  const sum = ordered.reduce((n, r) => n + Math.max(0, r.tok), 0);
  const scale: CarriedStrip["scale"] = hasRest && firstRequestTok != null && firstRequestTok > 0 ? "request" : "parts";
  // With a placed remainder the rows already sum to the request (remainder = request − parts), but
  // take the request itself as the whole so a rounding wobble cannot re-base the bar.
  const whole = scale === "request" ? Math.max(firstRequestTok as number, sum) : sum;
  if (!(whole > 0)) return null;
  let at = 0;
  const segs = ordered.map((r) => {
    const w = (Math.max(0, r.tok) / whole) * 100;
    const s: CarriedSeg = { key: r.key, label: r.label, tok: r.tok, words: r.words, cls: classOf(r), x: at, w };
    at += w;
    return s;
  });
  return { segs, whole, scale };
}

/** The segment under a pointer at `frac` (0..1 across the strip); clamps to the ends, null on an empty strip. */
export function segAt(segs: readonly CarriedSeg[], frac: number): CarriedSeg | null {
  if (!segs.length) return null;
  const p = Math.min(100, Math.max(0, frac * 100));
  for (const s of segs) if (p < s.x + s.w) return s;
  return segs[segs.length - 1];
}

/** A share as words: whole percents, "<1%" for a sliver, never a decimal that implies a measurement. */
export function shareWords(tok: number, whole: number): string {
  if (!(whole > 0)) return "";
  const pct = (tok / whole) * 100;
  if (pct > 0 && pct < 1) return "<1%";
  return `${Math.round(pct)}%`;
}

/** The readout line for a picked segment. */
export function carriedReadout(seg: CarriedSeg, strip: CarriedStrip): string {
  const of = strip.scale === "request" ? "of the first request" : "of the parts";
  return `${seg.label} · ${seg.words} · about ${shareWords(seg.tok, strip.whole)} ${of}`;
}

/** The caption under the strip when it is NOT the first request; null when it is. */
export function scaleNote(strip: CarriedStrip, firstRequestTok: number | null, fmt: (n: number) => string): string | null {
  if (strip.scale === "request") return null;
  if (firstRequestTok == null) return "The bar is the parts' own sum: the first request has not been answered yet, so its size is unknown.";
  return `The bar is the parts' own sum: their estimate exceeds the first request's ${fmt(firstRequestTok)} tokens, so the rest cannot be drawn.`;
}

/** The legend entries, only for the classes on the strip, in strip order. */
export const CLASS_WORDS: Record<CarriedClass, string> = {
  doc: "logged attachment (~)",
  undoc: "undocumented record (~)",
  rest: "the rest of the request (≈)",
};

export function carriedLegend(strip: CarriedStrip): CarriedClass[] {
  const seen = new Set(strip.segs.filter((s) => s.tok > 0).map((s) => s.cls));
  return (["doc", "undoc", "rest"] as const).filter((c) => seen.has(c));
}

/**
 * An absolute path with the home directory as `~` — the CLI logs instruction files by absolute path,
 * and `/Users/<name>/.claude/CLAUDE.md` wrapped over three lines on a phone. Only the home prefix
 * shapes this desktop could have (macOS, Linux, root, Windows); anything else is returned unchanged.
 */
export function tildePath(p: string): string {
  const m = /^(\/Users\/[^/]+|\/home\/[^/]+|\/root|[A-Za-z]:\\Users\\[^\\]+)(?=$|[/\\])/.exec(p);
  return m ? `~${p.slice(m[1].length)}` : p;
}

/** How many names a row shows inline rather than behind a fold. */
export const INLINE_NAMES = 3;

/** Names shown inline (no fold) — only when every name is known (not capped) and there are few. */
export const namesInline = (names: readonly string[], total: number | undefined): boolean =>
  names.length > 0 && names.length <= INLINE_NAMES && (total == null || total <= names.length);
