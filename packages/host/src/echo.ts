/**
 * "Is THIS text in that?" — the one comparison rule, and the one view it runs on.
 *
 * Three places ask the question and they must not answer it differently:
 * `deliver.ts` asks it of the rendered screen while it is typing, `settle.ts`
 * asks it of the same screen and of the CLI's conversation log minutes later,
 * and the open-question sweep asks it of the log for as long as it takes. Two
 * copies of the rule would eventually be two opinions about the same screen,
 * and the failure that produces is invisible: a prompt reported as never
 * delivered while it is sitting there in plain sight.
 *
 * The helpers lived in `deliver.ts` until the delivery path itself needed to
 * consult the conversation log before giving up. That made `deliver.ts` depend
 * on `settle.ts`, which already depended on `deliver.ts` — a cycle that happens
 * to work in ESM today only because nothing touches these consts at module
 * evaluation time, i.e. a trap armed for whoever next writes a top-level
 * `PASTE_CHIT` somewhere. The rules are pure string logic with no session in
 * them, so they get their own file and both sides import down.
 */

/**
 * The comparison view: whitespace removed, lower-cased.
 *
 * The TUI positions characters individually, so rendered output can lose real
 * spaces ("Isthisaprojectyou…"). Every comparison against a screen — and, for
 * one rule, against the log — runs on this view rather than the raw text.
 */
export const squash = (s: string): string => s.replace(/\s+/g, "").toLowerCase();

/**
 * How much of the head is used as the needle **on a screen**.
 *
 * Fourteen characters, and it stays fourteen. The bound is not a guess about
 * collisions, it is the narrowest composer row this app may be rendering into:
 * the PTY is sized by whoever is holding the phone, the composer wraps rather
 * than truncates, and `onScreen()` looks for the needle WITHIN one rendered
 * row. A longer needle straddles a wrap boundary and stops being found — and a
 * needle that is not found files a running prompt as a gravestone, which is the
 * failure this whole subsystem exists to end.
 *
 * It was also used against the CLI's conversation log until 2026-09-05, and
 * there it was simply wrong. Two prompts sharing a fourteen-character head are
 * indistinguishable by it, and the live run found all three ways that pays out:
 * a prompt that never ran settled `landed` on another prompt's log entry (the
 * row retires, the words are gone), two prompts that were nowhere settled
 * `composer` ("press Return there, never retype it") against a stranger's echo,
 * and `deliverPrompt` returned `ok` for a prompt that never ran — the worst of
 * the three, because nothing ever revisits an `ok`. The trigger shape is not
 * exotic either: **a re-send shares its entire head with the original**, and
 * re-sending is exactly what a person does when this app tells them their
 * prompt did not run.
 *
 * Lengthening the probe would have fixed none of that. It buys a little against
 * two unrelated prompts and nothing at all against a re-send, while costing the
 * one property the number was chosen for. So the fix is elsewhere, in two
 * pieces:
 *
 *  - the LOG needs no prefix at all (`logEcho`) — the jsonl holds the whole user
 *    turn, so it is compared whole;
 *  - the SCREEN keeps the prefix but must say what KIND of match it made
 *    (`screenEcho`), so a caller can refuse to act on one that another open
 *    delivery could equally have produced (`echoAmbiguous`).
 */
export const PROBE_LEN = 14;

/**
 * How much of a composer's contents identifies the text it is a WINDOW onto.
 *
 * **The composer is a viewport, not a field, and on a phone it is a small
 * one.** The CLI sizes the box off the terminal's height and SCROLLS the text
 * inside it, so a prompt longer than that viewport is only ever partly drawn —
 * and after a write the cursor is at the end, so the part drawn is the TAIL.
 * Measured against the 2.1.267 binary at 56 columns: a 632-character prompt
 * shows 3 rows at 12 terminal rows, 5 at 20, and all 14 at 40. The head — which
 * `echoProbe` is cut from, and which every screen rule here asked for — is off
 * the top of the box at exactly the sizes a phone reports.
 *
 * That is the whole of the failure this constant was added for: 45% of every
 * delivery between 300 and 800 characters came back `unconfirmed` (the verdict
 * that is never auto-retried) with the text sitting in plain sight in the
 * composer, against 17% of the short ones. Under 800 characters the CLI does
 * not collapse the text either (`PASTE_MIN_CHARS`), so the placeholder rule
 * that rescues the long ones cannot speak about these at all.
 *
 * Forty characters, and the number is doing a different job from `PROBE_LEN`.
 * That one is bounded ABOVE by the narrowest row we may be rendering into,
 * because it must sit inside one wrapped row. This one is asked of the box's
 * whole contents joined together, so wrapping cannot break it, and it is
 * bounded BELOW by collision: it is the length at which "this window of
 * characters is inside my text" stops being a coincidence. Forty is a short
 * sentence — well past the point where two unrelated prompts agree, and well
 * inside the three rows the smallest composer draws.
 */
export const SLICE_MIN = 40;

/**
 * **Is the prompt the CLI says it submitted the one we typed?**
 *
 * `UserPromptSubmit` hands the host the submitted text, which makes it the only
 * submit proof that is about a DELIVERY rather than about a session (a turn
 * starting says the CLI is busy; this says what it is busy with). The rule is
 * deliberately STRICT — whole-string equality after normalising the two things
 * a terminal round trip legitimately changes:
 *
 *  - line endings, because the PTY write carries `\r` and the CLI hands back
 *    `\n`;
 *  - trailing whitespace on the whole text, because a composer submits what it
 *    holds and the last keystroke before Return is frequently a space.
 *
 * Nothing else. A prefix rule would match the re-send of a prompt that was
 * itself a prefix, and a fuzzy one would let a delivery claim the turn started
 * by somebody typing into the same session by hand — and the verdict this
 * evidence upgrades (`unconfirmed` → `ok`) is the one that decides whether a
 * prompt is ever sent again. Being wrong in that direction loses the words
 * silently; being wrong in the other costs a settle pass that was going to run
 * anyway.
 *
 * **…and a PASTED prompt comes back in its envelope** (2.1.300/2.1.301, the
 * hook's own payload): `<pasted_content id="7ed2">` chunks, one per ~1 KB piece
 * the CLI read the write in, seams cutting mid-word with varying newlines.
 * `logEcho` learned this on 2026-10-06, this rule did not: 12 of 12 such
 * deliveries that ran were reported `unconfirmed`. So tags come off both sides
 * and the compare is whitespace-blind — still the WHOLE text, case-exact,
 * equality; a payload with no tag never reaches this branch.
 */
export function samePromptText(hookPrompt: string, ours: string): boolean {
  const norm = (t: string) => t.replace(/\r\n?/g, "\n").replace(/[ \t]+$/gm, "").trim();
  const a = norm(hookPrompt), b = norm(ours);
  if (a.length > 0 && a === b) return true;
  if (!hookPrompt.includes("<pasted_content")) return false;
  const bare = (t: string) => unwrapPasted(t).replace(/\s+/g, "");
  const x = bare(hookPrompt);
  return x.length > 0 && x === bare(ours);
}

/**
 * How much text this file will scan for a shared window before giving up.
 *
 * `echoAmbiguous` answers the scrolled rule by asking whether a rival could
 * have produced the same window, which is a substring search over both texts.
 * Past this size that stops being free, and the standing rule here is that a
 * question we cannot answer is answered "I cannot tell" — so beyond it a rival
 * is treated as confusable rather than scanned for. The cost of that is one
 * `retry`, which types nothing and is safe to repeat; the cost of the other
 * direction is pressing Return on somebody else's words.
 */
const SLICE_SCAN_MAX = 20000;

/** Does `b` contain any `SLICE_MIN`-character window of `a`? */
function sharesSlice(a: string, b: string): boolean {
  if (a.length < SLICE_MIN || b.length < SLICE_MIN) return false;
  if (a.length > SLICE_SCAN_MAX || b.length > SLICE_SCAN_MAX) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  for (let i = 0; i + SLICE_MIN <= short.length; i++) {
    if (long.includes(short.slice(i, i + SLICE_MIN))) return true;
  }
  return false;
}

/** The head of the text, squashed. */
export const echoProbe = (text: string): string => squash(text).slice(0, PROBE_LEN);

/** The tail of the text, squashed — what is still drawn when the TUI has
 *  collapsed the head behind a paste placeholder. */
export const tailProbe = (text: string): string => squash(text).slice(-PROBE_LEN);

/**
 * The claude TUI's collapsed-paste placeholder, against a `squash`ed haystack:
 * `[Pasted text #1 +11 lines]` — or just `[Pasted text #1]`.
 *
 * **The line count is OPTIONAL and its absence is a fact, not a gap.** The CLI
 * builds the placeholder from the NEWLINE count of what it swallowed, and it
 * omits the clause entirely when that count is zero:
 *
 *     function(id, newlines) {
 *       if (newlines === 0) return `[Pasted text #${id}]`;
 *       return `[Pasted text #${id} +${newlines} lines]`;
 *     }
 *
 * (measured against the 2.1.236 binary). So a LONG SINGLE-LINE prompt — the
 * ordinary shape of a message typed on a phone, which has no reason to hold a
 * newline at all — collapses to a placeholder that says nothing but "a paste
 * with no newlines in it happened here". A regex that required `+N lines`
 * matched none of them: every long one-line send echoed perfectly, read as
 * never typed, came back `unconfirmed` (the verdict that is never auto-retried)
 * and sat one keypress from running behind a gravestone. That is the same
 * failure `e2e-pastechit.mjs` pins for the multi-line case, arriving through
 * the half of the placeholder nobody had seen.
 *
 * The capture is therefore how many NEWLINES it is hiding, and an ABSENT
 * capture means zero of them — which is the only thing the placeholder says
 * about the text behind it, and, for a one-liner, the whole of the tie.
 */
export const PASTE_CHIT = /\[pastedtext#\d+(?:\+(\d+)lines?)?\]/;

/**
 * How long a write has to be before the TUI collapses it whatever its shape.
 *
 * The other half of the same measurement: the composer collapses on
 * `text.length > 800 || newlines > 2`, so LENGTH is a collapse trigger in its
 * own right and a single-line prompt is not exempt from it. Eight hundred
 * characters is a paragraph — well inside what a person dictates into the
 * compose bar, and far inside a "set up this repo" prompt.
 *
 * It is used only to decide whether a placeholder COULD be about this text.
 * Getting it wrong in the loose direction costs a rival check; getting it wrong
 * in the strict direction is the gravestone above, so it stays the CLI's own
 * number rather than a safety margin off it.
 */
export const PASTE_MIN_CHARS = 800;

/**
 * Could the TUI have collapsed THIS text into a placeholder at all?
 *
 * Either trigger is enough: over `PASTE_MIN_CHARS` characters, or enough
 * newlines in it. The line half keeps the three it has always used rather than
 * the CLI's four, because that bound also moves with the terminal height
 * (`min(rows - 10, 2)` newlines) and being one line loose here only ever hands
 * the answer to the tie-breakers below.
 */
export const pasteCollapsible = (text: string): boolean =>
  text.length > PASTE_MIN_CHARS || text.split("\n").length >= 3;

/**
 * How many newlines the NEWEST run of placeholders is hiding, or null for none.
 *
 * **One write can be several pastes.** The CLI collapses each ~1 KB piece on
 * its own, so a 5 KB prompt draws `[Pasted text #1 +2 lines]…[Pasted text #5]`
 * (2.1.301, `fixtures/screens/paste-chain.txt`); the first chit alone said
 * "2 of 11 lines". The pieces cut mid-line, so the run's clauses SUM to every
 * newline. A run is chits touching in the squashed haystack, and only the last
 * one counts — the live composer is the bottom of the screen.
 *
 * `haystack` must already be `squash`ed.
 */
export function pastedNewlines(haystack: string): number | null {
  const chit = new RegExp(PASTE_CHIT.source, "g");
  let sum: number | null = null, end = -1;
  for (const m of haystack.matchAll(chit)) {
    const n = m[1] === undefined ? 0 : Number(m[1]);
    sum = m.index === end && sum !== null ? sum + n : n;
    end = m.index + m[0].length;
  }
  return sum;
}

/**
 * Does this haystack hold THIS text as a collapsed paste?
 *
 * A write of several lines — or of one long one — in a single chunk is
 * indistinguishable from a paste, and the TUI collapses a paste to a
 * placeholder plus whatever tail still fits, so the head, which every other
 * probe is cut from, is nowhere to be found. The placeholder is therefore an
 * echo like any other, but it names no text, so it only counts with a second
 * fact tying it to THIS one: the tail still on screen, or a hidden-newline
 * count that accounts for essentially all of it. A stale placeholder from an
 * earlier, different paste satisfies neither — and note that the tie runs in
 * BOTH directions now that the count can be absent: a bare `[Pasted text #5]`
 * is a paste with no newlines in it, which is evidence FOR a one-line prompt
 * and evidence AGAINST a twelve-line one.
 *
 * `haystack` must already be `squash`ed.
 */
export function collapsedPasteEcho(haystack: string, text: string): boolean {
  if (!pasteCollapsible(text)) return false;
  const hidden = pastedNewlines(haystack);
  if (hidden === null) return false;
  const lines = text.split("\n").length;
  if (hidden > lines + 1) return false;     // far more than we ever wrote
  if (hidden >= lines - 1) return true;     // it swallowed the lot
  const tail = tailProbe(text);
  return !!tail && haystack.includes(tail);
}

/**
 * WHICH rule found the text on a screen — because the rules are not equally
 * good evidence and the caller has to be able to tell them apart.
 *
 *   exact    — the whole squashed text is on screen. Nothing else can produce
 *              that except text that IS this text, so it is proof on its own.
 *   scrolled — the COMPOSER's whole contents are a `SLICE_MIN`-long window of
 *              this text, i.e. the box is a viewport scrolled onto part of it.
 *              Composer-only by construction (`composerEcho`): it is a claim
 *              about everything one box is holding, and asking it of a whole
 *              screen would be meaningless. Far more text than `head` and
 *              still not identity — a rival that contains the same window
 *              satisfies it equally, which is what `echoAmbiguous` polices.
 *   head     — only the fourteen-character head matched. True of every prompt
 *              that shares that head, which is every re-send and any neighbour
 *              whose first few words happen to agree.
 *   paste    — the TUI collapsed it and the placeholder is tied to this text by
 *              its tail or by a hidden-line count that covers all of it. Better
 *              than `head` and still not identity: two multi-line prompts with
 *              the same tail, or the same length, satisfy it equally.
 *   none     — not there.
 *
 * `haystack` must already be `squash`ed. Empty text has no needle and can never
 * match — a delivery of nothing is not something we may claim to have seen.
 */
export type EchoRule = "exact" | "scrolled" | "head" | "paste" | "none";

export function screenEcho(haystack: string, text: string): EchoRule {
  const probe = echoProbe(text);
  if (!probe) return "none";
  if (haystack.includes(squash(text))) return "exact";
  if (haystack.includes(probe)) return "head";
  if (collapsedPasteEcho(haystack, text)) return "paste";
  return "none";
}

/**
 * Does this haystack hold this text, by any of the screen rules?
 *
 * Kept as the yes/no form of `screenEcho` for the call sites that genuinely
 * only want a boolean. Anything that will ACT on the answer should ask
 * `screenEcho` and put the rule past `echoAmbiguous` first.
 */
export function textEcho(haystack: string, text: string): boolean {
  return screenEcho(haystack, text) !== "none";
}

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
 * what it already produced.
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

/**
 * Could this match just as easily have been one of those?
 *
 * The disambiguation rule, and the reason it exists at all: a screen match is a
 * PREFIX match, and a prefix says "some text starting like this is here", not
 * "your text is here". When something else that could be in that composer would
 * have produced the identical match, the match is not evidence about ours, and
 * this codebase's standing rule is to degrade to "I cannot tell" rather than to
 * a confident wrong answer. `unknown` costs one more sweep; a wrong `composer`
 * tells the user to press Return on somebody else's prompt, and a wrong
 * `landed` retires the row and takes the words with it.
 *
 * Confusability is asked PER RULE, because each rule ties the match to the text
 * by a different fact and a rival only counts if it satisfies the same one:
 *
 *   exact    — nothing is confusable. The whole text is there.
 *   scrolled — a rival that contains a `SLICE_MIN`-long window of our text, so
 *              the same drawn box could be a viewport onto either. Asked as
 *              "do these two share any window at all" rather than "does the
 *              rival hold THE window", because the window is a fact about the
 *              screen and this function is only given the two texts. That is
 *              the conservative direction: it can call a match ambiguous that
 *              was not, and the cost of that is a `retry`, which types nothing.
 *   head     — a rival sharing the fourteen-character head.
 *   paste    — a rival that is also a collapsible multi-line text and shares
 *              the tail, or is close enough in line count to satisfy the
 *              "it swallowed the lot" branch of `collapsedPasteEcho`.
 *
 * A rival whose squashed text EQUALS ours is never confusable, and that is the
 * important exemption rather than an optimisation: the common rival is a
 * re-send of the same words, and if the composer holds our own words then
 * submitting them runs our own words. Which ROW gets the credit is a separate
 * question (`settle.ts` answers it by claiming the log turn); what is on the
 * screen is not in doubt.
 */
export function echoAmbiguous(rule: EchoRule, text: string, others: readonly string[]): boolean {
  if (rule === "none" || rule === "exact") return false;
  const me = squash(text);
  const lines = text.split("\n").length;
  return others.some((o) => {
    const theirs = squash(o);
    if (!theirs || theirs === me) return false;
    if (rule === "head") return echoProbe(o) === echoProbe(text);
    if (rule === "scrolled") return sharesSlice(theirs, me);
    // Never collapsible, never a rival here — and "collapsible" is length OR
    // shape, so a long one-liner is in the running exactly like a long
    // multi-line prompt is (`pasteCollapsible`).
    if (!pasteCollapsible(o)) return false;
    const theirLines = o.split("\n").length;
    if (tailProbe(o) === tailProbe(text)) return true;
    // The swallow branch is tied to nothing but a newline count, so any rival
    // whose count the same placeholder could be reporting is a rival — and for
    // two one-liners that count is zero on both sides, i.e. a bare
    // `[Pasted text #5]` cannot tell them apart at all. That is the case this
    // branch exists for: the evidence is real but it is not about anyone.
    return Math.abs(theirLines - lines) <= 1;
  });
}

/**
 * How much of the text is compared against the CLI's own conversation log.
 *
 * Four thousand squashed characters — roughly 285 times the screen probe, and
 * chosen as "past every collision, short of every truncation". Two distinct
 * prompts that agree for four thousand characters and diverge after are the
 * same instruction for every purpose this app has, while a cap keeps the needle
 * clear of the two places a whole-text comparison could break in the dangerous
 * direction: `transcript.ts` caps a stored prompt at 200 000 characters, and
 * any future normalisation the CLI applies to a very long turn would land at
 * its end. Falling short there answers `absent`, and `absent` is the verdict
 * that authorises sending the prompt a second time — so the needle stops well
 * before anything that could be trimmed.
 */
export const LOG_NEEDLE_MAX = 4000;

/**
 * Does this LOGGED user turn hold this text?
 *
 * The conversation log has no truncation problem to work around: the CLI wrote
 * the whole turn down when it accepted the prompt, so the comparison is the
 * whole text and not a fourteen-character head. That single change is what
 * stops another prompt's log entry from proving ours ran — the one failure in
 * this family that destroys words rather than merely delaying them.
 *
 * `logged` is the raw turn text; both sides are squashed here, because the
 * caller has no reason to know that the log needs the same whitespace-blind
 * view a screen does (a prompt typed with a trailing newline, a CRLF, or
 * re-wrapped by the composer must still be recognised as itself).
 *
 * The collapsed-paste rule is kept as a second chance and NOT as the main one:
 * if a CLI version ever records a pasted prompt as its placeholder rather than
 * its content, removing this would turn every long prompt into `absent` and
 * re-send it. It is the same tie-to-this-text rule as everywhere else.
 *
 * **A pasted prompt is logged WRAPPED and CHUNKED** (measured on 2.1.291): the
 * turn reads `<pasted_content id="893a">` + ~1000 chars + `</pasted_content
 * id="893a">`, repeated, each seam cutting mid-word. Compared raw, every long
 * prompt past the first chunk read `absent` though it ran — and a person was
 * told "nothing ran". The tags are stripped from BOTH sides, so a prompt that
 * itself quotes one is still compared like for like.
 */
const PASTE_TAG = /<\/?pasted_content\b[^>]*>/g;
export const unwrapPasted = (s: string): string => s.replace(PASTE_TAG, "");

export function logEcho(logged: string, text: string): boolean {
  const needle = squash(unwrapPasted(text)).slice(0, LOG_NEEDLE_MAX);
  if (!needle) return false;
  const hay = squash(unwrapPasted(logged));
  return hay.includes(needle) || collapsedPasteEcho(hay, text);
}

/**
 * Is this a slash command — i.e. text whose fate the conversation log cannot
 * report?
 *
 * The CLI does not write a slash command as a user turn. It writes an envelope
 * (`<command-name>/foo</command-name>` and friends), and `transcript.ts`'s
 * `promptOf` drops exactly those — deliberately, because a reader that showed
 * them would label every archive row `<command-name>`. The consequence for
 * anything reasoning from the log is absolute: for a slash command the log is
 * silent whether or not it ran, so absence there is not evidence of anything.
 * Saying "absent" about one would be saying "nothing ran, send it again" about
 * a command that ran perfectly.
 */
export function isSlashText(text: string): boolean {
  return text.trimStart().startsWith("/");
}
