// The choice-box detector, pinned against a REAL screen the phone showed nothing for.
//
// A live "Where should the tree browser live?" box sat on screen with two
// options and the host published no prompt at all: no approve bar, no push, no
// badge. Three independent breakages had to line up, and each one is silent on
// its own, so each gets a case here.
//
//   1. The cheap PRE-GATE never fired. It scans an ANSI-stripped BYTE window,
//      and this TUI repaints a row by erasing a cell and stepping over it
//      (ESC[1X ESC[C) instead of writing the space back — so the footer arrives
//      as "Entertoselect" and a spaced regex misses it. No gate, no render, and
//      the render is where detection actually happens.
//   2. The option rows carry a ONE-CHARACTER marker before the index. Anything
//      but the cursor glyph made the row fail to parse outright, so option 1
//      disappeared, the run read "first index is not 1", and the box published
//      nothing. A terminal that mangles the cursor must cost us the cursor, not
//      the whole box.
//   3. The newer box draws a PREVIEW PANE to the right of the options, on the
//      same rows — so labels ran into its border and the one-tap buttons read
//      "New Files sheet     [box drawing]".
import { detectPrompt, hasDialogFooter, stripAnsi } from "../packages/host/dist/prompt.js";

const CURSOR = "❯";
const H = "─";
let failed = false;
const check = (cond, label) => { console.log(`${cond ? "PASS" : "FAIL"}: ${label}`); if (!cond) failed = true; };

// -- 1. The pre-gate, on a window the repaint stripped the spaces out of --
check(hasDialogFooter("Enter to select · Esc to cancel"), "a spaced footer is a dialog footer");
check(hasDialogFooter("Entertoselect·ntoaddnotes·Esctocancel"),
  "...and so is one whose spaces the repaint swallowed");
check(hasDialogFooter(stripAnsi("Enter[1X[Cto[1X[Cselect")),
  "...which is exactly what erase-cell + cursor-forward leaves behind");
check(!hasDialogFooter("esc to interrupt"),
  "the working line is still NOT a dialog footer (it would mean a render per check)");

// -- 2 + 3. The box itself, verbatim from the screen that showed nothing --
// Rendered at 80 cols, with every non-ACS glyph flattened to "_" by a terminal
// that did not pass UTF-8 through -- the state the phone was actually in.
const MANGLED = [
  H.repeat(80),
  "_  _ Placement  _ Save model  _ Editor  _ Submit  _",
  "",
  "Where should the tree browser live?",
  "",
  "_ 1. New Files sheet              ┌" + H.repeat(42) + "┐",
  "    (Recommended)                 │ ┌ Files · demo " + H.repeat(5) + " _ ┐        │",
  "  2. New tab in Gallery           │ │ packages / web / src │         │",
  "                                  │ │ " + H.repeat(20) + " │          │",
  "                                  ├" + H.repeat(3) + " _ " + H.repeat(3) + " 4 lines hidden " + H.repeat(4) + "┤",
  "                                  └" + H.repeat(42) + "┘",
  "",
  "                                  Notes: press n to add notes",
  "",
  H.repeat(80),
  "  Chat about this",
  "",
  "Enter to select · _/_ to navigate · n to add notes · Tab to switch questions ·",
  "Esc to cancel",
].join("\n");

const got = detectPrompt(MANGLED);
check(!!got, "a choice box whose cursor glyph was mangled is still a choice box");
check(got?.question === "Where should the tree browser live?", "the question is the wrapped line above option 1");
check(got?.options.length === 2, "both options survive (a marker we don't know must not eat option 1)");
check(got?.options[0].label === "New Files sheet", "option 1's label stops before the preview pane");
check(got?.options[1].label === "New tab in Gallery", "...and so does option 2's, mid-pane");

// The same box with its real glyph -- the cursor is proof, not decoration.
const clean = detectPrompt(MANGLED.replace("_ 1. New Files sheet", CURSOR + " 1. New Files sheet"));
check(clean?.options[0].label === "New Files sheet", "the cursor-glyph box parses identically");

// Guard the direction that made phantom approve-bars flicker: a numbered list in
// the assistant's own prose, with no cursor and no footer, is not a prompt.
const PROSE = ["Here is the plan:", "", "1. First we read the file", "2. Then we edit it", ""].join("\n");
check(detectPrompt(PROSE) === null, "a numbered list in prose is not a prompt");
check(detectPrompt("> 1. quoted\n> 2. list") === null, "...nor is a markdown blockquoted list");

// -- 4. A box TALLER than the terminal: its own top has scrolled off --
//
// Six options with a wrapped description each does not fit a phone's 40 rows,
// so the CLI scrolls the question and the first options away and the screen
// starts mid-box. Requiring index 1 published nothing for such a box, and that
// was not merely a gap: the approve panel takes its height FROM the terminal, so
// null -> panel unmounts -> the terminal grows back -> the PTY is resized ->
// claude repaints a box that now fits -> the panel returns. About once a second,
// which is what "the answer box renders and hides" is.
const TALL = [
  "    them irrelevant.",
  "  3. A + C only",
  "    Cheap: persist recentlyClosed to <state>/closed.json, raise the caps.",
  CURSOR + " 4. Nothing yet",
  "    You wanted to know the state of play, not a build.",
  "  5. Type something.",
  "  6. Chat about this",
  "",
  "Enter to select · ↑/↓ to navigate · Esc to cancel",
].join("\n");
const tall = detectPrompt(TALL);
check(!!tall, "a box whose top scrolled off the screen is still published");
check(tall?.options[0].index === 3, "the run keeps the INDICES it had (they are what a keystroke means)");
check(tall?.options.length === 4, "every legible option is offered");
check(tall?.truncated === true, "...and it says the top is missing rather than pretending to be whole");
check(detectPrompt(TALL, { lenient: true }) === null,
  "the cheap gate keeps the index-1 anchor (it has no footer or cursor to lean on)");

// The direction that anchor was protecting: prose numbered from 2, under a BUSY
// session's working line. "esc to interrupt" is evidence of output, never of a box.
const MIDPROSE = [
  "  2. Then we edit it",
  "  3. Then we run the tests",
  "",
  "esc to interrupt",
].join("\n");
check(detectPrompt(MIDPROSE) === null,
  "prose numbered from 2 under the working line is not a truncated box");
check(detectPrompt(MIDPROSE.replace("esc to interrupt", "Enter to select · Esc to cancel")) !== null,
  "...but the same rows under a real dialog footer are");

process.exit(failed ? 1 : 0);
