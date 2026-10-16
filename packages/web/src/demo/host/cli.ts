/**
 * The demo's PTY drawn the way the real `claude` TUI draws it — so the docs gifs show the screen a
 * Claude Code user knows, not a sketch of it.
 *
 * Scenarios keep writing their transcript in a short source form (`> prompt`, `● text`,
 * `● Tool(arg)` + `  ⎿  result`). This module is the one place that turns it into what the CLI
 * prints, measured against a real `claude` v2.1 in tmux:
 *
 * - a prompt is `❯ text` on a grey band, an answer `⏺ text`, a tool `⏺ Tool(arg)` with a green dot,
 *   and every block is set off by a blank line;
 * - text is wrapped at WORDS to the phone's grid, continuation lines hanging under the text (the CLI
 *   lays out to the PTY's width; the demo's 80-column strings broken mid-word by xterm read as fake);
 * - under the transcript sits the CLI's own input box — a rule, `❯ `, a rule, `? for shortcuts` —
 *   with the spinner line above it while a turn runs. It is redrawn in place after every write, the
 *   way Ink redraws its live region: up to its first row, erase down, transcript, box again.
 *
 * The source stays in `DemoScreen.log`; `data` is what was streamed. A resize repaints from the log.
 */
import type { SessionInfo } from "@waterplane/shared";

const ESC = "\x1b[";
const SGR = /\x1b\[[0-9;?]*[A-Za-z]/g;
const R0 = `${ESC}0m`;
const DIM = `${ESC}38;5;246m`;
const RULE = `${ESC}38;5;244m`;
// The CLI's truecolour orange (the logo's, the stub TUI's) — not the salmon 256-colour 174 a tmux capture quantises it to.
const ORANGE = `${ESC}38;2;215;119;87m`;
const GREEN = `${ESC}38;5;114m`;
const BAND = `${ESC}48;5;237m`;

/** Cells a string takes on screen: escapes are free, everything else one cell (the demo's
 *  glyphs are all single-width). */
const cells = (s: string): number => [...s.replace(SGR, "")].length;

/** Word-wrap one styled line to `cols`, continuation lines indented by `hang` spaces. A word longer
 *  than a line is cut where the line ends, as the CLI does with a long path. Styles are re-opened on
 *  each continuation so a dimmed result stays dim. */
export function wrap(line: string, cols: number, hang: number): string[] {
  if (!Number.isFinite(cols) || cells(line) <= cols) return [line];
  const tokens = line.match(/\x1b\[[0-9;?]*[A-Za-z]|\s+|[^\s\x1b]+/g) ?? [];
  const out: string[] = [];
  let cur = "";
  let w = 0;
  let open = ""; // the SGR codes in force, to re-open on the next line
  const pad = " ".repeat(hang);
  const breakLine = () => { out.push(cur + R0); cur = pad + open; w = hang; };
  for (const t of tokens) {
    if (t.startsWith("\x1b")) { cur += t; open = t === R0 || t === `${ESC}m` ? "" : open + t; continue; }
    if (/^\s+$/.test(t)) {
      if (w + t.length > cols) { breakLine(); continue; }
      if (w > hang || out.length === 0) { cur += t; w += t.length; }
      continue;
    }
    let word = [...t];
    if (w + word.length > cols && w > hang) { cur = cur.replace(/\s+$/, ""); breakLine(); }
    while (w + word.length > cols) {
      const room = Math.max(1, cols - w);
      cur += word.slice(0, room).join("");
      word = word.slice(room);
      breakLine();
    }
    cur += word.join("");
    w += word.length;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

/** One source line as the CLI prints it, and how far its continuation lines hang. */
function style(line: string): { text: string; hang: number; block: boolean } {
  const plain = line.replace(SGR, "");
  const prompt = /^(?:\x1b\[[0-9;]*m)*>(?:\x1b\[[0-9;]*m)* (.*)$/.exec(line);
  if (prompt) return { text: `${BAND}${DIM}❯ ${ESC}38;5;255m${prompt[1]}${R0}`, hang: 2, block: true };
  if (plain.startsWith("● ")) {
    const tool = /^(?:\x1b\[[0-9;]*m)*● ([A-Z][A-Za-z]*)(?:\x1b\[[0-9;]*m)*\((.*)$/.exec(line);
    if (tool) return { text: `${GREEN}⏺${R0} ${ESC}1m${tool[1]}${R0}(${tool[2]}`, hang: 2, block: true };
    return { text: line.replace("● ", "⏺ "), hang: 2, block: true };
  }
  if (plain.startsWith("  ⎿")) return { text: line.replace(/\x1b\[2m/g, DIM), hang: 5, block: false };
  return { text: line, hang: 0, block: false };
}

/**
 * Source text → screen lines at `cols`. `afterBlank` says whether the transcript so far ends on a
 * blank line, so a new block is set off by one without doubling a blank the source already has. Lines are complete: a chunk that does not
 * end on a newline is closed, because the input box is drawn right under it.
 */
export function render(src: string, cols: number, afterBlank: boolean): { lines: string[]; endsBlank: boolean } {
  const parts = src.replace(/\r\n?/g, "\n").replace(/\n$/, "").split("\n");
  const lines: string[] = [];
  let blank = afterBlank;
  for (const p of parts) {
    if (!p.replace(SGR, "").trim()) {
      lines.push(""); // a blank the source asked for is kept: the banner's top rows are room for buttons
      blank = true;
      continue;
    }
    const s = style(p);
    if (s.block && !blank) lines.push("");
    lines.push(...wrap(s.text, cols, s.hang));
    blank = false;
  }
  return { lines, endsBlank: blank };
}

/** The live region under the transcript: the spinner while a turn runs, the input box always. */
export function footer(s: SessionInfo | undefined, cols: number, now: number, afterBlank = true): string[] {
  const w = Math.max(10, Math.min(Number.isFinite(cols) ? cols : 80, 200));
  const rule = `${RULE}${"─".repeat(w)}${R0}`;
  const rows: string[] = afterBlank ? [] : [""];
  if (s?.turnActive && !s.awaitingInput) {
    const secs = s.turnStartedAt ? Math.max(1, Math.round((now - s.turnStartedAt) / 1000)) : 1;
    rows.push(`${ORANGE}✻ Cooking…${R0} ${DIM}(${secs}s · esc to interrupt)${R0}`, "");
  }
  rows.push(rule, `${DIM}❯${R0} `, rule, `${DIM}  ? for shortcuts${R0}`);
  return rows;
}

/** Bytes that take the cursor from the end of a drawn footer of `n` rows back to its first row
 *  and erase from there down. */
export const eraseFooter = (n: number): string => (n > 0 ? `\r${n > 1 ? `${ESC}${n - 1}A` : ""}${ESC}J` : "");

/** Lines joined for the PTY; the last one gets no newline, so the cursor stays on the box. */
export const join = (lines: string[]): string => lines.join("\r\n");
