/**
 * Context-window figure detection.
 *
 * Works on ANSI-stripped PTY tail text, like prompt.ts / limit.ts, and is
 * equally heuristic: the phrasings are pinned to what the Claude Code TUI
 * prints for its context indicator (the auto-compact note, the "context left"
 * footer, a "128k/200k tokens" gauge, the /context breakdown). TUI copy
 * changes can break this — it degrades to "unknown" (null), never a wrong
 * number, so a miss just hides the badge.
 */

export interface ContextInfo {
  /** Percent of the window still FREE (0–100), or null. */
  leftPct: number | null;
  /** Tokens used, when an absolute figure is printed. */
  usedTok?: number;
  /** Window total in tokens, when printed. */
  totalTok?: number;
}

/** Percent-remaining phrasings, most specific first. Each capture is the number. */
const PCT_RES: RegExp[] = [
  /context left until auto-?compact:?\s*(\d{1,3})%/i, // "Context left until auto-compact: 42%"
  /(\d{1,3})%\s*context (?:left|remaining|free)/i,     // "42% context left"
  /context (?:left|remaining|free):?\s*(\d{1,3})%/i,   // "Context remaining: 42%"
];

/** "123k/200k tokens" style → absolute used/total. */
const RATIO_RE = /(\d+(?:\.\d+)?)\s*(k|m)?\s*\/\s*(\d+(?:\.\d+)?)\s*(k|m)?\s*(?:tokens|token|ctx|context)/i;

function scale(n: number, unit?: string): number {
  const u = (unit || "").toLowerCase();
  return u === "m" ? n * 1_000_000 : u === "k" ? n * 1_000 : n;
}

/**
 * A row that is unmistakably the CLI's context indicator, whatever number it
 * carries — the word "context" plus one of the words the indicator is built
 * from, on one line.
 *
 * This exists for the health readout and for nothing else, and it is narrow on
 * purpose. "The meter returned null" is worthless as a signal on its own: most
 * sessions most of the time print no context indicator at all, so a session
 * that never shows one would log a miss on every scan and bury the sessions
 * where the indicator IS on screen and the number no longer comes out of it.
 * The gate is what separates "there is nothing to read" from "there is
 * something to read and the parse no longer reads it" — which is the only one
 * of the two that says a regex has gone stale.
 *
 * Deliberately not built from `PCT_RES`/`RATIO_RE`: a gate derived from the
 * matchers it is meant to check on can never disagree with them.
 */
const METER_GATE_RE = /[^\n]*\bcontext\b[^\n]*\b(?:left|remaining|free|window|used|auto-?compact)\b[^\n]*/gi;

/** The last context-indicator row in the text, or null when there is none.
 *  Last, because a repaint-based TUI leaves older frames above the fresh one. */
export function contextMeterRow(text: string): string | null {
  const re = new RegExp(METER_GATE_RE.source, METER_GATE_RE.flags);
  let hit: string | null = null;
  for (let m = re.exec(text); m; m = re.exec(text)) hit = m[0].trim() || hit;
  return hit;
}

export function detectContext(text: string): ContextInfo {
  const out: ContextInfo = { leftPct: null };

  // Absolute token gauge — take the LAST match (freshest redraw wins).
  const rg = new RegExp(RATIO_RE.source, "gi");
  for (let m = rg.exec(text); m; m = rg.exec(text)) {
    const used = scale(Number(m[1]), m[2]);
    const total = scale(Number(m[3]), m[4]);
    if (total > 0 && used >= 0 && used <= total) {
      out.usedTok = Math.round(used);
      out.totalTok = Math.round(total);
      out.leftPct = Math.round((1 - used / total) * 100);
    }
  }

  // Explicit percent phrasing overrides the derived one (more direct signal).
  for (const re of PCT_RES) {
    const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
    let hit: number | null = null;
    for (let m = g.exec(text); m; m = g.exec(text)) {
      const n = Number(m[1]);
      if (n >= 0 && n <= 100) hit = n; // last wins
    }
    if (hit != null) { out.leftPct = hit; break; }
  }

  return out;
}
