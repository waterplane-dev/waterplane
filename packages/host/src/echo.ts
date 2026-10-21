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
 * **…and a PASTED prompt comes back in its envelope** (measured on 2.1.300 and
 * 2.1.301, the hook's own payload): `\n\n<pasted_content id="7ed2">\n` + the
 * text + `\n</pasted_content id="7ed2">\n`, once per chunk the CLI read it in —
 * and it reads a single write in ~1 KB pieces, each seam cutting mid-word, the
 * seams' newlines varying with how the bytes arrived. `logEcho` was taught this
 * on 2026-10-06; this rule was not, so every prompt over ~800 characters or
 * three lines failed it. Where the screen also missed (several placeholders,
 * no tail on screen), the hook was the only proof left, and it said "something
 * other than your text" about the very words: 12 of 12 such deliveries between
 * 2026-10-06 and 10-15 ran (`settle.ts`: `landed`), each reported `unconfirmed`.
 *
 * So the envelope is read the way `logEcho` reads it — tags off both sides —
 * and, because the seams are the CLI's newlines and not ours, compared blind to
 * whitespace. Still the WHOLE text, still case-exact, still equality: a prefix,
 * a superset or another prompt in the same envelope does not match, and a hook
 * payload with no tag in it never reaches this branch.
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
 * **One write can be several pastes.** The CLI reads a burst in ~1 KB pieces
 * and collapses each piece on its own, so a 5 KB prompt is drawn
 * `[Pasted text #1 +2 lines][Pasted text #2 +2 lines]…[Pasted text #5]` —
 * measured on 2.1.300/2.1.301 (`fixtures/screens/paste-chain.txt`). Reading
 * only the FIRST chit said "2 of 11 lines hidden", no tail was drawn to tie it
 * otherwise, and every such delivery read as never typed. The pieces cut
 * mid-line, so the newlines hidden by the run are exactly the sum of its
 * clauses.
 *
 * A RUN is chits that touch in the squashed haystack — the CLI draws them
 * back to back, and only the last piece can be left uncollapsed (a middle piece
 * is ~1 KB, past `PASTE_MIN_CHARS`). Only the last run on the haystack counts:
 * the live composer is the bottom of the screen, and a placeholder from an
 * earlier paste elsewhere on it is somebody else's count, not part of ours.
 * An absent clause is zero newlines, as for one chit.
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
