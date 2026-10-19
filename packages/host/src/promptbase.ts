/**
 * The pieces of `prompt.ts` that the nav-to-Submit walk and the box merge
 * (`promptnav.ts`, `promptmerge.ts`) share with the detector. Split out so the
 * three files form no import cycle; `prompt.ts` re-exports what was public.
 */
// Strip ANSI/CSI escape sequences and carriage returns. The last two alternatives
// matter more than they look: the claude TUI emits charset designators (ESC ( B)
// and single-char escapes constantly, and a strip that only knows CSI leaves the
// "(B" tail behind as literal text — which is exactly how garbage like
// "My recommendation(B" ended up rendered as a one-tap option label.
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[PX^_].*?\x1b\\|\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b[()*+][A-Za-z0-9]|\x1b[=>78MDEHcZ]|\r/g;

/** Strip ANSI/CSI escapes + CRs — shared by prompt and usage-limit detection. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}


/**
 * An option row, with an optional ONE-CHARACTER marker in front of the index.
 * The marker is deliberately not an allow-list of cursor glyphs: whatever draws
 * it (the "\u276f" cursor, a bullet, or a substitution artefact from a terminal
 * that mangled the glyph) sits in that column, and a marker we don't recognise
 * used to make the row stop parsing ENTIRELY — so option 1 vanished, the run
 * read "first index is not 1", and a real choice box published nothing at all.
 * Only "\u276f" ever counts as PROOF of a cursor; the rest just parses.
 */
export const OPTION_RE = /^\s*(?:(\S)\s+)?(\d+)\.\s+(.+?)\s*$/;
/**
 * Options a published box may carry, whatever the screen and the log between
 * them produce.
 *
 * The strict parse caps its own run at 8 (below). Two things can legitimately
 * exceed that afterwards — `askbox.ts` recovering a tall box's scrolled-off head
 * (its own cap is 12 of the tool's options, and the TUI draws two rows of its
 * own after them), and `mergeBox` keeping an index a later repaint no longer
 * shows — so the union needs a bound of its own or a wire message has none.
 * 14 is the widest box those two rules can honestly produce.
 */
export const MAX_BOX_OPTIONS = 14;
/** What a box whose question row has scrolled off the top is published with.
 *  Named because `sameBox` has to tell "nobody read the question" from "the
 *  question is this". */
export const PLACEHOLDER_QUESTION = "Claude is waiting for a choice";
