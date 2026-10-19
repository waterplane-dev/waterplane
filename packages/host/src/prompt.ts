/**
 * Heuristic detector for Claude Code's interactive choice prompts, so the
 * phone can show one-tap Yes/No buttons and fire a push notification instead
 * of leaving the session silently blocked.
 *
 * It works on the cleaned (ANSI-stripped) tail of the PTY scrollback. Claude
 * renders numbered options ("1. Yes" / "2. No") with a "❯" cursor and a
 * "Enter to confirm · Esc to cancel" footer. We look for ≥2 consecutive
 * numbered options near the end of the buffer.
 */
import type { DetectedPrompt, PromptOption } from "@waterplane/shared";
// The composer's own full-width rules, above and below its input row. Shared
// with `echo.ts`, which anchors the delivery echo on the same box — the
// CONSTANT only, and deliberately not the input row: the one below accepts a
// plain `>` because a shell stub's prompt is a composer for the purpose of
// retiring a box, and `echo.ts` explains at length why that is exactly wrong
// when the question is "is the user's text sitting in the box right now".
import { COMPOSER_RULE_RE } from "./echo.js";

import { stripAnsi, OPTION_RE, MAX_BOX_OPTIONS, PLACEHOLDER_QUESTION } from "./promptbase.js";
export { stripAnsi, MAX_BOX_OPTIONS, PLACEHOLDER_QUESTION };
export { navToSubmit } from "./promptnav.js";
export type { SubmitNav } from "./promptnav.js";
export { sameBox, samePrompt, mergeBox } from "./promptmerge.js";

const clean = stripAnsi;

/**
 * A panel drawn to the RIGHT of the options — the preview pane the newer
 * question box renders beside its choices — occupies the same ROWS, so an
 * option's label runs straight into that panel's border and its contents. Cut
 * at the column gap before the first box-drawing character: a real label never
 * contains one after two spaces, and without this the one-tap buttons read
 * "New Files sheet     \u250c\u2500\u2500\u2500\u2510".
 */
const SIDE_PANEL_RE = /\s{2,}[\u2500-\u257f].*$/;
/** Multi-select rows carry a checkbox, "1. [ ] Prose"; TICKED is "[✔]" (U+2714, 2.1.301), published as `checked`. */
const CHECKBOX_RE = /^\[( |x|X|\u2713|\u2714)\]\s*/;
/** Real option labels are short. Anything longer is prose that happens to be numbered. */
const MAX_LABEL = 160;
/** Rows scanned upward from the tail. A multi-select box with a description line
 *  per option plus a wrapped question is far taller than a Yes/No box. */
const WINDOW = 80;
/**
 * Non-option rows tolerated BETWEEN two numbered options. The tool-approval box
 * has none; AskUserQuestion puts a (wrapped) description under every option, so
 * demanding a contiguous run found only the last two rows, read "first index is
 * not 1" and published nothing — the whole box was invisible to the phone.
 * Bounded so an unrelated numbered line far above can't be glued onto a run.
 */
const GAP_MAX = 8;
/** Rows above option 1 joined back into the question (it wraps). */
const QUESTION_LINES = 4;
const QUESTION_MAX = 300;

const FOOTER_RE = /enter to (confirm|select)|esc to (cancel|exit|interrupt)/i;
/**
 * The footer of an interactive DIALOG specifically — "esc to interrupt" (the
 * TUI's working line, printed by every busy session) is excluded on purpose, so
 * this stays a cheap "something is asking you something" test.
 */
export const DIALOG_FOOTER_RE = /enter to (confirm|select)|esc to cancel/i;
/**
 * The same footer with every space removed. Not paranoia: the TUI repaints a row
 * by ERASING a cell and stepping over it (`ESC[1X ESC[C`) rather than writing the
 * space back, so an ANSI-stripped BYTE window of a live dialog reads
 * "Entertoselect". The cheap pre-gate runs on exactly such a window, and matching
 * only the spaced form meant a real choice box never bought the render that would
 * have published it — no approve bar, no push, nothing.
 */
const DIALOG_FOOTER_COMPACT_RE = /enterto(confirm|select)|esctocancel/i;

/**
 * The rows the CLI draws only when it is accepting TYPING again — its composer.
 *
 * The detector scans upward and had no bottom anchor at all, which was fine
 * while the reasoning was "an alt screen is repainted, so what is on it is what
 * is up". This CLI does not use an alt screen: it scrolls, and the strict pass
 * reads the last 60 rendered LINES — so a box answered thirty seconds ago is
 * still in that window, still carries its cursor and its footer, and was
 * re-detected on every check until the conversation pushed it out. That is a
 * published approve bar for a question nobody is being asked, an
 * `awaitingInput` interlock holding everything queued for the session, and — the
 * report this came from — a panel over a live console. "Only the strict
 * verifier clears it" clears nothing while the strict verifier keeps finding
 * the corpse.
 *
 * Ground truth, three real captures off claude v2.1.236 (the workspace-trust
 * box, a Bash permission box, the resume-from-summary box): while a dialog is
 * open the CLI draws NO composer — the footer is the last non-blank row. Once
 * the box is answered the composer comes back under it. So "is a composer drawn
 * below this box" is the same question as "has this box been answered", asked of
 * something structural rather than of a row count: the count was tried first and
 * a shell stub that echoes a shell prompt per Return sat in exactly the same
 * range as a real composer.
 *
 * Failure direction is deliberate. A composer we do not recognise (upstream
 * redraws it) reads as "no composer", i.e. the old behaviour — a box that
 * lingers. The opposite mistake would retire a LIVE box and take the approve bar
 * with it, and that is the one this file must never make.
 */
/** The status line under it: the mode, and the shortcuts hint. */
const COMPOSER_HINT_RE = /shift\+tab to cycle|\? for shortcuts|for shortcuts$/i;
/** Its input row — "\u276f " with something that is not a numbered option after it. */
const COMPOSER_INPUT_RE = /^[\u276f>]\s/;

/** Is this rendered row part of the CLI's composer? */
function isComposerRow(raw: string): boolean {
  const line = raw.trim();
  if (!line) return false;
  if (COMPOSER_RULE_RE.test(line)) return true;
  if (COMPOSER_HINT_RE.test(line)) return true;
  const bare = line.replace(/^[\u2502\u2503|]\s*/, "").replace(/[\u2502\u2503|]\s*$/, "").trim();
  return COMPOSER_INPUT_RE.test(bare) && !OPTION_RE.test(bare);
}

/** Does this text carry an interactive dialog's footer? Tolerates a repaint that
 *  swallowed the spaces (see `DIALOG_FOOTER_COMPACT_RE`). */
export function hasDialogFooter(text: string): boolean {
  return DIALOG_FOOTER_RE.test(text) || DIALOG_FOOTER_COMPACT_RE.test(text.replace(/\s+/g, ""));
}

/**
 * The same question asked of a RENDERED screen: is a dialog still up, or has
 * the CLI moved on past it?
 *
 * `hasDialogFooter` is the right rule for a byte window, which has no bottom to
 * speak of. A screen has one, and without it the interlock read an answered box
 * — still sitting in the last 60 rendered lines with the conversation drawn
 * under it — as a session parked on a question: silent, "waiting", and holding
 * everything queued for it. Deliberately as loose as `hasDialogFooter` about
 * WHAT the row says (this is the interlock, and a false wait is the cheap
 * error); all that is added is whether the CLI has since started taking typing
 * again. See `isComposerRow`.
 */
export function dialogStillUp(screen: string): boolean {
  const lines = clean(screen).split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    if (hasDialogFooter(line)) return true;
    if (isComposerRow(lines[i])) return false;  // the CLI takes typing again: that box is answered
  }
  return false;
}

// ── Was there actually a box, or only words that read like one? ────────────
/**
 * `hasDialogFooter` asks a deliberately cheap question — "is anything possibly
 * asking you something?" — and it is the right rule for the SAFETY INTERLOCK
 * that sits on it: a session parked on a dialog must not be typed into, a false
 * wait costs a queue a few seconds, and a false clear types a prompt into a
 * question box. Loose is correct there.
 *
 * It is the wrong rule for a CLAIM ABOUT THE DETECTOR, and the two got joined.
 * A claude session displaying our OWN prose about this file — an agent editing
 * `prompt.ts`, a reader view of `CLAUDE.md`, a code review of `e2e-prompt.mjs` —
 * puts the words "Esc to cancel" on the screen inside a sentence. The cheap gate
 * fires, the strict pass then correctly refuses to parse a paragraph as a choice
 * box, and the app recorded that CORRECT REFUSAL as a miss against the
 * choice-box detector. Four of nine on the live host, reported to the user as a
 * detector failing 44% of the time while it was in fact working perfectly. A
 * health signal that cries wolf is worse than no signal: the board it sits on
 * gets ignored, and then the real break goes unread too.
 *
 * This is the same hazard as the standing repo rule that keeps usage-limit
 * banner phrases out of strings and comments, one layer up: there, printing the
 * phrase makes the app act; here, printing it makes the app REPORT. And there is
 * no reliable way to tell a session rendering our source from one that is not —
 * it is the same terminal, the same bytes, and an agent's own reasoning about
 * TUI chrome is indistinguishable from TUI chrome by construction. So the answer
 * cannot be "detect the self-reference"; it has to be evidence that a box is
 * really there.
 *
 * Which is what this returns. Two independent things, both of which a paragraph
 * lacks:
 *
 *   • the footer drawn as its OWN ROW — a row made of key hints and nothing
 *     else, which is a thing the TUI paints and not a thing a sentence contains;
 *   • something above it to choose from — the "❯" selection cursor, or numbered
 *     option rows.
 *
 * Requiring both means a box whose rows AND cursor have all become unreadable
 * at once records nothing rather than a miss, and that trade is taken
 * deliberately: a detector that has gone completely blind stops recording
 * `good`s too, and `clihealth.ts` keeps `unknown` as a state distinct from
 * `healthy` precisely so that silence is legible. Under-reporting degrades to
 * "I cannot say"; over-reporting degrades to a chip nobody taps.
 */

/** Separators the TUI puts between key hints — and the two-space gap it uses
 *  when it draws none. */
const HINT_SPLIT_RE = /\s*[·•|,;]\s*|\s{2,}/;
/**
 * One key hint, ANCHORED AT BOTH ENDS: a key, at most a word or two of noun
 * ("Tab/Arrow keys"), the word "to", and a one- or two-word verb.
 *
 * The anchors are the whole point. "Esc to cancel" as a segment of its own is a
 * footer; "…the login screen's Esc to cancel footer already…" is a sentence
 * that contains one, and only an anchored match can tell them apart. The verb
 * tail is capped at two words for the same reason — "cancel footer already"
 * is three.
 */
const KEY_HINT_RE = /^\S{1,20}(?:\s+\S{1,15}){0,2}\s+to\s+[a-z]+(?:\s+[a-z]+)?$/i;
/** A row that is nothing but the "❯" selection cursor and what it points at. */
const CURSOR_ROW_RE = /^❯(?:\s|$)/;
/** Rows above the footer that still belong to the same box. Same reasoning as
 *  `NAV_SPAN`: a checkbox box with a wrapped description under every option is
 *  tall, and anything further up is the conversation. */
const BOX_ROWS = 40;
/** A footer row is chrome, so it is short. Prose that survives the anchors by
 *  accident usually does not. */
const FOOTER_ROW_MAX = 120;

/** Strip the box-drawing frame the way the detector's own scan does, so a
 *  footer inside a bordered panel reads the same as a bare one. */
function unframe(line: string): string {
  return line.replace(/^[│┃|╮╯╰╭─\s]+/, "").replace(/[│┃|─\s]+$/, "").trim();
}

/**
 * Is this line the dialog's footer ROW — i.e. made of key hints, one of which
 * is a dialog hint — rather than a paragraph containing the words?
 */
export function isDialogFooterRow(rawLine: string): boolean {
  const line = unframe(rawLine);
  if (!line || line.length > FOOTER_ROW_MAX) return false;
  // The repaint-swallowed-spaces form has no segments to split; it is only ever
  // seen on a BYTE window (the render puts real spaces in real cells), but a
  // short row that says nothing else is a footer either way.
  if (!DIALOG_FOOTER_RE.test(line)) {
    return line.length <= 40 && DIALOG_FOOTER_COMPACT_RE.test(line.replace(/\s+/g, ""));
  }
  const segments = line.split(HINT_SPLIT_RE).map((s) => s.trim()).filter(Boolean);
  // Every segment must be a hint, and the dialog phrase must live inside one of
  // them WHOLE. One prose clause on the row is enough to make it a sentence.
  return segments.length > 0
    && segments.every((s) => KEY_HINT_RE.test(s))
    && segments.some((s) => DIALOG_FOOTER_RE.test(s));
}

export interface DialogEvidence {
  /** The footer, drawn as its own row. */
  footerRow: boolean;
  /** The "❯" selection cursor, on a row belonging to that box. */
  cursor: boolean;
  /** Numbered option rows belonging to it. */
  options: number;
  /**
   * The composer's own STATUS LINE inside that span — so what is up is the CLI's
   * own inline picker (a slash command's menu, `/effort`, `/model`), not a
   * question the agent asked.
   *
   * The second false alarm on the live host, and the same shape as the first:
   * `/effort` draws a real footer row ("Enter to select · ↑/↓ to navigate · Esc
   * to cancel") with a "❯" on the highlighted row and NO numbered options,
   * because it has none. Footer plus cursor is the evidence rule, so every trip
   * to that menu filed a miss against a detector that had nothing of its shape
   * to parse. Seven all-time, permanently amber, which is how a board teaches
   * the person reading it to stop reading it.
   *
   * Only the status line counts, deliberately. The "❯" INPUT row cannot be used:
   * a box whose options renumbered upstream (`1)` for `1.`) leaves "❯ 1) Yes",
   * which fails `OPTION_RE` and reads exactly like a composer — and that is the
   * one miss this signal exists to record. A modal box never draws the mode
   * line, being the last thing on screen.
   */
  composer: boolean;
  /** A footer row AND something above it to choose from AND no composer under
   *  it: a box is really up, so a strict parse that came back empty is a MISS
   *  and not a refusal. */
  box: boolean;
}

/** What the rendered screen says about whether a dialog is actually open. */
export function dialogEvidence(screen: string): DialogEvidence {
  const lines = clean(screen).split("\n");
  let footer = -1;
  for (let i = lines.length - 1; i >= 0; i--) if (isDialogFooterRow(lines[i])) { footer = i; break; }
  if (footer < 0) return { footerRow: false, cursor: false, options: 0, composer: false, box: false };
  let cursor = false;
  let options = 0;
  let composer = false;
  for (let i = Math.max(0, footer - BOX_ROWS); i < footer; i++) {
    const line = unframe(lines[i]);
    if (!line) continue;
    if (COMPOSER_HINT_RE.test(line)) composer = true;
    if (CURSOR_ROW_RE.test(line)) cursor = true;
    const m = OPTION_RE.exec(line);
    if (m) {
      options++;
      if (m[1] === "❯") cursor = true;
    }
  }
  return { footerRow: true, cursor, options, composer, box: !composer && (cursor || options > 0) };
}

export interface DetectOpts {
  /**
   * Cheap-stage mode: the caller only wants to know whether it's worth paying
   * for a VT render, so the two pieces of evidence a repaint-shuffled byte
   * window is most likely to have LOST are not required — the "❯" selection
   * cursor and the "Enter to confirm · Esc to cancel" footer both live on their
   * own rows, and a repaint can leave them outside any given byte window while
   * the option rows sit inside it. Requiring them in the cheap stage turns a
   * real prompt into no candidate at all, i.e. no approve bar and no push.
   *
   * Structural sanity (>=2 options, indices 1..N, short labels) still applies —
   * it costs nothing and keeps prose from triggering constant renders. The
   * strict pass over the RENDERED screen is what actually gets published, so a
   * lenient candidate can never surface as a phantom prompt.
   */
  lenient?: boolean;
}

// ── A box with NO NUMBERS: claude 2.1.293's first-launch trust box ─────────
/**
 * Measured on the binary (2026-10-08, `fixtures/permmode/trust-box.txt`):
 * claude 2.1.293 draws its workspace-trust box UNNUMBERED \u2014
 *
 *     \u276f No, exit
 *       Yes, I trust this folder
 *
 *     Enter to confirm \u00b7 Esc to cancel
 *
 * with the cursor starting on "No, exit". Every rule above wants a run of
 * `N.` rows, so the box parsed as nothing: the very first session a new user
 * opens published `awaitingInput` and no buttons, and the only way past it was
 * the arrow keys.
 *
 * Read by SHAPE, never by its words, and anchored hard \u2014 a looser rule here is
 * a phantom box over ordinary output:
 *   \u2022 the dialog FOOTER, as its own row (`isDialogFooterRow`), is the LAST
 *     non-blank row of the screen \u2014 a composer under it means the box was
 *     answered, exactly as `isComposerRow` argues for the numbered box;
 *   \u2022 directly above it (blanks only between), a contiguous run of 2..8 rows
 *     whose labels all start in ONE column, exactly one of them carrying the
 *     "\u276f" cursor two cells to the left of that column and the rest indented to
 *     it with spaces;
 *   \u2022 nothing numbered and no checkbox in the run (those boxes are the
 *     numbered rules' business), and the run bounded above by a blank row or a
 *     row LESS indented than the cursor (the question). Anything else in that
 *     slot \u2014 a wrapped label, a deeper row \u2014 is a shape not measured, so null.
 *
 * Strict pass only. The lenient gate never needs it: this box's footer is a
 * dialog footer, which already buys the render (`hasDialogFooter`).
 *
 * `cursor` is the 1-based index the "\u276f" sits on. It stays OUT of the published
 * box on purpose: it moves with every arrow, and the box's fields are its
 * identity (`samePrompt`, `promptFingerprint`) \u2014 a cursor in there would
 * re-publish the box per keystroke. The answer walk asks for it here instead
 * (`readNavBox`, `sessions/boxes.ts`).
 */
const NAV_MAX_ROWS = 8;
/** Blank rows tolerated between the option run and the footer. */
const NAV_FOOTER_GAP = 2;
/** Paragraphs above the run searched for the question. */
const NAV_QUESTION_PARAS = 4;
const NAV_QUESTION_ROWS = 16;
/** A label that begins like a numbered or checkbox row belongs to the numbered rules. */
const NAV_NUMBERED_RE = /^(?:\d+[.)]|\[[ xX\u2713\u2714]\])(?:\s|$)/;

export interface NavBoxRead {
  prompt: DetectedPrompt;
  /** 1-based index of the option the "\u276f" cursor is on. */
  cursor: number;
}

function navBoxOf(lines: string[]): NavBoxRead | null {
  let f = lines.length - 1;
  while (f >= 0 && !lines[f].trim()) f--;
  if (f < 0 || !isDialogFooterRow(lines[f])) return null;
  let i = f - 1;
  for (let gap = 0; i >= 0 && !lines[i].trim(); i--) if (++gap > NAV_FOOTER_GAP) return null;
  const rows: { label: string; cursor: boolean }[] = [];
  let labelCol = -1;
  for (; i >= 0; i--) {
    const line = lines[i];
    if (!line.trim()) break;
    const lead = line.length - line.trimStart().length;
    const body = line.slice(lead);
    const isCursor = /^\u276f\s/.test(body);
    const col = isCursor ? lead + 2 : lead;
    if (labelCol < 0) labelCol = col;
    else if (col !== labelCol) {
      // Less indented than where the cursor sits: the question, above the run.
      if (!isCursor && lead < labelCol - 2) break;
      return null;
    }
    if (isCursor && body[1] !== " ") return null; // "\u276f" then exactly one space to the label column
    const label = (isCursor ? body.slice(2) : body).trim();
    if (!label || label.length > MAX_LABEL) return null;
    if (/^[\u2500-\u257f]/.test(label) || NAV_NUMBERED_RE.test(label) || /^\u276f/.test(label)) return null;
    if (COMPOSER_HINT_RE.test(label) || COMPOSER_RULE_RE.test(line.trim())) return null;
    rows.unshift({ label: label.replace(SIDE_PANEL_RE, "").trim(), cursor: isCursor });
    if (rows.length > NAV_MAX_ROWS) return null;
  }
  if (rows.length < 2) return null;
  const cursors = rows.filter((r) => r.cursor).length;
  if (cursors !== 1) return null;
  if (labelCol < 2) return null; // the cursor needs its two cells to the left

  // The question: the nearest paragraph above that asks one, else the nearest.
  const paras: string[] = [];
  let para: string[] = [];
  for (let n = 0; i >= 0 && n < NAV_QUESTION_ROWS && paras.length < NAV_QUESTION_PARAS; i--, n++) {
    const t = lines[i].replace(/^[\u2502\u2503|\u256e\u256f\u2570\u256d\u2500\s]+/, "").trim();
    if (/^[\u2500-\u257f]+$/.test(t)) break; // the box's own top rule
    if (!t) { if (para.length) { paras.push(para.join(" ")); para = []; } continue; }
    para.unshift(t);
  }
  if (para.length && paras.length < NAV_QUESTION_PARAS) paras.push(para.join(" "));
  const question = (paras.find((p) => p.includes("?")) ?? paras[0] ?? "").replace(/\s+/g, " ").trim().slice(0, QUESTION_MAX);
  const options = rows.map((r, k) => ({ index: k + 1, label: r.label }));
  return {
    prompt: { kind: kindOf(question, options), question: question || PLACEHOLDER_QUESTION, options, nav: true },
    cursor: rows.findIndex((r) => r.cursor) + 1,
  };
}

/** An unnumbered box on a RENDERED screen, with where its cursor is \u2014 or null. */
export function readNavBox(screen: string): NavBoxRead | null {
  return navBoxOf(clean(screen).split("\n").map((l) => l.replace(/[\u2502\u2503|]\s*$/, "").trimEnd()));
}

/**
 * The keys that answer claude's folder-trust box with YES — the usage probe's
 * (`usage.ts`) and a delivery's into a never-trusted dir (`deliver/deliverrun.ts`).
 *
 * Before 2.1.293 the box is numbered, `1. Yes, proceed` first, so `1⏎`. Since, it is UNNUMBERED
 * with the cursor on `No, exit` (`readNavBox`): a digit types nothing and the Return chose "No,
 * exit" — claude quit at once. So: walk the cursor to the option that says yes, then Return. A
 * nav box with no such option gets NO key, never a Return at an unknown choice.
 */
export function trustKeys(nav: NavBoxRead | null): string {
  if (!nav) return "1\r";
  const yes = nav.prompt.options.find((o) => /^yes\b/i.test(o.label.trim()));
  if (!yes) return "";
  const d = yes.index - nav.cursor;
  return (d > 0 ? "\x1b[B".repeat(d) : "\x1b[A".repeat(-d)) + "\r";
}

function kindOf(question: string, options: PromptOption[]): DetectedPrompt["kind"] {
  const blob = (question + " " + options.map((o) => o.label).join(" ")).toLowerCase();
  if (/trust|created or one you/.test(blob)) return "trust";
  if (/proceed|want to (make|run|create|edit|allow)|don't ask again|approve/.test(blob)) return "tool";
  if (/plan|ready to code|proceed with/.test(blob)) return "plan";
  return "select";
}

export function detectPrompt(rawTail: string, opts: DetectOpts = {}): DetectedPrompt | null {
  const text = clean(rawTail);
  const lines = text.split("\n").map((l) => l.replace(/[\u2502\u2503|]\s*$/, "").trimEnd());

  // Asked first: it is anchored on the footer being the screen's last row, so
  // a numbered box answered long ago further up cannot be read in its place.
  if (!opts.lenient) {
    const nav = navBoxOf(lines);
    if (nav) return nav.prompt;
  }

  // Scan from the bottom: collect a run of numbered options, newest-first. The
  // run may be interrupted by each option's own description rows (multi-select),
  // so a non-option row is a GAP, not the end of the box.
  const options: PromptOption[] = [];
  const questionParts: string[] = [];
  let footerSeen = false;
  /** The DIALOG footer specifically. `FOOTER_RE` also matches "esc to interrupt"
   *  \u2014 the TUI's working line, printed by every busy session \u2014 which is fine as
   *  weak evidence but is NOT proof a box is open. */
  let dialogFooterSeen = false;
  let cursorSeen = false;
  let multi = false;
  let gap = 0;
  /** A composer row walked past below the box — see `isComposerRow`. */
  let composerBelow = false;
  let boxSeen = false;

  for (let i = lines.length - 1; i >= 0 && i > lines.length - WINDOW; i--) {
    // Asked BEFORE the blank test: the composer's own rules unframe to nothing,
    // and a row read as blank would never be seen at all.
    if (!boxSeen && !options.length && isComposerRow(lines[i])) { composerBelow = true; continue; }
    const line = lines[i].replace(/^[\u2502\u2503|\u256e\u256f\u2570\u256d\u2500\s]+/, "").replace(/[\u2502\u2503|]+$/, "").trim();
    // A row of nothing but box-drawing glyphs is a rule, never words. v2.1.293
    // frames a Bash box's command in dashed rules ("\u254c\u254c\u254c"), which survived the
    // strip above, filled the question past QUESTION_MAX and cut off the
    // "Do you want to proceed?" that makes it a `tool` box. Skipped, not blank:
    // the question continues above it.
    if (/^[\u2500-\u257f]+$/.test(line)) continue;
    if (!line) {
      // A blank row ends the question: above it is the conversation, not the box.
      if (options[0]?.index === 1 && questionParts.length) break;
      continue;
    }
    if (FOOTER_RE.test(line)) {
      footerSeen = true;
      boxSeen = true;
      if (DIALOG_FOOTER_RE.test(line)) dialogFooterSeen = true;
      continue;
    }

    const m = OPTION_RE.exec(lines[i].trim()) || OPTION_RE.exec(line);
    const idx = m ? Number(m[2]) : 0;
    // Indices must descend by exactly one as we walk up, so a stray "2." inside a
    // description can't extend the run.
    if (m && (!options.length || idx === options[0].index - 1)) {
      // Only "\u276f" proves a selection cursor. ">" still PARSES (an ASCII-cursor
      // box must keep detecting) but never counts as proof: a markdown blockquoted
      // list in the assistant's prose ("> 1. first") is exactly that shape.
      if (m[1] === "\u276f") cursorSeen = true;
      let label = m[3].replace(SIDE_PANEL_RE, "").trim();
      const box = CHECKBOX_RE.exec(label);
      if (box) { multi = true; label = label.slice(box[0].length).trim(); }
      options.unshift(box ? { index: idx, label, checked: box[1] !== " " } : { index: idx, label });
      gap = 0;
      boxSeen = true;
      continue;
    }
    if (!options.length) continue;            // still below the box (conversation, tabs, …)
    if (options[0].index === 1) {             // above the box: this is the question, wrapped
      questionParts.unshift(line);
      if (questionParts.length >= QUESTION_LINES) break;
      continue;
    }
    if (++gap > GAP_MAX) break;               // too far from the next option — run is broken
  }

  if (options.length < 2) return null;
  // The CLI is taking typing again below this box: it was answered, and
  // re-publishing it is a question nobody is being asked. See `isComposerRow`.
  if (!opts.lenient && composerBelow) return null;
  // A real choice box always carries a selection cursor ("\u276f 1. Yes") or the
  // "Enter to confirm \u00b7 Esc to cancel" footer. Without either, a numbered list
  // in the assistant's own prose ("1. Now: \u2026 2. Then: \u2026 3. \u2026") reads as a prompt
  // \u2014 which is what made phantom approve-bars flicker in and out mid-answer.
  if (!opts.lenient && !footerSeen && !cursorSeen) return null;
  /**
   * The run may start ABOVE 1 \u2014 a box with six options and a wrapped description
   * each is TALLER than a phone's terminal, so the CLI scrolls its own top away
   * and option 1 is simply not on screen.
   *
   * Requiring index 1 there was not a missing feature, it was an oscillator: the
   * strict pass published null, the approve panel unmounted, the terminal grew
   * back the ~200 px the panel had taken, the PTY was resized, claude repainted
   * a box that now FIT \u2014 and the panel came back. About once a second, exactly
   * the "renders and hides" the phone shows.
   *
   * Dropping the anchor is only safe with real evidence of a dialog, so it is
   * conditioned on the strict pass: the LENIENT gate has neither footer nor
   * cursor to lean on and keeps index 1 as its one defence against prose that
   * happens to be numbered. What is published is what is legible \u2014 the indices
   * are still exactly what a keystroke means, and `truncated` says the top is
   * missing rather than pretending the box starts here.
   */
  const first = options[0].index;
  if (first < 1) return null;
  /**
   * Dropping the index-1 anchor needs PROOF of a box, not merely evidence: the
   * assistant's own prose can be a numbered list, and a busy session prints
   * "esc to interrupt" on its working line the whole time \u2014 so `footerSeen`
   * alone would read "2. \u2026 3. \u2026" mid-answer as a truncated dialog. The
   * dialog footer or the "\u276f" cursor is the evidence that a real box is open,
   * and the lenient gate (which has neither by design) keeps the anchor.
   */
  if (first !== 1 && (opts.lenient || !(dialogFooterSeen || cursorSeen))) return null;
  if (options.some((o) => !o.label || o.label.length > MAX_LABEL)) return null;
  if (options.some((o, i) => o.index !== first + i)) return null;

  const questionLine = questionParts.join(" ").replace(/\s+/g, " ").trim().slice(0, QUESTION_MAX);
  const kind = kindOf(questionLine, options);

  return {
    kind,
    question: questionLine || PLACEHOLDER_QUESTION,
    // Sliced from the FRONT: on a truncated box the rows that survived are the
    // ones nearest the footer, and dropping them would leave the cap holding
    // options the user cannot see either.
    options: options.slice(0, 8),
    ...(multi ? { multi: true } : {}),
    ...(first > 1 ? { truncated: true } : {}),
  };
}
