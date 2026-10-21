/**
 * Reading the composer for one delivery — the screen half of `runDelivery`,
 * moved out of `deliver.ts` (docs/notes/host-architecture.md, "The deliver
 * slices"). Still one implementation: only `runDelivery` calls this.
 */
import type { SessionManager } from "../sessions.js";
import type { DeliveryShape } from "@waterplane/shared";
import type { EchoRule } from "../echo.js";
import type { ComposerAnchors } from "../composer.js";
import {
  PASTE_CHIT,
  pastedNewlines,
  pasteCollapsible,
  echoAmbiguous,
  echoProbe,
  squash,
  tailProbe,
} from "../echo.js";
import {
  FALLBACK_ROWS,
  ROW_WINDOW,
  composerEcho,
  composerHeld,
  liveComposerEcho,
} from "../composer.js";
import { rivalTexts } from "../opendeliveries.js";
import { resolveBackend } from "../backends/index.js";
import { FALLBACK_HOLD_MS, sleep } from "./deliverknobs.js";

/** A prompt this long whose words contain the held text whole is our own text
 *  drawn in a way no echo rule placed (a viewport slice under `SLICE_MIN`) —
 *  left to the paths that existed before. Short holdings (`y`) never qualify:
 *  one letter is inside almost any prompt. */
const OURS_MIN = 8;
const QUOTE_MAX = 40;

/**
 * The anchors the session's OWN descriptor finds its composer by (absent id ⇒
 * claude, as everywhere) — or null when there is no reader: a backend this host
 * no longer knows, or one that declares neither anchor.
 */
export function composerAnchorsOf(sessions: SessionManager, sessionId: string): ComposerAnchors | null {
  try {
    const d = resolveBackend(sessions.get(sessionId)?.backend).delivery;
    if (!d.composerCursorRe && !d.composerRuleRe) return null;
    return { cursor: d.composerCursorRe, rule: d.composerRuleRe, placeholder: d.composerPlaceholderRe ?? null };
  } catch {
    return null;
  }
}

/**
 * Is the live composer holding text that is not this delivery's? The words if
 * so (cut for a sentence), else null — and null whenever the screen gives no
 * composer the backend's anchors can place, so a backend with no reader keeps
 * exactly the behaviour it had.
 *
 * Two reads, the second only when the first finds something: the plain render
 * cannot tell a typed `y` from an EMPTY box's hint (claude's `Try "…"`, Codex's
 * `Ask Codex to do anything` — both DIM, measured), so a non-empty answer is
 * asked again of the rows with dim cells blanked (`RenderRow.undimmed`), and
 * only what survives that is foreign. The common case, an empty box with no
 * hint, costs no second replay.
 */
export async function foreignInComposer(
  sessions: SessionManager,
  sessionId: string,
  text: string,
  rows: readonly string[],
): Promise<string | null> {
  const anchors = composerAnchorsOf(sessions, sessionId);
  if (!anchors) return null;
  const plain = composerHeld(rows.length ? rows : (await sessions.screenText(sessionId, ROW_WINDOW)).split("\n"), anchors);
  if (!plain) return null;
  let held: string | null = plain;
  if (typeof sessions.screenCells === "function") {
    held = composerHeld((await sessions.screenCells(sessionId, ROW_WINDOW)).map((r) => r.undimmed), anchors);
    if (!held) return null; // empty once the hint is discounted — or no box to speak of in this read
  }
  const mine = squash(text);
  const theirs = squash(held);
  if (!theirs) return null;
  if (theirs.length >= OURS_MIN && mine.includes(theirs)) return null;
  return held.length > QUOTE_MAX ? `${held.slice(0, QUOTE_MAX - 1)}…` : held;
}

/**
 * Is the live composer holding ONLY dim text — a hint, not typing?
 *
 * claude proposes the next prompt in an EMPTY composer, drawn dim
 * (`clisuggest.ts`), and the phone offers that proposal as one tap — so the
 * words about to be delivered are, letter for letter, the words already drawn
 * in the box. On the plain render that reads as `exact`, "already typed", and
 * the delivery typed nothing and pressed Return into an empty composer: the
 * prompt never ran (measured, the first live tap). The same two reads
 * `foreignInComposer` makes: words on the plain render, none once dim cells
 * are blanked ⇒ the box is empty. False whenever either read cannot place a box.
 */
export async function composerHoldsOnlyHint(sessions: SessionManager, sessionId: string): Promise<boolean> {
  const anchors = composerAnchorsOf(sessions, sessionId);
  if (!anchors || typeof sessions.screenCells !== "function") return false;
  const cells = await sessions.screenCells(sessionId, ROW_WINDOW);
  const plain = composerHeld(cells.map((r) => r.text), anchors);
  if (!plain) return false;
  return composerHeld(cells.map((r) => r.undimmed), anchors) === "";
}

/**
 * The closures `runDelivery` declared over its screen, in the order it
 * declared them. Every one captures only consts (the session, the text, the
 * delivery's `key` and `shape`), so the run destructures what it uses and
 * each call site reads as it did.
 */
export function makeScreenReader(
  sessions: SessionManager,
  sessionId: string,
  text: string,
  key: string,
  shape: DeliveryShape,
  /** A SHELL's multi-line paste: the shell draws each line on its own row with
   *  nothing spliced between, so the needle is cut from the FIRST line — a
   *  head that straddles the newline is on no single row (`PROBE_LEN`). */
  opts: { firstLineProbe?: boolean } = {},
) {
  // Detection reads the RENDERED current screen, not an ANSI-stripped byte
  // window. One claude-TUI repaint of a busy screen is tens of KB, so every
  // byte window is wrong in one direction or the other: too small and text
  // that is plainly on screen sits above the window (read as "not echoed" →
  // the text gets retyped ON TOP of itself, stacking a copy per attempt AND
  // per fire retry — the repeated-prompt bug), too big and stale scrollback
  // false-positives. Rendering the screen removes the guess.
  const screen = async () => squash(await sessions.screenText(sessionId, 40));
  const probe = echoProbe(opts.firstLineProbe ? text.split(/\r?\n|\r/)[0]! : text);
  // How many rendered rows each of the two rules gets — `echo.ts`'s
  // `ROW_WINDOW` for the anchored one, `FALLBACK_ROWS` for the distance one.
  // The numbers differ on purpose and the reason is written down there; both
  // are shared with `settle.ts`, which must not read a narrower screen than
  // this file does or a tear becomes confirmable here and invisible there.
  // The composer check reads only the BOTTOM of the screen — where the input
  // box is — so an identical prompt echoed higher in the visible conversation
  // can't read as "already typed" (which would submit an empty composer and
  // leave the caller waiting forever). Deep enough to hold the wrapped text plus
  // the box borders and hint line; the probe is at the text's head, i.e. the
  // box's first row.
  //
  // This is the OLD way of asking that question — distance from the bottom of
  // the render — and it is kept for exactly one case: a screen on which no `❯`
  // box can be found at all. See `placeEcho`.
  const composerRows = Math.min(40, 10 + Math.ceil(text.length / 40));
  /**
   * Rows of the rendered screen, squashed line by line. Line structure is what
   * lets the composer check say HOW FAR from the bottom the echo sits, which a
   * single squashed blob throws away.
   */
  const screenRows = async (n: number) =>
    (await sessions.screenText(sessionId, n)).split("\n").map(squash);
  /**
   * Is the text in the composer?
   *
   * The naive version sliced the bottom `composerRows` rows — right for a
   * prompt, wrong for a slash command: typing `/cost` opens the completion
   * menu BELOW the input box (one row per command plus wrapped description),
   * which pushes the echo ~20 rows up and out of the window. The text was
   * plainly on screen, read as never typed, and the sweep below then ESC'd the
   * menu away — the "something presses Esc for me" report.
   *
   * That fix widened the window and kept the yardstick, and the yardstick is
   * what was wrong. **Distance from the bottom of the render measures the TEAR,
   * not the composer.** A capture of a delivery this check declared a miss —
   * the text "Yes all 3", interjected into a working session, well inside the
   * echo window — had the words sitting in the composer with a DUPLICATED
   * footer and rows of streaming turn output below them: `render.ts` replays
   * the whole buffer into a fixed 50-row VT, so mid-turn the repaint tears and
   * stale rows land under the newest composer frame. The echo was found and
   * then refused for being eleven rows too high. `unconfirmed` for a prompt in
   * plain sight, and then the sweep's Esc into a running turn.
   *
   * So ask the structural question instead: is the text inside the box the CLI
   * draws to take typing (`composer.ts`'s `composerEcho`, which is also what
   * `settle.ts` asks minutes later — one rule, not two opinions). The old
   * distance test stays as the fallback for a screen with no `❯` box on it at
   * all, because an upstream redraw we stop recognising must degrade to the
   * previous behaviour and never brick delivery.
   *
   * It answers with the RULE that matched, not a boolean, because the rules are
   * not equally good evidence. `"exact"` means the whole squashed text is in
   * the composer, which nothing but this text can produce; `"head"` means only
   * the fourteen-character probe matched, which every prompt sharing that head
   * would have produced too — including a re-send, and including a stranger's
   * prompt left in the composer by an earlier delivery that could not be
   * confirmed. `proven()` below is what decides whether a rule is allowed to
   * mean anything.
   *
   * `newestOnly` is the difference between the two questions asked with it.
   * After our own write, any frame will do — we typed the text moments ago, so
   * the only doubt is which half of a torn repaint drew it. BEFORE typing,
   * "this composer already holds my text" is a claim about the LIVE box, so it
   * is asked of the newest frame and of nothing else.
   */
  const anchors = composerAnchorsOf(sessions, sessionId);
  const fullReader = !!anchors?.cursor && !!anchors?.rule;
  /** Did the last `placeEcho` answer by the no-box rule — no composer frame on
   *  that screen at all? `waitForEcho` holds such an answer (FALLBACK_HOLD_MS). */
  let fellBack = false;
  const placeEcho = (raw: readonly string[], newestOnly: boolean): EchoRule => {
    // BEFORE typing, "already in the composer" is judged on the LIVE box only,
    // by the backend's own anchors, and a head match only where the box holds
    // a prefix of our text (`echo.ts`'s `liveComposerEcho`). Measured: the
    // distance rule below found the PREVIOUS prompt — same first fourteen
    // characters, or the same words re-sent — still drawn in the transcript
    // above the live box, typed nothing, and pressed Return into an empty
    // composer (`unsubmitted`, the prompt never ran). With no reader at all
    // there is no composer to make that claim about, so it is never made.
    if (newestOnly) {
      if (!anchors) return "none";
      const live = liveComposerEcho(raw, text, anchors);
      // A box holding ANOTHER open delivery's words that share our head is not
      // ours either — but it is reported as the rival it is ("cannot tell
      // apart"), which `proven()` then refuses, rather than as a stranger's.
      if (live === "none" && liveComposerEcho(raw, text, anchors, { looseHead: true }) === "head"
        && echoAmbiguous("head", text, rivals())) return "head";
      if (live !== null) return live;
      // A box a cursor-only or rule-only reader cannot place is not evidence
      // that our text is in one. Only claude's full reader keeps the old
      // degrade (a stub, an unrecognised redraw), below.
      if (!fullReader) return "none";
    } else if (anchors && !fullReader) {
      // After our write, a reader that CAN place its box is asked of the box —
      // the transcript row above it is the previous prompt, not this echo.
      const live = liveComposerEcho(raw, text, anchors);
      if (live !== null) return live;
    }
    const anchored = composerEcho(raw, text, { newestOnly });
    fellBack = anchored === null;
    if (anchored !== null) return anchored;
    // No composer frame anywhere on this screen — a picker covering it, a stub
    // TUI, or an upstream redraw. Back to the old rule, and back to the old
    // DEPTH with it: a rule that places a hit by counting rows from the bottom
    // is not "unchanged" when it is handed twice the rows, and the slash branch
    // below accepts a hit at ANY height as long as two rows under it start with
    // `/` — which is how every file path in every tool result starts. Why the
    // two windows differ is written out at `composer.ts`'s `FALLBACK_ROWS`.
    const rows = raw.slice(-FALLBACK_ROWS).map(squash);
    let hit = -1;
    for (let i = rows.length - 1; i >= 0; i--) if (rows[i].includes(probe)) { hit = i; break; }
    // A backend with no composer at all (a shell) draws the line it is given
    // HARD-WRAPPED at the terminal's width, after a prompt of any length — so
    // the probe's fourteen characters straddle a row boundary whenever the
    // wrap falls inside them (measured: `…news % cd /Users/joha` | `nnes/…` at
    // 70 cols, `unconfirmed`, no Return, for a command plainly on screen).
    // Asked of the joined rows, and only where no box exists to be torn across.
    if (hit < 0 && !anchors) hit = wrappedHit(rows, probe);
    if (hit < 0) return pastedNearBottom(rows) ? "paste" : "none";
    // Corroborate before deciding, and corroborate from the hit DOWNWARDS: the
    // composer holds the text wrapped over consecutive rows, so joining from
    // the head row to the bottom and looking for the whole squashed text costs
    // one more comparison and upgrades a prefix guess into an identification.
    // This is what makes the ordinary short prompt immune to the collision
    // entirely, rival or no rival. It does NOT always succeed — the composer
    // draws a border, so a prompt wrapped over several rows has box characters
    // spliced into the middle of it — and that is fine: failing to corroborate
    // falls back to `"head"`, i.e. exactly the evidence this had before, with
    // the rival check in front of it.
    const whole = rows.slice(hit).join("");
    const exact = whole.includes(squash(text));
    if (rows.length - 1 - hit <= composerRows) return exact ? "exact" : "head";
    if (!text.startsWith("/")) return "none";
    const below = rows.slice(hit + 1).filter(Boolean);
    if (below.filter((l) => l.startsWith("/")).length < 2) return "none";
    return exact ? "exact" : "head";
  };
  /** The after-write poll: any frame will do, we typed the text moments ago.
   *  The BEFORE-typing question renders its own rows, because it has a second
   *  question to ask of them — see `composerFramesAmbiguous` at that site. */
  /** The rendered screen the newest echo read was made on, as drawn — the
   *  `deliver.echo` fixture capture keeps the one the rule proved on. */
  let seen = "";
  const onScreen = async (): Promise<EchoRule> => {
    if (!probe) return "none";
    seen = await sessions.screenText(sessionId, ROW_WINDOW);
    return placeEcho(seen.split("\n"), false);
  };
  /**
   * Is a match evidence about OUR text?
   *
   * A prefix match says "text starting like this is here". With another
   * delivery into this session whose text starts the same way — an open
   * question whose prompt may literally be sitting in that composer, or a
   * second delivery in flight — the sentence is not about this prompt, and
   * acting on it produces the failure this app exists to prevent: the live run
   * caught `deliverPrompt` returning `ok` for a prompt that never ran, because
   * a stranger's echo was read as its own and the Return that followed
   * submitted somebody else's words. An `ok` is the one verdict nothing ever
   * revisits.
   */
  const rivals = () => rivalTexts(sessionId, key);
  const proven = (rule: EchoRule) => rule !== "none" && !echoAmbiguous(rule, text, rivals());
  /**
   * The multi-line case: the TUI HIDES the text it echoed.
   *
   * A write of several lines in one chunk is indistinguishable from a paste, and
   * the claude TUI collapses a paste into a placeholder — the composer reads
   * `[Pasted text #1 +11 lines]` followed by whatever tail still fits, and the
   * HEAD of the text (which `probe` is cut from) is nowhere on screen. So a
   * long, multi-line instruction — the "set up this repo's build commands"
   * prompt is one — echoed perfectly, read as never typed, and came back
   * `"unconfirmed"`: sitting in the composer, never submitted, and never
   * auto-retried. That is the whole failure; a Return would have run it.
   *
   * **And LENGTH alone triggers it, with no line clause on the placeholder.**
   * A write past `PASTE_MIN_CHARS` collapses whatever its shape, and the
   * clause is omitted when the text holds no newline — a long message typed on
   * a phone shows as a bare `[Pasted text #5]`. Every rule here has to read
   * that as zero newlines rather than as no information.
   *
   * The placeholder is therefore an echo like any other, but it names no text,
   * so it is only accepted with a second fact tying it to THIS instruction: the
   * tail of the text on screen (the placeholder hides the head, so the tail is
   * what is still drawn), or a hidden-line count that accounts for essentially
   * all of it (the whole thing collapsed, nothing left to match). A stale
   * placeholder from an earlier, different paste satisfies neither.
   *
   * Only the NO-BOX fallback needs this spelled out here: when a composer frame
   * is found, `composerEcho` asks `screenEcho` of the frame's own contents and
   * the placeholder is one of the rules it already knows. So this takes the
   * rows `placeEcho` has already rendered rather than rendering again — the
   * whole point of the wider window is to pay for one replay, not two.
   */
  const pasteLines = text.split("\n").length;
  const tail = tailProbe(text);
  const pastedNearBottom = (rows: readonly string[]): boolean => {
    // Collapsible is LENGTH or shape, never shape alone: the composer collapses
    // anything past `PASTE_MIN_CHARS` whether or not it holds a newline, and
    // treating one-liners as exempt is what hid every long single-line send
    // behind a bare `[Pasted text #5]` — see `echo.ts`'s `PASTE_CHIT`.
    if (!pasteCollapsible(text) || !tail) return false;
    let hit = -1;
    for (let i = rows.length - 1; i >= 0; i--) if (PASTE_CHIT.test(rows[i])) { hit = i; break; }
    if (hit < 0) return false;
    if (rows.length - 1 - hit > composerRows) return false;
    // The whole run of chits, not the first one (`echo.ts`'s `pastedNewlines`):
    // one write is several pastes, and a chit wraps across rows (`+2` / `lines]`),
    // so the count is read off the joined rows down to the newest chit.
    const hidden = pastedNewlines(rows.slice(Math.max(0, hit - composerRows), hit + 1).join("")) ?? 0;
    if (hidden > pasteLines + 1) return false;        // far more than we ever wrote
    if (hidden >= pasteLines - 1) return true;        // it swallowed the lot
    return rows.join("").includes(tail);
  };
  /** The whole rendered screen as one string — the local-command submit proof. */
  const snapshot = async () => (await screenRows(40)).join("\n");
  /**
   * Wait for the echo, re-reading the rendered screen until it shows up.
   *
   * LOOKING again is free — it is RETYPING that stacks copies, and this never
   * writes. One look 500 ms after the write is what a mid-turn interjection
   * loses to: the composer of a working session redraws on the TUI's own
   * schedule (a spinner frame, a tool result, a token counter all take the
   * paint first), so the text is genuinely there and simply not on screen yet.
   * That read came back `"unconfirmed"` — the one verdict that is never
   * auto-retried — and the prompt was reported not delivered while sitting in
   * the composer of a session that was working fine.
   */
  const waitForEcho = async (ms: number) => {
    const deadline = Date.now() + ms;
    let heldSince: number | undefined;
    for (;;) {
      // `proven`, not merely "matched": a prefix hit that a rival could equally
      // have produced is not our echo, and keeps polling — the composer may
      // still finish drawing the rest of the text and upgrade the answer to
      // `exact`. If the window runs out on an ambiguous hit the delivery falls
      // through to the conversation log, which compares the WHOLE text and is
      // not confusable at all.
      //
      // WHICH rule answered is kept on the audit row: "the composer was a
      // viewport scrolled onto the tail" and "the placeholder stood in for the
      // whole paste" are different facts about what this CLI draws, and the
      // measurement that sent anyone looking here could only count the misses.
      const rule = await onScreen();
      // A proof by the no-box rule, for a backend whose reader CAN place its
      // composer, is held a moment for a framed one. Measured on 2.1.304: a
      // prompt typed just after the trust box closed was drawn bare at the
      // top of a cleared screen (the tty's echo, the CLI between frames — no
      // `❯`, no rules), the distance rule read that as `exact`, and the
      // composer drew it properly 400 ms later. The bare read is still
      // accepted if no frame ever comes (a stub, an unrecognised redraw), so
      // nothing that degraded to it before stops delivering.
      if (proven(rule) && fellBack && fullReader) {
        heldSince ??= Date.now();
        if (Date.now() - heldSince < FALLBACK_HOLD_MS && Date.now() < deadline) { await sleep(200); continue; }
      }
      if (proven(rule)) { shape.echo = rule; return true; }
      if (Date.now() >= deadline) { shape.echo = "none"; return false; }
      await sleep(200);
    }
  };
  return { screen, probe, placeEcho, proven, snapshot, waitForEcho, lastSeen: () => seen };
}

/** The row the NEWEST occurrence of `probe` starts on, searching the rows as
 *  one hard-wrapped line (squashed rows joined with nothing between); -1 if
 *  absent. Only for a screen with no composer box — see `placeEcho`. */
export function wrappedHit(rows: readonly string[], probe: string): number {
  if (!probe) return -1;
  const at = rows.join("").lastIndexOf(probe);
  if (at < 0) return -1;
  let off = 0;
  for (let i = 0; i < rows.length; i++) {
    off += rows[i].length;
    if (at < off) return i;
  }
  return -1;
}
