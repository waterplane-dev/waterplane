/** The nav-to-Submit walk for checkbox boxes; re-exported by `prompt.ts`. */
// ── Placing the cursor on a checkbox box's Submit row ──────────────────────
import { OPTION_RE, stripAnsi } from "./promptbase.js";

const clean = stripAnsi;

/**
 * The COMMIT row of a multi-select box. It carries no index — the numbered rows
 * are the checkboxes plus the TUI's own trailing actions — so it is matched on
 * the word alone, with the same optional one-character marker in front that an
 * option row tolerates ("❯  Submit").
 *
 * **The word is not always "Submit".** Read off the installed binary (claude
 * 2.1.267): the multi-select list is handed
 * `submitButtonText: <on the last question> ? "Submit" : "Next"`, so an
 * `AskUserQuestion` carrying SEVERAL questions draws "Next" on every question
 * but the last. Matching "Submit" alone therefore found no commit row at all on
 * exactly those boxes — `navToSubmit` returned null, `submitPromptBox` fell back
 * to a bare Return, and a bare Return on a checkbox box re-toggles whatever row
 * the cursor is sitting on and leaves the box open. That is the health board's
 * "Placing the cursor on a multi-select Submit row" going red.
 *
 * The two words are kept APART in what is published (`SubmitNav.label`): Return
 * on "Next" moves to the next question rather than answering, and a button that
 * says Submit while the TUI says Next is a claim about what a tap will do.
 *
 * The marker slot is the CURSOR GLYPH only, unlike `OPTION_RE`'s deliberately
 * permissive one. There the loose slot is a defence — an unrecognised marker
 * used to cost the whole option row. Here it is the opposite: the row is two
 * common words, so `- Next` or `# Next` in the agent's own prose inside the
 * scan window would read as a commit row. "Newest box wins" hides that while
 * the real row is on screen; restricting the slot means it cannot be the
 * target when the real row has scrolled off either. An unrecognised cursor
 * glyph costs the walk, which falls back to the bare Return it always did.
 */
const SUBMIT_ROW_RE = /^(?:(❯)\s+)?(Submit|Next)$/;
/** Screen rows scanned upward. Same reasoning as WINDOW: a checkbox box with a
 *  description under every option is tall. */
const NAV_WINDOW = 80;
/** How far a navigable row may sit from the Submit row and still count as part
 *  of the same box — an older box scrolled above must not join the run. */
const NAV_SPAN = 40;

export interface SubmitNav {
  /**
   * Selectable ROWS between the cursor and the Submit row: positive means press
   * Down that many times, negative Up, 0 means the cursor is already there.
   *
   * Rows, not screen lines — every option draws a wrapped description under its
   * label, and the arrow keys step over those.
   */
  steps: number;
  /** The word the TUI drew on that row — `Submit` or `Next`. See
   *  `SUBMIT_ROW_RE`: they are different acts and the phone says which. */
  label: "Submit" | "Next";
}

/**
 * Where the selection cursor is, relative to the box's Submit row.
 *
 * A checkbox box is answered by TOGGLING rows and then pressing Return **on the
 * Submit row** — Return anywhere else toggles whatever the cursor is sitting on.
 * The phone's Submit button used to send a bare Return, which therefore did the
 * one thing it must never do: it re-toggled option 1 (where the cursor starts)
 * and left the box open. The keystroke only means "submit" once the cursor has
 * been walked there, which is what this measures.
 *
 * Returns null when the screen does not show BOTH a Submit row and a cursor —
 * a box taller than the terminal can have scrolled either off, and guessing a
 * direction there would toggle a row nobody chose. The caller falls back to the
 * bare Return, i.e. to what it did before.
 */
export function navToSubmit(screen: string): SubmitNav | null {
  const lines = clean(screen)
    .split("\n")
    .map((l) => l.replace(/^[│┃|╮╯╰╭─\s]+/, "").replace(/[│┃|]+$/, "").trim());
  const rows: { line: number; cursor: boolean; submit: boolean; label?: "Submit" | "Next" }[] = [];
  for (let i = Math.max(0, lines.length - NAV_WINDOW); i < lines.length; i++) {
    const sub = SUBMIT_ROW_RE.exec(lines[i]);
    if (sub) { rows.push({ line: i, cursor: sub[1] === "❯", submit: true, label: sub[2] as "Submit" | "Next" }); continue; }
    const m = OPTION_RE.exec(lines[i]);
    // Only rows the arrows can land on. A description line that happens to start
    // with a number is filtered by the same shape test the detector uses.
    if (m) rows.push({ line: i, cursor: m[1] === "❯", submit: false });
  }
  // Newest box wins, and only its own rows count.
  let sIdx = -1;
  for (let i = rows.length - 1; i >= 0; i--) if (rows[i].submit) { sIdx = i; break; }
  if (sIdx < 0) return null;
  const near = rows.filter((r) => Math.abs(r.line - rows[sIdx].line) <= NAV_SPAN);
  const s = near.indexOf(rows[sIdx]);
  // The cursor nearest the Submit row: two boxes in one scrollback would
  // otherwise hand us the older one's marker and a wildly wrong distance.
  let c = -1;
  for (let i = 0; i < near.length; i++) {
    if (!near[i].cursor) continue;
    if (c < 0 || Math.abs(i - s) < Math.abs(c - s)) c = i;
  }
  if (c < 0) return null;
  return { steps: s - c, label: rows[sIdx].label ?? "Submit" };
}
