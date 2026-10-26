/**
 * The always-on strip's geometry and words (Setup sheet, under the `context-weight` row): where the
 * characters Claude Code carries on EVERY turn go, file by file, coloured by what the threshold
 * does with them — counted by the threshold row, listed beside it, or this desktop's own.
 *
 * Pure and node-tested (`alwaysOnPlot.test.mjs`); `AlwaysOnRows.tsx` paints it. Rules it holds
 * (skill `web-numbers`, CLAUDE.md):
 * - **It agrees with the chip filter.** It takes the SAME scopes the list shows, and every row of
 *   those scopes lands in exactly one of: a drawn segment, `idle` (sized, but nothing every turn),
 *   or a marker (unsized). `drawn + idle + markers === rows` is tested, so `repo · 5` under the
 *   chips is five rows here too.
 * - **An unsized row is never a length**: it is a named marker, never a zero-width segment.
 * - **Chars are the fact, tokens are `~`**: every token figure is worded `~`.
 * - **A total never stands without its split**: the legend is the bands, each with its figure.
 * - The per-file sums use the same filter as shared `alwaysOnTotalsWords` (Claude's parts whose
 *   `when` is `always`), so the legend and the lead sentence above print the same numbers.
 */
import { CHARS_PER_TOKEN, countedByThreshold } from "@waterplane/shared";
import type { InstructionFile } from "@waterplane/shared";

export type AoScope = "repo" | "desktop";
/** What the threshold does with a row's chars: counts them, lists them beside itself, or never sees them (desktop). */
export type AoBand = "counted" | "listed" | "desktop";
export const AO_BANDS: readonly AoBand[] = ["counted", "listed", "desktop"];
/** Palette slot per band (`SLOT` in kit/chart/TokenComposition) — in band order, never a fifth. */
export const AO_SLOT: Record<AoBand, number> = { counted: 0, listed: 2, desktop: 3 };

export interface AoSeg {
  key: string;
  path: string;
  kind: string;
  scope: AoScope;
  band: AoBand;
  chars: number;
  /** Left edge and width, percent of the drawn total. */
  x: number;
  w: number;
  /** Whether a 1px seam is drawn on its right edge — only between two segments both wide enough to show one. */
  seam: boolean;
}

export interface AoMarker { key: string; path: string; kind: string; scope: AoScope; why: string }

export interface AoBandTotal { band: AoBand; chars: number; files: number }

export interface AoPlot {
  segs: AoSeg[];
  /** Bands with something in them, in band order (an empty band has no legend entry). */
  bands: AoBandTotal[];
  /** Chars over every drawn segment. */
  total: number;
  /** Unsized rows: named, never drawn as a length. */
  markers: AoMarker[];
  /** Sized rows that put nothing in front of Claude on every turn (scoped, on demand, or not Claude's). */
  idle: number;
  /** Every row in the shown scopes — what the chips count. */
  rows: number;
}

/** A segment narrower than this (percent) gets no seam: the seam would be wider than it. */
const SEAM_MIN_W = 1.5;

const bandOf = (f: InstructionFile): AoBand =>
  f.scope === "desktop" ? "desktop" : countedByThreshold(f) ? "counted" : "listed";

/** Claude's every-turn chars of one file — the filter `alwaysOnTotalsWords` sums with. */
export function everyTurnChars(f: InstructionFile): number {
  return f.parts.filter((p) => p.readers.includes("claude") && p.when.kind === "always").reduce((n, p) => n + p.chars, 0);
}

/**
 * The strip for the rows of `scopes` (the chip cut: both scopes, or the lit one). Inside a band the
 * segments run largest first, so the file that matters most is the one a finger finds.
 */
export function aoPlot(files: InstructionFile[], scopes: readonly AoScope[]): AoPlot {
  const mine = files.filter((f) => scopes.includes(f.scope ?? "repo"));
  const markers: AoMarker[] = [];
  const sized: { f: InstructionFile; i: number; chars: number; band: AoBand }[] = [];
  let idle = 0;
  mine.forEach((f, i) => {
    const scope: AoScope = f.scope ?? "repo";
    if (f.unsized) { markers.push({ key: `${scope}:${f.path}:${f.kind}`, path: f.path, kind: f.kind, scope, why: f.unsized }); return; }
    const chars = everyTurnChars(f);
    if (chars <= 0) { idle++; return; }
    sized.push({ f, i, chars, band: bandOf(f) });
  });
  sized.sort((a, b) => AO_SLOT[a.band] - AO_SLOT[b.band] || b.chars - a.chars || a.i - b.i);
  const total = sized.reduce((n, s) => n + s.chars, 0);
  let acc = 0;
  const segs: AoSeg[] = sized.map((s) => {
    const x = total > 0 ? (acc / total) * 100 : 0;
    acc += s.chars;
    const w = total > 0 ? (s.chars / total) * 100 : 0;
    const scope: AoScope = s.f.scope ?? "repo";
    return { key: `${scope}:${s.f.path}:${s.f.kind}`, path: s.f.path, kind: s.f.kind, scope, band: s.band, chars: s.chars, x, w, seam: false };
  });
  for (let i = 0; i < segs.length - 1; i++) segs[i].seam = segs[i].w >= SEAM_MIN_W && segs[i + 1].w >= SEAM_MIN_W;
  const bands: AoBandTotal[] = AO_BANDS.map((band) => {
    const of = segs.filter((s) => s.band === band);
    return { band, chars: of.reduce((n, s) => n + s.chars, 0), files: of.length };
  }).filter((b) => b.files > 0);
  return { segs, bands, total, markers, idle, rows: mine.length };
}

/** The segment under a finger at `frac` (0..1 of the bar's width); null off the bar or with nothing drawn. */
export function aoPick(segs: AoSeg[], frac: number): number | null {
  if (!segs.length || !(frac >= 0) || frac > 1) return null;
  const pct = frac * 100;
  for (let i = 0; i < segs.length; i++) if (pct < segs[i].x + segs[i].w) return i;
  return segs.length - 1;
}

/** At most `cap` markers by name; the rest are counted, never dropped. */
export function aoMarkerFold(markers: AoMarker[], cap = 6): { shown: AoMarker[]; more: number } {
  return { shown: markers.slice(0, cap), more: Math.max(0, markers.length - cap) };
}

type Fmt = (n: number) => string;
const tok = (chars: number) => Math.round(chars / CHARS_PER_TOKEN);

export const AO_BAND_NAME: Record<AoBand, string> = {
  counted: "threshold counts",
  listed: "listed beside it",
  desktop: "this desktop",
};

const BAND_SAYS: Record<AoBand, string> = {
  counted: "counted by the threshold row",
  listed: "listed beside the threshold, not counted by it",
  desktop: "this desktop's, in every session — the threshold counts none of it",
};

/** One legend entry's figure: `~N tok`, the estimate worded as one. */
export const aoBandFigure = (b: AoBandTotal, fmt: Fmt): string => `~${fmt(tok(b.chars))} tok`;

/** The strip's name line: the total, always followed by the legend's split. */
export function aoHeadWords(p: AoPlot, fmt: Fmt): string {
  if (!p.segs.length) return "Nothing from these files reaches Claude Code on every turn.";
  return `Every turn: ~${fmt(tok(p.total))} tokens (${fmt(p.total)} chars) from ${p.segs.length} ${p.segs.length === 1 ? "file" : "files"}`;
}

/** The readout for a picked segment: the file, its chars and `~` tokens, and what the threshold does with it. */
export function aoSegWords(s: AoSeg, total: number, pathWords: (s: AoSeg) => string, fmt: Fmt): string {
  const pct = total > 0 ? (s.chars / total) * 100 : 0;
  const share = pct < 1 ? "<1%" : `${Math.round(pct)}%`;
  return `${pathWords(s)} · ~${fmt(tok(s.chars))} tokens (${fmt(s.chars)} chars, ${share}) · ${BAND_SAYS[s.band]}`;
}

/** What the strip leaves out, in one sentence — null when it leaves nothing out. */
export function aoLeftOutWords(p: AoPlot): string | null {
  const bits: string[] = [];
  if (p.idle) bits.push(`${p.idle} ${p.idle === 1 ? "row carries" : "rows carry"} nothing every turn (scoped, on demand, or not read by Claude Code)`);
  if (p.markers.length) bits.push(`${p.markers.length} ${p.markers.length === 1 ? "row has" : "rows have"} no size and ${p.markers.length === 1 ? "is" : "are"} named below the bar, never drawn as a length`);
  if (!bits.length) return null;
  return `${p.segs.length} of ${p.rows} rows drawn; ${bits.join("; ")}.`;
}
