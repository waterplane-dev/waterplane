/**
 * "The turn ended and the agent is asking YOU something" — in prose, with no
 * box to parse.
 *
 * `prompt.ts` detects the CLI's own dialogs: numbered options, a cursor, an
 * "Enter to confirm" footer. Those are the questions the CLI is blocked ON. But
 * most decisions an agent hands back are not dialogs at all — the turn simply
 * ENDS on "Want 2 implemented, or leave it at 1?" and the composer comes back.
 * The CLI is not blocked; the WORK is, and nothing on the phone said so: the
 * session went idle, the push read "Turn finished", the launcher badged it
 * `done`, and the one thing that would have moved it forward — an answer — was
 * the one thing the row did not ask for.
 *
 * These rules lived inside the retired in-core oracle, where they gated a Gemini call. That
 * made the detection conditional on a THIRD-PARTY API KEY: with no
 * `GEMINI_API_KEY` (the common case) the tail was never even looked at. The
 * heuristic is free and the fact is the phone's — so it lives here, and a
 * plugin hears it as a `question` event rather than owning it.
 *
 * Reads the RENDERED screen where the session has one (`screenlog.ts`'s
 * `gridText()`), else the ANSI-stripped scrollback tail, and degrades to "no
 * question" — never to a wrong one. The raw tail is not text: the CLI places
 * words with cursor moves rather than spaces and newlines, so stripping the
 * escapes glued a whole paragraph into "TheUIisstillwronghere" on the phone's
 * "waiting for your answer" card.
 */

/**
 * Lines of the CLI's chrome (the composer, the key legend, the status footer)
 * that sit BELOW the agent's last message in scrollback. Stripped so the
 * question window sees the agent's actual closing lines, not the prompt box.
 */
const TUI_CHROME = /^(>|❯|│|┃|╭|╰|─|━|⏵|✳|✻|·|\[|🤖)|message or|\/command|auto[- ]?mode|shift\+tab|for agents|bypassing permissions|\? for shortcuts|baked for|\besc\b.*\btab\b|^[\s↑↓←→↵⏎^c]+$/i;

/** A row that starts its own item rather than continuing the one above. */
const ITEM_START = /^([-*•●⏺⎿]|\d+[.)])\s/;
/** A row that ends a sentence, so the next row is not its wrapped tail. */
const SENTENCE_END = /[.?!:…"'”’)]$/;

/**
 * Cleaned, non-empty content lines with trailing TUI chrome removed, and rows
 * the CLI WRAPPED rejoined into the line they belong to. On a rendered grid a
 * phone-width pane breaks "Want me to fix it so it reads something like / in
 * the last 4h, show all?" over two rows, and the ask would be its last row
 * alone. A row joins the one above when that one stops mid-sentence and this
 * one does not open a list item; a blank row always separates.
 */
function contentLines(tail: string): string[] {
  const rows = tail.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").split("\n").map((l) => l.trim());
  let end = rows.length;
  while (end > 0 && (!rows[end - 1] || TUI_CHROME.test(rows[end - 1]))) end--;
  const out: string[] = [];
  let open = false;   // the last line may still take a wrapped continuation
  for (const row of rows.slice(0, end)) {
    if (!row) { open = false; continue; }
    if (open && !ITEM_START.test(row) && !TUI_CHROME.test(row)) out[out.length - 1] += " " + row;
    else out.push(row);
    open = !SENTENCE_END.test(out[out.length - 1]);
  }
  return out;
}

/** The agent's closing lines (last ~8 content lines) — the actual ask, not the
 *  whole read-context. Used for question detection and `answergate.ts`'s text block check. */
export function questionWindow(tail: string): string[] {
  return contentLines(tail).slice(-8);
}

/** Human-readable question text (the closing lines) for the audit log. */
export function questionText(tail: string): string {
  return questionWindow(tail).join(" ").slice(-240).trim() || "question";
}

/**
 * Heuristic: does the tail look like the agent asking the USER a question (and
 * waiting), vs ordinary output? Conservative to limit false positives.
 */
export function looksLikeQuestion(tail: string): boolean {
  const window = questionWindow(tail);
  const last = window.join(" ");
  if (!last) return false;
  if (/\?\s*$/.test(window[window.length - 1])) return true; // last content line is a question
  if (window.some((l) => /\?\s*$/.test(l))) return true;     // any recent line ends with "?"
  // An ask with no "?" is read off the SIGN-OFF line only, and "which"/"how
  // should" only as its opener: matched anywhere in the window, a relative
  // clause ("…18:59), which is how the row is set up.") badged a plain report
  // "asked you" with nothing to answer.
  const sign = window[window.length - 1];
  return /\b(want me to|should i|shall i|do you want|would you like|ok to)\b/i.test(sign) || /^(which|how should)\b/i.test(sign);
}

/**
 * The ONE sentence to put in front of a person: the last line of the window
 * that actually reads as the ask, not the eight lines around it.
 *
 * A push body and a launcher row have room for a sentence, and `questionText`'s
 * 240-character join of the closing lines is a paragraph of whatever the agent
 * happened to print last — which on a phone means the question itself is the
 * part that gets cut. So: prefer the last line ending in "?", else the last
 * content line, and cap it.
 */
export function askLine(tail: string, cap = 180): string {
  const window = questionWindow(tail);
  if (!window.length) return "";
  const q = [...window].reverse().find((l) => /\?\s*$/.test(l)) ?? window[window.length - 1];
  const line = q.trim();
  return line.length > cap ? line.slice(0, cap - 1).trimEnd() + "…" : line;
}

/**
 * Are two `askLine` readings the SAME question?
 *
 * The line is read off the raw byte tail, not a rendered grid, and a repaint
 * rewrites that tail: a redraw that positions words with cursor moves instead
 * of spaces reads back "whichiswhy" where the first frame read "which is why",
 * and the gluing moves where the 180-char cap cuts. Byte equality therefore
 * failed on the very next repaint, so a question marked handled came straight
 * back with a new clock. Compared on letters and digits only; a CAPPED reading
 * (ends "…") matches anything it is a prefix of, and only a capped one — a bare
 * "Go?" must not swallow "Going to delete it, ok?".
 */
export function sameAsk(a: string, b: string): boolean {
  const norm = (s: string) => s.replace(/…$/, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  const na = norm(a), nb = norm(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (a.endsWith("…") && nb.startsWith(na)) return true;
  if (b.endsWith("…") && na.startsWith(nb)) return true;
  return false;
}
