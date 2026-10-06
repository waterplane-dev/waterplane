/**
 * The ONE headless VT replay: raw PTY bytes → the text that was on screen.
 *
 * The claude TUI positions characters with absolute cursor moves and full-screen
 * repaints rather than printing linearly, so simply stripping ANSI leaves
 * shuffled fragments ("· ← ···") — and, worse, fragments with the spaces GONE,
 * because a gap drawn by a cursor jump is not a space in the byte stream.
 * `Current session` arrives as `Currentsession`. Feeding the bytes to a real VT
 * and reading back the buffer yields what a user would see. The width must match
 * the live PTY or lines wrap wrong. Best-effort — a usable record of what the
 * turn printed, not a true chat transcript.
 *
 * It lives here rather than in `sessions.ts` because it has two callers with no
 * session between them: `screenText()` (a live PTY's scrollback) and `usage.ts`
 * (a short-lived probe's capture). The second one is why the extraction happened
 * — `/usage` prints each window's reset instant as WORDS under its heading
 * ("Resets Sep 10 at 7pm (Europe/Berlin)"), and a scraper reading stripped bytes
 * could match neither the heading nor the sentence, so both resets were null on
 * a screen that named them both.
 *
 * Cost is a full VT replay, so this is for rare paths, not per-frame checks.
 *
 * ## Two readbacks, one replay
 *
 * `renderCapture()` answers "what did it say"; `renderCells()` answers "what did
 * it say, and how was it painted". They share `replay()` and differ only in what
 * they read out of the same buffer, because the alternative was a second VT — a
 * second opinion about what is on a screen, which is exactly the thing CLAUDE.md
 * names this file to prevent.
 *
 * The attributed readback exists because of a measured fact about a second
 * backend: opencode's permission dialog marks the ARMED option with a background
 * colour and nothing else — no number, no `❯`, no bold. Flattening to text
 * throws away the one bit that says which option a Return would press, so the
 * dialog was unanswerable from the phone and `caps.promptBoxes` was false. See
 * `ocprompt.ts` for the reader and `docs/notes/host.md` for the byte-level
 * measurement. The colours themselves are never named here: this file reports
 * what the VT holds, and every judgement about it is the reader's.
 */
import xtermHeadless from "@xterm/headless";
const { Terminal } = xtermHeadless;

/** Replay `raw` into a headless VT of the given width and hand the buffer to
 *  `read`, disposing the terminal whatever `read` does with it. */
function replay<T>(raw: string, cols: number, read: (term: InstanceType<typeof Terminal>) => T): Promise<T> {
  return new Promise((resolve) => {
    const term = new Terminal({
      cols: Math.max(20, cols || 80),
      rows: 50,
      scrollback: 5000,
      allowProposedApi: true,
    });
    term.write(raw, () => {
      let out: T;
      try {
        out = read(term);
      } finally {
        term.dispose();
      }
      resolve(out);
    });
  });
}

export function renderCapture(raw: string, cols: number): Promise<string> {
  if (!raw) return Promise.resolve("");
  return replay(raw, cols, (term) => {
    const buf = term.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < buf.length; i++) {
      const line = buf.getLine(i);
      lines.push(line ? line.translateToString(true) : "");
    }
    // Trim trailing spaces and squeeze 3+ blank lines down to one gap.
    return lines.join("\n").replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n").trim();
  });
}

/**
 * A run of adjacent cells that agree on every attribute this app reads back.
 *
 * `bg`/`fg` are OPAQUE KEYS, not colours to compare against a constant: the VT
 * reports a palette index, a 24-bit value or "the terminal's default" and those
 * are three different things that no single number can stand for. A reader may
 * ask whether two spans were painted the same way; it may not ask what shade
 * they were, because the answer changes with the user's theme and the repo rule
 * is that a heuristic degrades to absent rather than to a wrong number.
 */
export interface RenderSpan {
  /** Column of the first cell in the run. */
  from: number;
  /** Column of the last cell in the run, inclusive. */
  to: number;
  /** The characters in the run, one per cell — spaces included. */
  text: string;
  /** Background key: `def`, `pal:<n>` or `rgb:<n>`. */
  bg: string;
  /** Foreground key, same shape. */
  fg: string;
}

/** One rendered row: its text, and the runs it was painted in. */
export interface RenderRow {
  /** Exactly what `renderCapture()` would have for this row. */
  text: string;
  /** Left to right, contiguous, covering every column of the grid. */
  spans: RenderSpan[];
  /**
   * `text` with every DIM (SGR 2) cell blanked, trailing blanks trimmed.
   *
   * Kept apart from `spans` on purpose: adding dim to the run key would split
   * runs `ocprompt.ts` reads by colour. Dim is not a shade — it is the TUI saying
   * "this is a hint, not content", which is how claude and Codex draw an EMPTY
   * composer's suggestion (both measured), and `deliver.ts` asks whether a box
   * holds anything with this row rather than `text`.
   */
  undimmed: string;
}

/** The attribute key for one cell, in the shape `RenderSpan` documents. */
function bgKey(c: { getBgColor(): number; isBgRGB(): boolean; isBgPalette(): boolean }): string {
  return c.isBgRGB() ? `rgb:${c.getBgColor()}` : c.isBgPalette() ? `pal:${c.getBgColor()}` : "def";
}
function fgKey(c: { getFgColor(): number; isFgRGB(): boolean; isFgPalette(): boolean }): string {
  return c.isFgRGB() ? `rgb:${c.getFgColor()}` : c.isFgPalette() ? `pal:${c.getFgColor()}` : "def";
}

/**
 * The same replay, read back WITH the attributes: every row of the buffer as
 * its text plus the runs of cells that were painted alike.
 *
 * Only the rows a caller asks for are built (`tailRows`, newest-last), because
 * the per-cell walk is the expensive half: a full 5,000-row scrollback at 80
 * columns is 400,000 cell reads, and every caller of this so far wants the
 * bottom of a live screen. 0 means the whole buffer.
 */
export function renderCells(raw: string, cols: number, tailRows = 0): Promise<RenderRow[]> {
  if (!raw) return Promise.resolve([]);
  return replay(raw, cols, (term) => {
    const buf = term.buffer.active;
    const width = term.cols;
    const start = tailRows > 0 ? Math.max(0, buf.length - tailRows) : 0;
    const rows: RenderRow[] = [];
    // One reusable cell for the whole walk: `getCell(x)` allocates a fresh
    // object per call, and this loop makes one call per cell on screen.
    const scratch = buf.getNullCell?.();
    for (let i = start; i < buf.length; i++) {
      const line = buf.getLine(i);
      if (!line) { rows.push({ text: "", spans: [], undimmed: "" }); continue; }
      const spans: RenderSpan[] = [];
      let lit = "";
      let cur: RenderSpan | null = null;
      for (let x = 0; x < width; x++) {
        const cell = line.getCell(x, scratch);
        if (!cell) continue;
        const bg = bgKey(cell);
        const fg = fgKey(cell);
        if (!cur || cur.bg !== bg || cur.fg !== fg) {
          cur = { from: x, to: x, text: "", bg, fg };
          spans.push(cur);
        }
        cur.to = x;
        // A cell the VT left empty reads as "", and a row of those must still
        // occupy its columns — a span's text is one character per cell or the
        // column arithmetic every reader does on top of it is wrong.
        cur.text += cell.getChars() || " ";
        // The second cell of a wide character has width 0 and no text of its own.
        if (cell.getWidth() > 0) lit += cell.isDim() ? " " : cell.getChars() || " ";
      }
      rows.push({ text: line.translateToString(true), spans, undimmed: lit.trimEnd() });
    }
    return rows;
  });
}
