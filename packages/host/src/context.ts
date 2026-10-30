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
 * A session editing THIS file puts every phrasing above on screen — in the
 * agent's prose, in a diff, in a tool result — and each one read as a live
 * gauge: the phone's context badge showed this file's example 42%. So a figure
 * is read only off a row that is not the conversation's: `isConversationRow`,
 * below, the one rule the health gate applies too, so the two never disagree
 * about a row. Nothing is asked of where on the row the figure sits: the footer
 * sets it off by however much room the width leaves, and a person's status line
 * puts what it likes on either side.
 */
const CODE_ROW_RE = /^\s*\d+(?:\s+[+-]?\s|→)/;

/** Is the match starting at `at` in `text` on a row that is not the conversation's? */
function onMeterRow(text: string, at: number): boolean {
  const start = text.lastIndexOf("\n", at - 1) + 1;
  const stop = text.indexOf("\n", at);
  return !isConversationRow(text.slice(start, stop < 0 ? text.length : stop));
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

/**
 * The words alone are not enough: the agent's own prose talks about "the
 * Context window" and "/compact" all day, and every such line passed the gate
 * and filed a miss — 18 of them, 0 good, a BROKEN chip over a meter that was
 * never on screen. An indicator always carries a figure (`42%`, `123k`), and
 * it is never a row of the conversation: `⏺` opens an assistant line, `⎿` a
 * tool result, `>`/`❯` the person's own words — nor a line-numbered row of code,
 * nor a row with a quote mark or a backtick on it: the CLI never quotes its own
 * meter, and an agent's continuation row quoting one has no glyph to give it
 * away. The reader refuses those rows too (`onMeterRow`), so a gate that took them
 * would file a miss against a reader that was right.
 */
const METER_FIGURE_RE = /\d\s*%|\d(?:\.\d+)?\s*[km]\b/i;
const CONVERSATION_ROW_RE = /^\s*[⏺⎿>❯]/;
const QUOTED_RE = /["`“”]/;
function isConversationRow(row: string): boolean {
  return CONVERSATION_ROW_RE.test(row) || CODE_ROW_RE.test(row) || QUOTED_RE.test(row);
}

/** The last context-indicator row in the text, or null when there is none.
 *  Last, because a repaint-based TUI leaves older frames above the fresh one. */
export function contextMeterRow(text: string): string | null {
  const re = new RegExp(METER_GATE_RE.source, METER_GATE_RE.flags);
  let hit: string | null = null;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const row = m[0].trim();
    if (row && METER_FIGURE_RE.test(row) && !isConversationRow(m[0])) hit = row;
  }
  return hit;
}

export function detectContext(text: string): ContextInfo {
  const out: ContextInfo = { leftPct: null };

  // Absolute token gauge — take the LAST match (freshest redraw wins).
  const rg = new RegExp(RATIO_RE.source, "gi");
  for (let m = rg.exec(text); m; m = rg.exec(text)) {
    const used = scale(Number(m[1]), m[2]);
    const total = scale(Number(m[3]), m[4]);
    if (total > 0 && used >= 0 && used <= total && onMeterRow(text, m.index)) {
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
      if (n >= 0 && n <= 100 && onMeterRow(text, m.index)) hit = n; // last wins
    }
    if (hit != null) { out.leftPct = hit; break; }
  }

  return out;
}
