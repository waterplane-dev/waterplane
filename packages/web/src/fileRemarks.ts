/**
 * Remarks on a text file — the pure half of the file viewer's review mode
 * (`FileReview.tsx`), node-tested in `fileRemarks.test.mjs`.
 *
 * The image annotator's idea, for a file somebody is READING: mark a line or a
 * run of lines, say what should change, do that a few times down the file, and
 * hand the lot to the chat as ONE message. What the agent needs from each
 * remark is where (`path:from-to`, which it can open), what those lines said
 * when they were marked (so a file that moved on since is still findable), and
 * the words — which are never clipped. The quoted lines are; the file is on
 * the desktop and the agent can read the rest.
 *
 * Remarks are numbered from ONE ordering (`orderRemarks`) that feeds both the
 * badges on screen and the numbers in the message, the same rule as a marked
 * image's `visibleMarks`: "#2" on the phone is "2." in the chat.
 */

export interface Remark {
  id: string;
  /** 1-based, inclusive. */
  from: number;
  to: number;
  /** The lines as they read when the remark was made. */
  quote: string[];
  /** What should change. Typed or dictated — never clipped. */
  text: string;
  /** The quoted lines are no longer anywhere in the file: kept where they
   *  were, and the message says they changed. */
  moved?: boolean;
}

/** A selection in progress. `open` = one tap made, the next one closes the
 *  range; a closed range starts over on the next tap. */
export interface Sel {
  from: number;
  to: number;
  open: boolean;
}

/**
 * A tap on a line (or on a rendered block covering `a..b`).
 *
 * First tap marks it and waits; a second tap elsewhere stretches the mark to
 * cover both; a second tap on the same thing takes the mark away. A third tap
 * starts again — on a phone there is no shift key, and two taps is the
 * cheapest way to say "from here to there".
 */
export function nextSel(sel: Sel | null, a: number, b = a): Sel | null {
  const lo = Math.min(a, b), hi = Math.max(a, b);
  if (!sel || !sel.open) return { from: lo, to: hi, open: true };
  if (sel.from === lo && sel.to === hi) return null;
  return { from: Math.min(sel.from, lo), to: Math.max(sel.to, hi), open: false };
}

/** `12` or `12-15`. */
export function lineSpan(from: number, to: number): string {
  return from === to ? `${from}` : `${from}-${to}`;
}

/** Said on screen: `line 12` / `lines 12–15`. */
export function lineSpanText(from: number, to: number): string {
  return from === to ? `line ${from}` : `lines ${from}–${to}`;
}

/** The order the remarks are NUMBERED in: down the file, ties by length. */
export function orderRemarks(rs: readonly Remark[]): Remark[] {
  return rs.slice().sort((x, y) => x.from - y.from || x.to - y.to);
}

/** The remark numbers touching `a..b`, in order — what a line's badge says. */
export function remarksAt(ordered: readonly Remark[], a: number, b = a): number[] {
  const out: number[] = [];
  ordered.forEach((r, i) => { if (r.from <= b && r.to >= a) out.push(i + 1); });
  return out;
}

/** The lines `from..to` of `lines`, clamped to what is there. */
export function sliceLines(lines: readonly string[], from: number, to: number): string[] {
  return lines.slice(Math.max(0, from - 1), Math.max(0, to));
}

function sameLines(lines: readonly string[], at: number, quote: readonly string[]): boolean {
  if (at < 1 || at - 1 + quote.length > lines.length) return false;
  for (let i = 0; i < quote.length; i++) if (lines[at - 1 + i] !== quote[i]) return false;
  return true;
}

/**
 * Re-find each remark in the file as it reads NOW.
 *
 * Remarks are kept on the phone between visits, and an agent is very likely
 * editing the very file being reviewed. Where the quoted lines still stand, a
 * remark keeps its place; where they moved, it follows them (the nearest copy,
 * if there are several); where they are gone, it stays put and says so —
 * never silently re-pointed at whatever now sits on those line numbers.
 */
export function relocate(rs: readonly Remark[], lines: readonly string[]): Remark[] {
  return rs.map((r) => {
    if (!r.quote.length) return r;
    if (sameLines(lines, r.from, r.quote)) return r.moved ? { ...r, moved: false } : r;
    let best = -1;
    for (let at = 1; at + r.quote.length - 1 <= lines.length; at++) {
      if (lines[at - 1] !== r.quote[0] || !sameLines(lines, at, r.quote)) continue;
      if (best < 0 || Math.abs(at - r.from) < Math.abs(best - r.from)) best = at;
    }
    if (best < 0) return r.moved ? r : { ...r, moved: true };
    return { ...r, from: best, to: best + r.quote.length - 1, moved: false };
  });
}

/** Quoted lines past this many are elided in the middle. */
export const QUOTE_MAX_LINES = 4;
/** A quoted line past this many characters is cut. */
export const QUOTE_MAX_CHARS = 160;

function clipLine(l: string): string {
  return l.length > QUOTE_MAX_CHARS ? `${l.slice(0, QUOTE_MAX_CHARS - 1)}…` : l;
}

/** The quote as it goes in the message: `> ` lines, long runs elided. */
export function quoteLines(quote: readonly string[]): string[] {
  const q = quote.length > QUOTE_MAX_LINES
    ? [...quote.slice(0, QUOTE_MAX_LINES - 1).map(clipLine), `… ${quote.length - QUOTE_MAX_LINES} more lines …`, clipLine(quote[quote.length - 1])]
    : quote.map(clipLine);
  return q.map((l) => (l.trim() ? `> ${l}` : ">"));
}

/**
 * The message: every remark on one file, numbered as on screen.
 *
 *     Remarks on README.md (2):
 *
 *     1. README.md:12-14
 *     > the lines
 *     what should change
 *
 * Only the remarks with words are sent — a mark with nothing said about it is
 * a question the agent cannot answer.
 */
export function remarksBlock(path: string, rs: readonly Remark[]): string | null {
  const said = orderRemarks(rs).filter((r) => r.text.trim());
  if (!said.length) return null;
  const parts = said.map((r, i) => {
    const head = `${i + 1}. ${path}:${lineSpan(r.from, r.to)}${r.moved ? " (these lines have changed since — quoted as they read then)" : ""}`;
    return [head, ...quoteLines(r.quote), r.text.trim()].join("\n");
  });
  return `Remarks on ${path} (${said.length}):\n\n${parts.join("\n\n")}\n`;
}
