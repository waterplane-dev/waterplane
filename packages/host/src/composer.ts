/**
 * WHERE on a rendered screen the composer is, and what it is holding.
 *
 * `echo.ts` is the comparison rule — "is THIS text in that?" — asked of any
 * string. This file finds the string worth asking it of: the box the user is
 * typing into, found STRUCTURALLY by its own rules and cursor row rather than
 * by distance from the bottom of the render, because the replay tears mid-turn
 * and strands the live composer above stale rows (`composerSpans`). Every reader
 * here hands what it found back to `echo.ts`'s `screenEcho`, so a box can only
 * be judged by the same rule a whole screen is.
 *
 * Split out of `echo.ts` by subject when that file reached the 900-line cap:
 * the text rules there take strings, the readers here take rendered rows.
 * Imports go one way — this file imports `echo.ts`, never the reverse.
 */

import { SLICE_MIN, screenEcho, squash, type EchoRule } from "./echo.js";

/**
 * The composer's own full-width rules, above and below its input row.
 *
 * Shared with `prompt.ts` — the CONSTANT, deliberately not the semantics. That
 * file asks "has this dialog been ANSWERED", so its notion of a composer row is
 * and should be loose; this file asks "is this the box the user is typing
 * into", where the same looseness is the bug (see `COMPOSER_CURSOR_RE`).
 */
export const COMPOSER_RULE_RE = /^[\u2500\u2501\u2504\u2505\u2508\u2509]{20,}$/;

/**
 * The composer's input row: `❯` and then whitespace — NBSP included,
 * because that is what the live capture holds (the TUI pads the cursor row with
 * one, and `renderCapture` trims spaces and tabs but not NBSP).
 *
 * `❯` ONLY, never a plain `>`. `prompt.ts`'s row test accepts both and is
 * right to — a shell stub that echoes `> ` is a composer for the purpose of
 * retiring a box. Here that would destroy the whole point: this CLI SCROLLS
 * rather than repainting, and it renders a past user turn into the scrollback
 * as `> yes all 3`, verbatim, for as long as it stays on screen. A `>` row
 * would let a prompt that ran twenty minutes ago read as one sitting unsent in
 * the box — "press Return there", aimed at an empty composer, which is the one
 * mistake this family of rules exists to stop making.
 */
const COMPOSER_CURSOR_RE = /^\u276f(?:[\s\u00a0]|$)/;

/**
 * The two depths this file's readers use, and why they are not the same number.
 *
 * `ROW_WINDOW` is what the ANCHORED rules (`composerSpans` and everything built
 * on them) are given. Wider than the 40 rows the rest of the delivery path
 * reads, because the anchor is STRUCTURAL rather than positional: it looks for
 * the composer's own box, and mid-turn that box is not near the bottom of the
 * replay. `render.ts` replays the whole buffer into a fixed 50-row VT, so a
 * repaint caught half-done leaves stale rows — a duplicated footer, then rows
 * of streaming turn output — sitting UNDER the newest composer frame. Reading
 * more rows costs nothing extra: it is still one render call, asked for more of
 * what it already produced. (In the alternate screen — every tmux-hosted
 * session — `drive.ts` now reads the recorder's live grid instead, which is the
 * pane's height; the window is then simply larger than the screen.)
 *
 * `FALLBACK_ROWS` is what the DISTANCE rule gets, and it is deliberately the
 * old 40 rather than the wider window. That rule places a hit by counting rows
 * between it and the bottom of the capture, and one of its branches (the
 * slash-completion allowance) accepts a hit at ANY height as long as two
 * squashed rows below it start with `/`. Rows starting with `/` are file paths,
 * i.e. most of what tool output is made of, so the only thing bounding that
 * branch was that the old code physically could not see past 40 rows. Handing
 * it 100 makes a `/review packages/host/…` that ran sixty rows ago read as one
 * sitting unsent in the box — "already typed, provably ours", nothing typed,
 * and a Return into an empty composer. The anchored rule gets the wide view
 * because it knows WHERE the box is; the fallback exists precisely for the
 * screens where nobody knows that, so it keeps the reach it was safe at.
 *
 * Both live here rather than at either caller because `deliver.ts` and
 * `settle.ts` must ask the same question of the same screen — a window that
 * disagreed would mean a tear deliver can confirm and settle cannot see.
 */
export const ROW_WINDOW = 100;
export const FALLBACK_ROWS = 40;

/** One drawn composer frame: where its input row is, and what it is holding. */
export interface ComposerSpan {
  /** Index of the `❯` input row within the rows it was found in. */
  readonly at: number;
  /** The rows the box is drawing, input row first, borders stripped. */
  readonly rows: readonly string[];
}

/** A rendered row with the box borders and the indent taken off. */
const bareRow = (row: string): string =>
  row.replace(/^\s+/, "").replace(/^[\u2502\u2503|]\s*/, "").replace(/[\u2502\u2503|]\s*$/, "");

const isRuleRow = (row: string, rule: RegExp = COMPOSER_RULE_RE): boolean => rule.test(row.trim());

/**
 * From a blank row inside a frame, the index of the rule that closes the box,
 * or -1 when nothing does: a `❯` row first (the next frame), the end of the
 * screen, or a rule that OPENS a frame (a `❯` row is its next non-blank row).
 */
function closingRuleAfter(rawRows: readonly string[], from: number, cursor: RegExp, rule: RegExp): number {
  for (let k = from; k < rawRows.length; k++) {
    const row = rawRows[k];
    if (!row.trim()) continue;
    if (cursor.test(bareRow(row))) return -1;
    if (!isRuleRow(row, rule)) continue;
    let next = k + 1;
    while (next < rawRows.length && !rawRows[next].trim()) next++;
    return next < rawRows.length && cursor.test(bareRow(rawRows[next])) ? -1 : k;
  }
  return -1;
}

/**
 * Every composer frame drawn on this rendered screen, top to bottom.
 *
 * **Why this exists at all: the bottom of the render is not the bottom of the
 * screen.** `deliver.ts` used to accept an echo only if it sat within ~11 rows
 * of the last row of the capture, which is a fine rule for an idle TUI and
 * wrong for a working one. `render.ts` replays the WHOLE buffer into a fixed
 * 50-row VT, so a repaint caught half-done tears: a live capture of a delivery
 * that was declared a miss had the typed text sitting in the composer with a
 * DUPLICATED footer and eight rows of streaming turn output underneath it. The
 * echo was found and then refused for being too far up, the delivery came back
 * `unconfirmed`, and the sweep that follows sent an Esc into a running turn.
 * "How far from the bottom" measures the tear; "is it inside the box" measures
 * the thing we actually wanted to know.
 *
 * A frame is a `❯` input row with one of the composer's full-width rules
 * ADJACENT ABOVE it, running down to the rule that closes the box. Both anchors
 * are load-bearing: the rule above is what stops a `❯` cursor drawn by one
 * of the CLI's inline pickers from reading as a composer, and the rule below is
 * what stops the span from running on into whatever the turn is printing under
 * the box. Blank rows are skipped looking upward because the replay squeezes
 * runs of them; looking DOWN a blank row is the text's own blank line, kept
 * only while a rule still closes the box below it (`closingRuleAfter`).
 *
 * Structural, so it degrades the safe way: an upstream redraw this does not
 * recognise yields NO spans, and every caller falls back to what it did before.
 * A composer we cannot see must never brick delivery.
 */
export function composerSpans(
  rawRows: readonly string[],
  cursor: RegExp = COMPOSER_CURSOR_RE,
  rule: RegExp = COMPOSER_RULE_RE,
): ComposerSpan[] {
  const out: ComposerSpan[] = [];
  for (let i = 0; i < rawRows.length; i++) {
    const head = bareRow(rawRows[i]);
    if (!cursor.test(head)) continue;
    let above = i - 1;
    while (above >= 0 && !rawRows[above].trim()) above--;
    if (above < 0 || !isRuleRow(rawRows[above], rule)) continue;
    // The cursor itself is not content: an EMPTY box must read as empty, which
    // is how `newestOnly` below tells a live frame from a stale one.
    const rows: string[] = [head.replace(cursor, "")];
    for (let j = i + 1; j < rawRows.length; j++) {
      const row = rawRows[j];
      if (!row.trim()) {
        // A blank row is INSIDE the box when the text has a blank line in it
        // (measured on 2.1.301, `fixtures/screens/paste-blankrow.txt`): stopping
        // here dropped the tail, the one thing tying a placeholder to its text.
        // It is believed only when the rows after it still CLOSE this box — a
        // rule that is not the top of another frame — so a frame torn open at
        // the bottom never runs on into the turn printing under it.
        const close = closingRuleAfter(rawRows, j, cursor, rule);
        if (close < 0) break;
        for (; j < close; j++) rows.push(bareRow(rawRows[j]));
        break;
      }
      if (isRuleRow(row, rule)) break;                     // the rule that closes it
      if (cursor.test(bareRow(row))) break;                // the next frame, not this one
      rows.push(bareRow(row));
    }
    out.push({ at: i, rows });
  }
  return out;
}

/** What one frame is holding, in the comparison view every rule here runs on. */
export const composerText = (span: ComposerSpan): string => squash(span.rows.join(""));

/**
 * Is this text in the composer — asked STRUCTURALLY, of the box itself?
 *
 * Answers `null` when there is no composer frame on this screen at all, which
 * is a different statement from `"none"` and callers must keep them apart:
 * `null` means "this rule cannot speak about that screen, use your fallback",
 * `"none"` means "the box is right there and your text is not in it". Folding
 * the two together is how a heuristic that stopped recognising an upstream
 * redraw would turn every delivery into a gravestone.
 *
 * All frames are scanned bottom-up by default, because a torn repaint can leave
 * a stale EMPTY frame below the live one, and the after-write poll has no doubt
 * about ownership anyway — it typed the text moments ago. `newestOnly` is for
 * the question asked BEFORE typing: "does this composer ALREADY hold my text"
 * is a claim about the live box, so it is asked of the bottom-most frame that
 * is holding anything, and of nothing else.
 *
 * `newestOnly` skipping empty frames is a GUESS about which frame is live, and
 * a caller that will act on the answer must put `composerFramesAmbiguous()` in
 * front of it — see that function for the case where the guess is wrong.
 */
export function composerEcho(
  rawRows: readonly string[],
  text: string,
  opts: { newestOnly?: boolean } = {},
): EchoRule | null {
  const spans = composerSpans(rawRows);
  if (!spans.length) return null;
  const bottomUp = [...spans].reverse();
  const candidates = opts.newestOnly
    ? [bottomUp.find((s) => composerText(s)) ?? bottomUp[0]]
    : bottomUp;
  for (const span of candidates) {
    const held = composerText(span);
    const rule = screenEcho(held, text);
    // The order is the evidence order, not the cheapness order. `exact` and
    // `paste` already tie the box to this text as tightly as anything here
    // can. Below them the box being a WINDOW onto our text is strictly more
    // evidence than its first fourteen characters happening to be drawn — so a
    // prompt whose head is visible AND whose visible rows are all ours is
    // reported as the stronger of the two, not the weaker.
    if (rule === "exact" || rule === "paste") return rule;
    if (scrolledEcho(held, text)) return "scrolled";
    if (rule !== "none") return rule;
  }
  return "none";
}

/**
 * Is this box a VIEWPORT onto our text rather than a field holding all of it?
 *
 * The CLI's composer scrolls (`SLICE_MIN`), so everything it is drawing can be
 * a contiguous window of a longer prompt with both ends off the box. A window
 * is asked for as a substring rather than a suffix deliberately, even though
 * the window a delivery produces is a suffix: the cursor is at the end when we
 * have just typed, but `settle.ts` asks the same question minutes later, and by
 * then the box may have been scrolled anywhere — the live capture that started
 * this showed the HEAD of a 632-character prompt hours after it was typed.
 *
 * `held` must already be `squash`ed — `composerText` is what produces it.
 */
function scrolledEcho(held: string, text: string): boolean {
  if (held.length < SLICE_MIN) return false;
  return squash(text).includes(held);
}

/**
 * Do the drawn frames DISAGREE about what the live composer is holding?
 *
 * `newestOnly` above answers "does the box already hold my text" off the
 * bottom-most frame that is holding anything — which is the right guess for the
 * tear this file was written for (a stale EMPTY frame stranded below the live
 * one), and the wrong one for the same tear the other way up. An interjection
 * that was just SUBMITTED leaves the live box empty at the bottom of the replay
 * with a stale frame above it still showing the words that have already gone.
 * Skipping the empty frame then reads the stale one and says "your text is
 * already in the composer" about a box that is empty — after which the caller
 * types nothing and presses Return at nothing, i.e. `unsubmitted` for a prompt
 * that never ran.
 *
 * Neither frame can be shown to be the live one from a rendered screen, so this
 * does not try: it reports that the screen is not answerable, and the standing
 * rule here is that "I cannot tell" is not a confident match. The caller's
 * honest move is the one that has no side effect at all — type nothing, submit
 * nothing, say why (`deliver.ts`'s `retry`) — never a guess between two frames
 * where one of the two outcomes runs somebody's words and the other runs none.
 *
 * Deliberately NOT folded into `composerEcho`'s return type. The three rules
 * are evidence grades that `echoAmbiguous`, `settle.ts` and the delivery path
 * all switch on; a fourth member meaning "disregard the other three" would have
 * to be handled correctly at every one of those sites on pain of reading as a
 * match, and a predicate the one caller that cares asks first cannot be
 * silently mishandled by the ones that do not.
 */
export function composerFramesAmbiguous(rawRows: readonly string[]): boolean {
  const spans = composerSpans(rawRows);
  if (spans.length < 2) return false;                     // one box, nothing to disagree with
  if (composerText(spans[spans.length - 1])) return false; // the live box speaks for itself
  return spans.some((s) => composerText(s));
}

/**
 * The anchors a backend's composer is found by — `BackendDelivery`'s
 * `composerCursorRe` / `composerRuleRe` / `composerPlaceholderRe`, handed in by
 * the caller so this file stays free of any one backend's literals beyond
 * claude's own defaults. Both null ⇒ there is no composer reader for that
 * backend, and `composerHeld` answers null (no opinion) for every screen.
 */
export interface ComposerAnchors {
  readonly cursor: RegExp | null;
  readonly rule: RegExp | null;
  /** An EMPTY composer's own hint text, where it is not drawn dim (opencode's
   *  `Ask anything...` is a grey foreground, measured). Tested against the
   *  held text, trimmed. */
  readonly placeholder?: RegExp | null;
}

/** claude's composer: a `❯` input row under one of its full-width rules. */
export const CLAUDE_COMPOSER: ComposerAnchors = Object.freeze({
  cursor: COMPOSER_CURSOR_RE,
  rule: COMPOSER_RULE_RE,
});

/** A box border at the start of a row — opencode's `┃` gutter (or `│`/`|`). */
const GUTTER_RE = /^\s*[┃│|]/;
/**
 * How many non-blank rows a cursor-only composer may have UNDER it and still be
 * the composer. Codex (0.160.0, measured) draws the composer and then a blank,
 * a model/cwd row and a hint row — two. A `›` row with more than this below it
 * is a past prompt in the transcript, which this TUI draws with the same glyph.
 */
const CURSOR_ONLY_FOOTER_MAX = 4;

/**
 * Is the cursor row at `at` a DRAWN composer, rather than the last thing a
 * cursor-only TUI happened to draw with the same glyph?
 *
 * Codex draws its composer, its past prompts and a modal's selected option all
 * with `›`, so "the bottom-most `›` row with a short footer" is a guess, and
 * with a modal up and no composer drawn it guessed a transcript row or the
 * option `› 1. Yes, proceed (y)` — which then read as text "held" in the box and
 * refused a send with "clear it at the desk" about a box nobody could clear.
 * Two shapes are evidence AGAINST, measured on 0.160.0 and its fake:
 *
 *  - a numbered option (`1. …`, `1) …`) under the cursor — a picker, not a box;
 *  - a row that starts at column 0 before the first blank row — a transcript
 *    bullet (`• ping`) directly under a PAST prompt. The live composer is
 *    followed by its own wrapped (indented) rows and then a BLANK row before the
 *    model/cwd footer, or by the end of the screen.
 *
 * Either ⇒ no box this rule can place ⇒ `composerHeld` answers null: no
 * opinion, never a refusal.
 */
function cursorOnlyComposerDrawn(rawRows: readonly string[], at: number): boolean {
  if (/^[\s\u00a0]*\d+[.)][\s\u00a0]/.test(bareRow(rawRows[at]).replace(/^\S+/, ""))) return false;
  for (let j = at + 1; j < rawRows.length; j++) {
    const row = rawRows[j];
    if (!row.trim()) return true;
    if (/^\S/.test(row)) return false;
  }
  return true;
}

/**
 * What the LIVE composer is holding right now, as drawn — or `null` when this
 * screen gives no composer this rule can place.
 *
 * Asked BEFORE typing, by `deliver.ts`, about a different thing from
 * `composerEcho`: not "is my text there" but "is ANYTHING there". A key pressed
 * at the desk after the phone answered a box (Codex's `y`, measured in 4 of 4
 * live rounds) is ordinary text in the composer, and typing a prompt after it
 * sends `yReply …` — words merged that nobody wrote together.
 *
 * `""` means the box was found and is empty; `null` means "cannot speak about
 * this screen", and the caller must then do exactly what it did before this
 * reader existed. Three shapes, by which anchors the backend gives:
 *
 *  - cursor AND rule (claude): `composerSpans`, the bottom-most frame. A torn
 *    replay whose frames disagree (`composerFramesAmbiguous`) is null — which
 *    frame is live is not readable, and refusing on a guess would hold a send
 *    for a box that may well be empty.
 *  - cursor only (Codex's `›`): the bottom-most cursor row, provided at most
 *    `CURSOR_ONLY_FOOTER_MAX` non-blank rows sit under it. Its first row only:
 *    "is anything there" needs nothing more.
 *  - rule only (opencode's `╹▀▀▀`): the `┃` gutter rows directly above the
 *    bottom-most rule, minus the lowest one, which is the box's own
 *    `Build · <model>` status row.
 *
 * What it can NOT see is the attribute an empty box's hint is drawn in: claude's
 * `Try "…"` and Codex's `Ask Codex to do anything` are DIM (SGR 2, both
 * measured), so on the plain rendered text they read as content. The caller
 * asks again of the rows with dim cells blanked (`render.ts`'s `undimmed`) before
 * believing a non-empty answer, and `placeholder` covers a hint drawn in a
 * colour instead.
 */
export function composerHeld(rawRows: readonly string[], a: ComposerAnchors): string | null {
  const tidy = (s: string) => s.replace(/[\s ]+/g, " ").trim();
  let held: string | null = null;
  if (a.cursor && a.rule) {
    const spans = composerSpans(rawRows, a.cursor, a.rule);
    if (!spans.length) return null;
    const live = spans[spans.length - 1];
    const text = tidy(live.rows.join(" "));
    // The bottom box empty and an older one holding words is the tear
    // `composerFramesAmbiguous` describes: no opinion, never a refusal.
    if (!text) return spans.some((s) => composerText(s)) ? null : "";
    held = text;
  } else if (a.cursor) {
    let below = 0;
    for (let i = rawRows.length - 1; i >= 0; i--) {
      const row = bareRow(rawRows[i]);
      if (a.cursor.test(row)) {
        if (!cursorOnlyComposerDrawn(rawRows, i)) return null;
        held = tidy(row.replace(a.cursor, ""));
        break;
      }
      if (rawRows[i].trim() && ++below > CURSOR_ONLY_FOOTER_MAX) return null;
    }
    if (held === null) return null;
  } else if (a.rule) {
    let r = -1;
    for (let i = rawRows.length - 1; i >= 0; i--) if (a.rule.test(rawRows[i])) { r = i; break; }
    if (r < 0) return null;
    const box: string[] = [];
    for (let i = r - 1; i >= 0 && GUTTER_RE.test(rawRows[i]); i--) box.unshift(bareRow(rawRows[i]));
    if (box.length < 2) return null; // no room for a status row AND an input row: not a box we know
    held = tidy(box.slice(0, -1).join(" "));
  } else {
    return null;
  }
  if (held && a.placeholder?.test(held)) return "";
  return held;
}

/**
 * Is THIS text what the LIVE composer is holding — asked before typing?
 *
 * The question `deliver.ts` asks to decide "already typed, just press Return",
 * and the one place a wrong yes costs a whole prompt: nothing is typed and a
 * Return lands in an empty box. Measured with the Codex plugin's race harness
 * (`SAME_HEAD=1`): a prompt whose first fourteen squashed characters equalled
 * the PREVIOUS one's — two "Run exactly this one shell command…", or
 * "continue" twice, or a plain re-send — was never typed, because on a backend
 * whose box `composerEcho` (claude's anchors) cannot place, the old
 * distance-from-the-bottom rule found the earlier prompt still drawn in the
 * transcript a few rows above the live box.
 *
 * So the judgment is made on the live box and nothing else, found by the
 * BACKEND'S OWN anchors — claude's `composerSpans` (the newest frame holding
 * anything, as `composerEcho`'s `newestOnly`), else `composerHeld` for a
 * cursor-only or rule-only reader — and a `head` match counts only when the box
 * holds a PREFIX of our text and nothing else: a box whose fourteen-character
 * head agrees and whose rest goes on differently is another prompt, and
 * `deliver.ts`'s foreign-text check is where that belongs.
 *
 * `null` = no reader for this backend, or no box it can place on this screen:
 * no opinion, and the caller decides what that degrades to.
 */
export function liveComposerEcho(
  rawRows: readonly string[],
  text: string,
  a: ComposerAnchors,
  opts: { looseHead?: boolean } = {},
): EchoRule | null {
  let held: string;
  if (a.cursor && a.rule) {
    const spans = composerSpans(rawRows, a.cursor, a.rule);
    if (!spans.length) return null;
    const bottomUp = [...spans].reverse();
    held = composerText(bottomUp.find((s) => composerText(s)) ?? bottomUp[0]);
  } else {
    const h = composerHeld(rawRows, a);
    if (h === null) return null;
    held = squash(h);
  }
  if (!held) return "none";
  const rule = screenEcho(held, text);
  if (rule === "exact" || rule === "paste") return rule;
  if (scrolledEcho(held, text)) return "scrolled";
  // `looseHead` is the old prefix-only reading, kept for the one caller that
  // asks it to tell a RIVAL delivery's words from a stranger's (same verdict,
  // a different sentence) — never to conclude "already typed".
  if (rule === "head" && (opts.looseHead || squash(text).startsWith(held))) return "head";
  return "none";
}
