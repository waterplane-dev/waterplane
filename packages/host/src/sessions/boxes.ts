/**
 * The choice box: when to look for one, reading it off the rendered screen
 * (claude's numbered box and opencode's highlighted row), publishing it, the
 * "unparsable dialog" fallback flag, the sign-in link that rides on the same
 * render, and the two answer walks that place a selection before pressing
 * Return. Stateless — every per-session fact lives on the `Session` record.
 * Reasoning: `waterplane-heuristics` (`prompt.ts`, `ocprompt.ts`, `askbox.ts`,
 * `login.ts`) and docs/notes/host-architecture.md.
 */
import { SOURCE_KEYS_MAX, type DetectedPrompt, type PluginScreenBox, type PluginScreenReader, type SourceKeys } from "@waterplane/shared";
import { screenReaderFor } from "../backends/readers.js";
import { detectPrompt, dialogStillUp, dialogEvidence, hasDialogFooter, isDialogFooterRow, MAX_BOX_OPTIONS, mergeBox, navToSubmit, readNavBox, sameBox, samePrompt, stripAnsi } from "../prompt.js";
import { descFor, pendingAskQuestions, pickAsk, recoverHead, type AskQuestion } from "../askbox.js";
import { isPlanBox, planPathFor, readPlan } from "../planbox.js";
import { detectLimitText, STOP_WAIT_RE } from "../limit.js";
import { detectLogin, loginCandidate, sameLogin, type DetectedLogin } from "../login.js";
import { logMtime, transcriptPath } from "../transcript.js";
import { recordSent } from "../sentlog.js";
import { rememberRule } from "../answergate.js";
import type { Session, SessionCore } from "./core.js";
import {
  PROMPT_CHECK_MS, PROMPT_MAX_STALE_MS, PROMPT_MISS_MAX, PROMPT_SETTLE_MS, RESIZE_REPAINT_MS, PROMPT_GATE_BYTES,
  SUBMIT_NAV_TRIES, SUBMIT_NAV_MAX_KEYS, SUBMIT_NAV_LINES, SUBMIT_NAV_SETTLE_MS, CHOOSE_NAV_TRIES,
  CHOOSE_NAV_SETTLE_MS, PROMPT_CELL_ROWS, IDLE_PING_MS, HEALTH_SAMPLE_ROWS,
} from "./knobs.js";

/**
 * The tail of a screen ending at the row a matcher was looking for.
 *
 * Anchored on the MATCHED row rather than sliced off the bottom, for the same
 * reason `deliver.ts` places its echo instead of taking the last N rows: the
 * bottom of a claude screen is the composer and the working line, and a sample
 * that shows those says nothing about the box above them.
 */
function healthTail(screen: string, anchor: (line: string) => boolean): string {
  const rows = screen.split("\n");
  let hit = -1;
  for (let i = rows.length - 1; i >= 0; i--) if (anchor(rows[i])) { hit = i; break; }
  if (hit < 0) hit = rows.length - 1;
  return rows.slice(Math.max(0, hit - HEALTH_SAMPLE_ROWS + 1), hit + 1).join("\n");
}

export function scheduleChecks(core: SessionCore, s: Session): void {
  if (s.idleTimer) clearTimeout(s.idleTimer);
  s.idleTimer = setTimeout(() => core.checkIdle(s), IDLE_PING_MS);
  // Output on a hooked session with no turn in flight: the hooks say nothing
  // is running, and the CLI may be working anyway (`/compact` announces
  // nothing, and a `Stop` a hook blocked leaves the turn going). One armed
  // timer, never restarted while a pass is already pending, and it costs a
  // regex over ONE repaint — see `checkTurnWatch`. A session with a turn the
  // hooks DO own is left to them.
  // Not while a backend's own channel reports EXACT turns: those boundaries are
  // exact by definition, and `workingLine` is claude's working line — pointed
  // at another TUI it could only ever match something else. A channel whose
  // ends are requests (`verifyEnds`: claude's hook pipe) keeps the watch.
  const exactTurns = !!s.channel?.turnsLive && !s.backend.sources?.turns?.verifyEnds;
  if (s.hooksActive && !exactTurns && !s.stopVerifyTimer && !s.turnActive) core.armTurnWatch(s);
  // The prompt check is a debounce with a CEILING. A pure debounce never fires
  // while a box is up — the TUI repaints its working line every second or so,
  // and each repaint pushed the check out again — which is exactly the state
  // that needs publishing. `PROMPT_MAX_STALE_MS` since the last check that
  // actually ran wins over the quiet window, so a repaint storm delays
  // verification by a bounded amount instead of for ever.
  // Measured from the start of THIS burst when the last check is older than the
  // ceiling itself: after a quiet spell the ceiling has long expired, and taking
  // it at face value fired the check at 0 ms on the burst's FIRST chunk — the
  // first chunk of a box tmux is still painting. (`readTwice` is what keeps a
  // half-painted read from being published; this only stops buying it.)
  const now = Date.now();
  const since = s.promptTimer || now - s.lastPromptCheckAt < PROMPT_MAX_STALE_MS ? s.lastPromptCheckAt : now;
  const ceiling = since + PROMPT_MAX_STALE_MS - now;
  armPromptCheck(core, s, Math.max(0, Math.min(PROMPT_CHECK_MS, ceiling)));
  // A shell's links and codes (`shelllinks.ts`) on the same quiet tick; a
  // session with turns never pays for that read.
  if (s.backend.caps.turns === false) core.armLinksCheck(s);
}

/** Arm the prompt check, EARLIEST-wins: a later caller may pull the check
 *  forward but never push a pending one back (that is what made the debounce
 *  starve under constant output). */
export function armPromptCheck(core: SessionCore, s: Session, delayMs: number): void {
  const due = Date.now() + delayMs;
  if (s.promptTimer && s.promptDueAt <= due) return;
  if (s.promptTimer) clearTimeout(s.promptTimer);
  s.promptDueAt = due;
  s.promptTimer = setTimeout(() => { s.promptTimer = null; checkPrompt(core, s); }, delayMs);
}

/**
 * Prompt detection runs in two stages. The cheap stage scans an ANSI-stripped
 * byte window — fast enough for a per-quiet-period check, but a repaint-based
 * TUI makes that window a shuffled, hole-punched approximation of the screen
 * (fragments joined across cursor jumps, words missing letters). So a hit is
 * only a CANDIDATE: it is re-detected against the RENDERED screen (headless VT
 * replay, what a user actually sees) and that result is what we publish. The
 * render is the expensive part, hence the gate — no candidate, no replay.
 *
 * Before this, garbled repaint fragments were surfaced verbatim as one-tap
 * option labels, and phantom prompts flickered in and out mid-answer.
 */
function checkPrompt(core: SessionCore, s: Session): void {
  if (!s.info.running) return;
  // A backend whose TUI draws no box this detector can read is a backend this
  // check has nothing to say about. Not armed at all, rather than armed and
  // publishing null: the strict stage costs a full VT replay per quiet period,
  // and — the part that matters more — the only way a claude-shaped rule can
  // "match" a screen it was never written for is by matching something else.
  // The sign-in link rides on this same render, which is the right place for
  // it too: a claude account's sign-in screen is not a fact about a binary
  // that has no claude account.
  const reader = s.backend.caps.promptBoxes;
  if (!reader) return;
  // The CLI's own channel is posing the dialogs: the screen reader stands down,
  // because two readers on one box re-key its fingerprint (a card re-opened, a
  // queued answer stale, a push). It comes back the moment the channel goes
  // down (`sidechannel.ts`), and it also stays off for a box the channel
  // published before it finished reconciling.
  if (screenReaderOff(s)) return;
  // Named readers, not a boolean: `prompt.ts`'s rules are claude's screen and
  // nothing else, so a second TUI gets its own reader rather than a looser
  // version of this one. See `backends/types.ts`.
  // A reader a plugin contributed (`backends/readers.ts`) — opencode's, for one.
  const nav = screenReaderFor(s.backend.caps);
  if (nav) { checkNavBox(core, s, nav); return; }
  if (reader !== "claude-numbered") return; // a contributed name whose plugin left: no reader, no box
  // A pane in copy-mode is showing HISTORY, not the live screen: the rendered
  // grid is wherever the user panned to, so an answered box scrolled back into
  // view would be re-detected as live — an approve bar over a dialog that no
  // longer exists, and an `awaitingInput` interlock on a session that is fine.
  // The pane is unchanged underneath; the next check after the pan back down
  // reads it. (`tmuxscroll.ts`.)
  if (s.copyMode) return;
  s.lastPromptCheckAt = Date.now();
  // Cheap stage runs LENIENT: the "❯" cursor and the Enter/Esc footer each sit
  // on their own row, and a repaint can leave them outside the byte window while
  // the option rows sit inside it. Demanding them here would drop a real prompt
  // before it ever reached the render — no approve bar, no push. Strictness
  // belongs on the rendered screen below, which is what gets published.
  // A dialog we could NOT parse is still a blocked session, and the reader view
  // has no terminal to notice it in — so the render is also paid for when the
  // tail merely carries a box FOOTER, and an unparsable box publishes the
  // weaker `awaitingInput` signal ("open the CLI") instead of nothing at all.
  // "esc to interrupt" is deliberately not in DIALOG_FOOTER_RE: that is the
  // TUI's working line, i.e. every busy session, i.e. a render per check.
  // The window is a few repaints wide, not one: this TUI redraws a full screen
  // in ~3 KB, and the footer is not the LAST thing it draws — a box whose
  // preview pane was painted after it fell outside a one-frame window entirely.
  // A regex over 12 KB every 600 ms of quiet costs nothing; missing the gate
  // costs the whole feature. Stale bytes here only buy a render whose STRICT
  // pass then publishes null, so a wide gate can't invent a phantom prompt.
  const rawTail = s.scrollback.slice(-PROMPT_GATE_BYTES);
  const tail = stripAnsi(rawTail);
  const candidate = !!detectPrompt(rawTail, { lenient: true });
  // A gate miss retires a prompt only when there is no PUBLISHED box to lose.
  //
  // "Only the strict verifier clears it" is the rule the miss counter below
  // exists to enforce, and this exit sat outside it. The gate reads a fixed
  // byte WINDOW, so a box whose own frame is a large fraction of that window —
  // six options with a wrapped description each — plus the repaints that follow
  // can push the footer out of view while the box is plainly still on screen,
  // and the panel vanished with no misses spent. With a box published we fall
  // through to the render and let the strict pass decide instead; a box that is
  // genuinely gone leaves a screen carrying no dialog footer, which clears it on
  // that same pass with no added latency.
  // A sign-in link opens the gate on its own shape: claude 2.1.293's sign-in
  // screen draws no dialog footer (`login.ts`'s `loginCandidate`).
  if (!candidate && !hasDialogFooter(tail) && !s.info.prompt && !s.info.login && !loginCandidate(rawTail, tail)) {
    s.promptGen++; // invalidates any render still in flight — the box is gone
    s.promptMisses = 0;
    s.promptPending = null;
    applyPrompt(core, s, null);
    setAwaiting(core, s, false);
    return;
  }
  if (s.promptRendering) return;
  s.promptRendering = true;
  const gen = s.promptGen;
  void core.screenText(s.info.id, 60)
    .then((screen) => {
      if (!s.info.running || s.promptGen !== gen) return;
      // The sign-in link rides on THIS render rather than paying for one of
      // its own: the gate above opens on the link's shape (`loginCandidate`),
      // so the replay is bought every time there is a link to find.
      applyLogin(core, s, detectLogin(screen, s.scrollback));
      const parsed = detectPrompt(screen);
      if (parsed) {
        s.promptMisses = 0;
        // One box stays ONE box while the TUI repaints under it. The strict
        // pass runs about twice a second and reads whatever is legible right
        // now — which the console refreshing itself, a pan, or a box taller
        // than the terminal all change — so a live question was re-published
        // several times a minute under a new fingerprint. That re-opened a
        // card the user had collapsed or hidden to answer at the desk, made
        // queued answers stale and fired a push per repaint. `sameBox` /
        // `mergeBox` in `prompt.ts` carry the reasoning; a box that is
        // genuinely different is published as itself.
        // The commit row's own word, off this same render — "Submit" on the
        // last question of an ask, "Next" on every one before it.
        const commit = parsed.multi ? navToSubmit(screen) : null;
        const read = commit ? { ...parsed, submitLabel: commit.label } : parsed;
        // Enriched BEFORE the comparison, not after: the enrichment is what
        // carries `askId`, and that is the only handle `sameBox` can trust on
        // the boxes that actually move.
        const fresh = enrichPrompt(s, read);
        const live = s.info.prompt;
        const next = live && sameBox(live, fresh) ? mergeBox(live, fresh) : fresh;
        // A box that is NEW, or that would change the published one, waits for
        // a second read that agrees — see `readTwice`. The published box (if
        // any) stays as it is meanwhile.
        if (samePrompt(next, live ?? null)) s.promptPending = null;
        else if (!readTwice(s, read)) { armPromptCheck(core, s, PROMPT_SETTLE_MS); return; }
        applyPrompt(core, s, next);
        setAwaiting(core, s, false);
        return;
      }
      // Nothing parsed — but a capture taken mid-repaint is a HALF-DRAWN box:
      // the option rows are there and the cursor row (or a label, or the
      // footer) is not yet redrawn. Publishing null on that is what made a
      // live dialog blink: the panel unmounted, the next capture parsed it
      // again, and around it went, about once a second. So while the screen
      // still carries a dialog footer, keep the box we already published and
      // count the miss; a box that is genuinely gone runs the counter out (or
      // takes the cheap gate's exit above, which needs no misses at all).
      // `dialogStillUp`, not merely "a footer is somewhere on this screen".
      // This CLI scrolls rather than repainting an alt screen, so an answered
      // box stays in the rendered tail for as long as the conversation takes
      // to push it out — and the loose test read that corpse as a live
      // question, which both kept the retired box published for its full miss
      // budget and raised `awaitingInput` on a session sitting at an idle
      // composer.
      s.promptPending = null; // agreement is between CONSECUTIVE reads
      const dialog = dialogStillUp(screen);
      /**
       * **A repaint WE asked for is not evidence the box is gone.**
       *
       * The phone's answer panel takes its space from the terminal, so
       * publishing a box shrinks the grid, which reports new rows, which is a
       * SIGWINCH, which makes this TUI clear and redraw everything. The
       * captures taken across that redraw are half-drawn — and they were being
       * counted as misses, three of them at `PROMPT_CHECK_MS` apart retired the
       * box, the panel unmounted, the grid grew back, another SIGWINCH, the box
       * parsed again, and the panel came back. A ~2 Hz blink that made a live
       * question unanswerable, and every part of it correct in isolation.
       *
       * The miss budget is for a screen we happened to catch mid-repaint. This
       * is a screen we KNOW is mid-repaint, because we are the ones who asked
       * for it — so it costs nothing and we simply look again. `dialogStillUp`
       * still gates it: a box genuinely gone during a resize leaves a screen
       * with no footer and is retired on this same pass, exactly as before.
       */
      if (s.info.prompt && dialog && Date.now() - s.lastResizeAt < RESIZE_REPAINT_MS) {
        armPromptCheck(core, s, PROMPT_CHECK_MS);
        return;
      }
      if (s.info.prompt && dialog && s.promptMisses < PROMPT_MISS_MAX) {
        s.promptMisses++;
        // Re-arm ourselves: checks are otherwise driven by output, and a box
        // that was answered at the DESK leaves a quiet screen behind — the
        // retained prompt would then never be re-verified at all.
        armPromptCheck(core, s, PROMPT_CHECK_MS);
        return;
      }
      s.promptMisses = 0;
      applyPrompt(core, s, null);
      setAwaiting(core, s, dialog, screen);
    })
    .catch(() => { /* render is best-effort; leave the last state alone */ })
    .finally(() => { s.promptRendering = false; });
}

/**
 * Has the screen read this box TWICE IN A ROW? A box is published only then.
 *
 * tmux hands its client a screen in CHUNKS, so a render taken between two of
 * them is a box painted down to some row and no further: options missing, the
 * last label cut mid-word ("Yes, and don't a"), the question short. With a
 * selection cursor on row 1 that half PARSES — strictly, correctly, as what is
 * legible — and publishing it is publishing a wrong box: the cut label is a
 * one-tap button, it is in `promptFingerprint`, and `mergeBox` never rewrites a
 * published label, so the cut stayed for the life of the box. Measured on the
 * first box of a session, where the paint follows a quiet spell and the check
 * fired on its first chunk (`scheduleChecks`'s ceiling), but nothing about it
 * is specific to the first.
 *
 * Nothing on a half-painted screen says it is half-painted, so completeness is
 * asked of TIME instead: two consecutive strict reads, `PROMPT_SETTLE_MS`
 * apart, that agree field for field (`samePrompt`, on the screen's own read
 * BEFORE enrichment — the log is not what is being proved). A read that
 * disagrees becomes the new candidate; any pass that reads no box clears it.
 * Costs one extra render and ~`PROMPT_SETTLE_MS` on a box's first appearance,
 * and nothing while it sits unchanged. Degrades to publishing nothing yet,
 * never to a box nobody drew.
 */
function readTwice(s: Session, read: DetectedPrompt): boolean {
  const agreed = !!s.promptPending && samePrompt(s.promptPending, read);
  s.promptPending = agreed ? null : read;
  return agreed;
}

/** A settle between a walk's keystroke and its re-read — the box walks' one wait. */
const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** A contributed reader's answer, or `fallback` when it threw: a throw reads as "no box". */
function safe<T>(fn: () => T, fallback: T): T {
  try { return fn(); } catch { return fallback; }
}

/**
 * The same two-stage check, for a TUI that draws its dialog a different way.
 *
 * Separate from `checkPrompt()` rather than a branch inside it, because the
 * two share the SHAPE (cheap byte gate → expensive replay → publish, with a
 * miss budget so a half-drawn repaint cannot retire a live box) and not one
 * single rule: opencode (the first such TUI) has no numbered rows, no `❯`, no
 * "Enter to confirm" footer and no scrollback, and every one of `prompt.ts`'s defences is written
 * against one of those. Folding them together would mean loosening rules that
 * exist because of a measured failure on the other screen.
 *
 * What it keeps, deliberately, is the blink fix: a box that stops parsing
 * while the anchor is still on screen costs a MISS, not a retirement, and a
 * repaint the host itself caused by publishing the box (the answer panel takes
 * its space from the terminal, which resizes the PTY, which makes the TUI
 * redraw) costs nothing at all.
 */
function checkNavBox(core: SessionCore, s: Session, reader: PluginScreenReader): void {
  if (s.copyMode) return;
  s.lastPromptCheckAt = Date.now();
  const tail = stripAnsi(s.scrollback.slice(-PROMPT_GATE_BYTES));
  if (!safe(() => reader.candidate(tail), false)) {
    // Nothing that could be a dialog in the window: retire whatever was
    // published with no misses spent, exactly as the claude gate does.
    s.promptGen++;
    s.promptMisses = 0;
    applyPrompt(core, s, null);
    setAwaiting(core, s, false);
    return;
  }
  if (s.promptRendering) return;
  s.promptRendering = true;
  const gen = s.promptGen;
  void core.screenCells(s.info.id, PROMPT_CELL_ROWS)
    .then((rows) => {
      if (!s.info.running || s.promptGen !== gen) return;
      const box = safe(() => reader.read(rows), null);
      const prompt = box ? safe(() => reader.prompt(box), null) : null;
      if (prompt) {
        s.promptMisses = 0;
        applyPrompt(core, s, prompt);
        setAwaiting(core, s, false);
        return;
      }
      // Unparsed. "Is the dialog still up" is the reader's own question about
      // its own TUI; a dialog still drawn spends a miss rather than retiring the box.
      const dialog = safe(() => reader.stillUp(rows), false);
      if (s.info.prompt && dialog && Date.now() - s.lastResizeAt < RESIZE_REPAINT_MS) {
        armPromptCheck(core, s, PROMPT_CHECK_MS);
        return;
      }
      if (s.info.prompt && dialog && s.promptMisses < PROMPT_MISS_MAX) {
        s.promptMisses++;
        armPromptCheck(core, s, PROMPT_CHECK_MS);
        return;
      }
      s.promptMisses = 0;
      applyPrompt(core, s, null);
      // A dialog whose ARMED option could not be read is still a blocked
      // session, and the phone has no terminal open in the reader view to
      // notice it in. `awaitingInput` is the honest signal for it — "something
      // is asking; open the CLI" — and it is what the phone renders the
      // sentence from rather than greying out a control nobody can explain.
      setAwaiting(core, s, dialog);
    })
    .catch(() => { /* render is best-effort; leave the last state alone */ })
    .finally(() => { s.promptRendering = false; });
}

/**
 * Answer an unnumbered box by placing the selection on the option the user
 * named, and only then pressing Return.
 *
 * The claude path sends the option's digit, which is a complete answer in one
 * keystroke. There are no digits here: the options are three words on a row
 * and the only thing that decides what Return does is which one is armed. So
 * this is `submitPromptBox()`'s loop with a different target — walk, RE-READ,
 * walk again — and the same reason for re-reading rather than counting: how
 * many options there are, whether the ends wrap and whether a keystroke was
 * swallowed by a repaint are all upstream details, and the screen is the only
 * thing that knows.
 *
 * **It refuses rather than guessing.** If the box stops being readable, or the
 * armed option never becomes the one that was asked for, no Return is pressed
 * and the receipt says so. A Return on the wrong row here is "Allow always" on
 * a command nobody approved — this is the failure the capability was false for
 * three months to avoid, and the walk existing does not make it acceptable to
 * fall back to a bare Return the way a checkbox box can.
 */
export async function choosePromptBox(core: SessionCore, id: string, choice: number): Promise<{ ok: boolean; reason?: string }> {
  const s = core.sessions.get(id);
  if (!s || !s.info.running) return { ok: false, reason: "session not available" };
  const reader = screenReaderFor(s.backend.caps);
  if (!reader) {
    if (s.backend.caps.promptBoxes === "claude-numbered" && s.info.prompt?.nav) return chooseClaudeNavBox(core, id, choice);
    return { ok: false, reason: "this backend's boxes are answered with a keystroke, not a selection" };
  }
  let box: PluginScreenBox | null = null;
  for (let i = 0; i < CHOOSE_NAV_TRIES; i++) {
    const rows = await core.screenCells(id, PROMPT_CELL_ROWS);
    box = safe(() => reader.read(rows), null);
    if (!box) return { ok: false, reason: "that question is no longer readable on screen" };
    if (box.armed === choice) break;
    const b = box;
    const nav = safe(() => reader.navTo(b, choice), null);
    if (!nav) return { ok: false, reason: `this box has ${box.options.length} options, not ${choice}` };
    // One key per pass. Overshooting is not self-correcting the way a
    // checkbox walk is — the list WRAPS, so a repaint that swallowed a
    // keystroke and one that did not are two different rings — and a single
    // step re-read is cheap next to pressing Return on the wrong option.
    if (!core.input(id, nav.dir === "right" ? "\x1b[C" : "\x1b[D")) {
      return { ok: false, reason: "session not available" };
    }
    await pause(CHOOSE_NAV_SETTLE_MS);
  }
  if (!box || box.armed !== choice) {
    return { ok: false, reason: "could not place the selection on that option — answer it in the terminal" };
  }
  // Nothing is written to the audit log here, for the same reason the claude
  // answer path writes nothing: `sentlog.ts` records SENDS, and an answer to a
  // box is a keystroke aimed at a question the session already published. The
  // one exception in this file stays the exception — the usage-limit menu is
  // answered on the user's behalf and never shown, so the log is the only
  // place it is visible at all.
  return { ok: core.input(id, "\r") };
}

/**
 * The same walk for claude's own UNNUMBERED box (2.1.293's first-launch trust
 * box, `prompt.ts`'s `readNavBox`): the rows are a vertical list, so Up/Down
 * rather than Left/Right, one key per pass and a RE-READ between, and Return
 * only once the "❯" is on the option asked for.
 *
 * Not a digit, though the old numbered trust box took one: nothing measured
 * says a digit answers this box, and a digit that does not is a stray
 * character in the composer of the session it lets in. The arrows are what
 * the box's own footer offers.
 *
 * Refuses rather than guessing, as the reader's walk does — and also when the
 * box on screen no longer carries the label that was tapped at that index:
 * that is a different box, and "Yes" by position on it is a guess.
 */
async function chooseClaudeNavBox(core: SessionCore, id: string, choice: number): Promise<{ ok: boolean; reason?: string }> {
  const want = core.sessions.get(id)?.info.prompt?.options.find((o) => o.index === choice)?.label;
  let cursor = 0;
  for (let i = 0; i < CHOOSE_NAV_TRIES; i++) {
    const read = readNavBox(await core.screenText(id, 60));
    if (!read) return { ok: false, reason: "that question is no longer readable on screen" };
    const target = read.prompt.options.find((o) => o.index === choice);
    if (!target) return { ok: false, reason: `this box has ${read.prompt.options.length} options, not ${choice}` };
    if (want !== undefined && target.label !== want) {
      return { ok: false, reason: "the box on screen is not the one that was answered — answer it in the terminal" };
    }
    cursor = read.cursor;
    if (cursor === choice) break;
    if (!core.input(id, choice > cursor ? "\x1b[B" : "\x1b[A")) return { ok: false, reason: "session not available" };
    await pause(CHOOSE_NAV_SETTLE_MS);
  }
  if (cursor !== choice) {
    return { ok: false, reason: "could not place the selection on that option — answer it in the terminal" };
  }
  return core.input(id, "\r") ? { ok: true } : { ok: false, reason: "session not available" };
}

/** Is the published box the side channel's, or is the channel reconciled and
 *  owning every box? Either way the screen has nothing to add. */
export function screenReaderOff(s: Session): boolean {
  const ch = s.channel;
  if (!ch || ch.closed) return false;
  if (!!ch.published && s.info.prompt?.askId === ch.published) return true;
  // A dialog the channel can see but cannot pose (opencode's `question` tool, whose answer
  // route nobody measured) reaches the phone through the screen or not at all: the reader
  // keeps its duty — and so does `awaitingInput` behind it — while one is open.
  return ch.dialogsLive && !ch.unposed;
}

/**
 * **The one answer dispatcher** — every answer to a choice box goes through
 * here: the phone's tap (`routes/session.ts`, a digit or a `promptChoice`) and
 * anything the answer gate let through (`answergate.ts`). Three rungs, in order:
 *
 *  1. the box is a dialog the CLI posed on its OWN channel ⇒ answered there
 *     (`SourceDialog.answer`), nothing typed into the PTY — unless the source
 *     answers `{ keys }` (its dialog moved into its TUI): then exactly those
 *     keys, bounded by `sourceKeysProblem`, typed by `typeSourceKeys` into this
 *     session through `core.input`, the path a digit tap takes;
 *  2. the box has no numbers (`nav`), or the caller asked for a walk ⇒
 *     `choosePromptBox`, which refuses rather than pressing a blind Return;
 *  3. otherwise the digit and a Return, which is what a tap always sent.
 *
 * **While the channel owns the dialogs, a box it does not know is not answered
 * by guessing.** A dialog the channel resolved a moment ago (answered at the
 * desk, withdrawn) leaves nothing to type at — the screen walk would read a box
 * that is gone and the digit would land in the composer — so it refuses in
 * words, as the gate refuses, with nothing written.
 *
 * Without `sources` none of rung 1 or the refusal can apply (`s.channel` is
 * absent) and this is exactly the two calls the route and the gate made before.
 */
export async function answerBox(core: SessionCore, id: string, choice: number, opts: { walk?: boolean; byPerson?: boolean } = {}): Promise<{ ok: boolean; reason?: string }> {
  const s = core.sessions.get(id);
  if (!s || !s.info.running) return { ok: false, reason: "session not available" };
  const p = s.info.prompt ?? null;
  const ch = s.channel && !s.channel.closed ? s.channel : null;
  const sourceOwned = !!ch && !!p?.askId && p.askId === ch.published;
  // A screen-read box while the channel reports a dialog it cannot pose is the screen's to
  // answer (the walk below), never refused as "not the channel's".
  if (sourceOwned || (ch?.dialogsLive && !ch.unposed)) {
    const d = p?.askId ? ch!.dialogs.get(p.askId) : undefined;
    if (!p || !d) return { ok: false, reason: "that question is no longer open — it was answered or withdrawn" };
    if (!Number.isInteger(choice) || !d.options.some((o) => o.index === choice)) {
      return { ok: false, reason: `${choice} is not one of the box's options` };
    }
    // Read BEFORE answering: a source may re-word its options once answered (they are its own).
    const remember = d.options.find((o) => o.index === choice)?.remember;
    let r: { ok: boolean; reason?: string } | SourceKeys;
    try {
      r = await d.answer(choice);
    } catch (e) {
      return { ok: false, reason: `the CLI's own channel did not take that answer (${(e as Error)?.message || String(e)})` };
    }
    const done = r && typeof r === "object" && "keys" in r
      ? typeSourceKeys(core, id, d.id, r.keys)
      : r?.ok ? { ok: true } : { ok: false, reason: r?.reason || "the CLI's own channel did not take that answer" };
    // A PERSON chose an option the source marked `remember`: the host keeps that standing rule
    // (`answergate.ts`), keyed by the plugin that registered this backend — the owner of the source.
    // Only the phone's route sets `byPerson` — a gated answer never makes one.
    if (done.ok && opts.byPerson && remember) rememberRule({ sessionId: id, plugin: s.backend.plugin, backend: s.backend.id, key: remember.key, label: remember.label });
    return done;
  }
  if (opts.walk || p?.nav) return choosePromptBox(core, id, choice);
  const ok = core.input(id, `${choice}\r`);
  return ok ? { ok } : { ok, reason: "session not available" };
}

/** The control keys a source may ask for — exactly the ones a box walk presses. */
const SOURCE_CONTROL_KEYS = ["\x1b[A", "\x1b[B", "\x1b[C", "\x1b[D", "\r", "\x1b"] as const;

/**
 * Why `keys` is not something a source may have typed, or null when it may.
 *
 * At most `SOURCE_KEYS_MAX` keys, each a printable character or one of
 * `SOURCE_CONTROL_KEYS` (longest first, so an arrow is one key and not an
 * Escape plus two characters). Anything else — a control character, a
 * bracketed paste, a prompt's worth of text — is not an answer to a box.
 */
export function sourceKeysProblem(keys: unknown): string | null {
  if (typeof keys !== "string" || keys.length === 0) return "it asked for no keystrokes";
  let n = 0;
  for (let i = 0; i < keys.length; n++) {
    const ctl = SOURCE_CONTROL_KEYS.find((k) => keys.startsWith(k, i));
    if (ctl) { i += ctl.length; continue; }
    const cp = keys.codePointAt(i)!;
    if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) {
      return `it asked for a control character (0x${cp.toString(16).padStart(2, "0")}) that is not Return, Escape or an arrow`;
    }
    i += cp > 0xffff ? 2 : 1;
  }
  if (n > SOURCE_KEYS_MAX) return `it asked for ${n} keystrokes, and a box is answered with at most ${SOURCE_KEYS_MAX}`;
  return null;
}

/**
 * A source's `{ keys }`: its dialog is now in its own TUI and is answered by
 * keystrokes. Typed HERE — the core's raw-input path, the same `core.input` a
 * digit tap takes — into THIS session only, once, and only while the dialog
 * that asked is still one the channel has open. A source has no way to call
 * this but by answering a dialog `answerBox` put to it.
 */
function typeSourceKeys(core: SessionCore, id: string, dialogId: string, keys: unknown): { ok: boolean; reason?: string } {
  const why = sourceKeysProblem(keys);
  if (why) return { ok: false, reason: `the CLI's own channel answered with keystrokes this host will not type — ${why}` };
  const s = core.sessions.get(id);
  const ch = s?.channel;
  if (!s || !s.info.running) return { ok: false, reason: "session not available" };
  if (!ch || ch.closed || !ch.dialogs.has(dialogId)) {
    return { ok: false, reason: "that question is no longer open — it was answered or withdrawn" };
  }
  const ok = core.input(id, keys as string);
  return ok ? { ok } : { ok, reason: "session not available" };
}

/**
 * Put the CLI's OWN words on the box we scraped.
 *
 * `AskUserQuestion` writes its question and every option's full description
 * into the conversation log before anyone answers, and the screen is where
 * that text goes to die: descriptions are cut at the right edge and again by
 * the preview pane, and a box with six of them is taller than a phone's
 * terminal, so the question row is not on screen at all. A one-tap button
 * reading "A + B + C" with the paragraph explaining it nowhere on the device
 * is a button you cannot honestly press — which is the actual complaint
 * behind "I need to see the question".
 *
 * Enrichment is additive and identity-neutral: `desc`/`ask`/`truncated` are
 * outside `promptFingerprint` on purpose, so a description that arrives one
 * check late cannot invalidate an answer already queued against the box.
 * Matching is by LABEL, never by index — the TUI appends its own rows ("Type
 * something.", "Chat about this") after the tool's, and on a truncated box the
 * visible run starts above 1.
 *
 * Cached on the log's mtime: the strict pass runs about twice a second while a
 * box is up and the log does not move in that time, so this costs one `stat`
 * per check and a tail read per turn.
 */
function enrichPrompt(s: Session, p: DetectedPrompt): DetectedPrompt {
  // The health verdict is STASHED, not recorded: this runs on every strict
  // pass, about twice a second while a box is up, and `applyPrompt` owns the
  // one edge where a box genuinely becomes published. Cleared first, so a
  // path that returns early below leaves no stale answer behind for that edge
  // to record — "the log could not be asked" is not an observation about the
  // matcher.
  s.enrich = null;
  const cid = s.info.claudeSessionId;
  if (!cid) return p;
  // A plan approval is never an `AskUserQuestion`, so it is done and returned
  // here: the card gets the plan it is asking about, or nothing extra.
  if (isPlanBox(p.ask ?? p.question)) {
    const plan = pendingPlanFor(s, cid);
    return plan ? { ...p, plan } : p;
  }
  let asks: AskQuestion[];
  try {
    const mtime = logMtime(transcriptPath(s.info.cwd, cid)) ?? 0;
    if (s.askCache && s.askCache.mtime === mtime) asks = s.askCache.asks;
    else {
      asks = pendingAskQuestions(s.info.cwd, cid);
      s.askCache = { mtime, asks };
    }
  } catch { return p; }
  const labels = p.options.map((o) => o.label);
  // The UNIQUE best match, never the first that overlaps: one
  // `AskUserQuestion` may carry several questions and two of them sharing a
  // pair of labels ("Yes"/"No") is ordinary, so `find` handed back question 1
  // for a screen showing question 2 — and with it question 1's `askId`, its
  // descriptions and its first options as a "recovered" head a digit would
  // select. A tie now enriches nothing. See `pickAsk`.
  const ask = pickAsk(asks, labels);
  // Only a box the log HAS a pending question for can say anything about this
  // matcher. A tool approval or a trust dialog carries no `AskUserQuestion` at
  // all, so `asks` is legitimately empty and counting that as a miss would
  // report the commonest box in the app as a broken parse.
  s.enrich = { asks: asks.length, matched: !!ask, labels: labels.join("\n") };
  if (!ask) return p;
  const options = p.options.map((o) => {
    const desc = descFor(ask, o.label);
    return desc ? { ...o, desc } : o;
  });
  // A box taller than the terminal scrolled its own first options away. The
  // log has them, and their indices are the TUI's own — see `recoverHead`,
  // which refuses unless the two lists can be proved to line up. Recovered,
  // the card is no longer missing buttons, so `truncated` (which SAYS options
  // are unreachable from here) goes with them.
  const head = recoverHead(ask, p.options);
  if (head) {
    const recovered = head.map((o, i) => ({ index: i + 1, label: o.label, ...(o.desc ? { desc: o.desc } : {}) }));
    const { truncated: _cut, ...rest } = p;
    // Capped like the merge, and from the same end: the recovered head is the
    // part nobody can see on the terminal, so the tail is what gives way.
    const all = [...recovered, ...options].slice(0, MAX_BOX_OPTIONS);
    return { ...rest, options: all, ask: ask.question, askId: ask.id };
  }
  return { ...p, options, ask: ask.question, askId: ask.id };
}

/**
 * The plan file behind a plan-approval box (`planbox.ts`), cached on the log's
 * mtime and the file's: the strict pass runs about twice a second while the box
 * is up, and neither moves in that time unless somebody edits the plan.
 */
function pendingPlanFor(s: Session, cid: string): DetectedPrompt["plan"] | undefined {
  try {
    const logM = logMtime(transcriptPath(s.info.cwd, cid)) ?? 0;
    const c = s.planCache;
    const path = c && c.logMtime === logM ? c.path : planPathFor(s.info.cwd, cid);
    const fileM = path ? logMtime(path) ?? 0 : 0;
    if (c && c.logMtime === logM && c.path === path && c.fileMtime === fileM) return c.plan ?? undefined;
    const plan = path && fileM ? readPlan(path) : null;
    s.planCache = { logMtime: logM, path, fileMtime: fileM, plan };
    return plan ?? undefined;
  } catch { return undefined; }
}

/** Publish the "unparsable dialog on screen" fallback flag. */
export function setAwaiting(core: SessionCore, s: Session, on: boolean, screen?: string): void {
  if (!!s.info.awaitingInput === on) return;
  s.info.awaitingInput = on || undefined;
  core.emit("updated", s.info);
  // Same reason the parsed prompt notifies: a blocked session is silent, so
  // nothing else would ever tell you. Fires on the ON transition only.
  if (on) core.emit("awaiting", s.info.id);
  // …which is nearly the edge the health record wants, and the "nearly" is
  // the whole correction. Raising this flag means "a dialog footer is on that
  // screen and no box parsed above it" — but the flag is an INTERLOCK, and its
  // rule is deliberately loose because a false wait is cheap and typing into a
  // live question box is not. A CLAIM ABOUT THE DETECTOR has the opposite
  // error cost, so it needs the stricter question: was a box actually up?
  //
  // On the live host it was not. A claude session displaying our own prose
  // about this very detector put "Esc to cancel" on screen inside a sentence,
  // the cheap gate fired, the strict pass correctly refused to read a
  // paragraph as a box — and that CORRECT REFUSAL was filed as a miss. Four in
  // nine, i.e. a working detector reporting 44% failure, which is how a board
  // teaches the person reading it to stop reading it.
  //
  // So: an observation is only a miss if the primary rule was the RIGHT RULE
  // and failed. `dialogEvidence` is what says it was — a footer row the CLI
  // painted, plus a cursor or option rows above it. No box, no observation:
  // not a `good` either, because nothing here has been seen to work, and a
  // `good` per correct refusal would fill the twenty-slot window with
  // successes and bury the misses that matter.
  if (on && screen) {
    const ev = dialogEvidence(screen);
    if (ev.box) {
      core.noteFor(s, "prompt.box", "fallback", {
        via: "the weaker “something is asking you something” flag",
        raw: healthTail(screen, (l) => isDialogFooterRow(l)),
      });
    }
  }
}

/**
 * Publish (or retire) the sign-in link this session is showing.
 *
 * Same shape as `applyPrompt` and for the same reason: this runs about twice
 * a second while the login screen is up, and a `session.list` broadcast per
 * repaint would be one per repaint. `at` is stamped when the URL first
 * appears and kept while it is the same URL, because a login link expires and
 * "how old is this" is the difference between a page that signs you in and a
 * page that refuses.
 */
function applyLogin(core: SessionCore, s: Session, login: DetectedLogin | null): void {
  const had = s.info.login ?? null;
  if (sameLogin(had, login)) return;
  if (!login) {
    s.info.login = null;
  } else {
    s.info.login = { ...login, at: had && had.url === login.url ? had.at : Date.now() };
  }
  core.emit("updated", s.info);
}

export function applyPrompt(core: SessionCore, s: Session, prompt: DetectedPrompt | null): void {
  // The usage-limit menu is owned by auto-continue, not the normal prompt
  // flow: take its stop-and-wait option ourselves and never surface it (no
  // push, no plugin event) — the scheduled continue does the rest. With
  // auto-continue off it stays a normal prompt (the badge still shows).
  const stopWait = prompt?.options.find((o) => STOP_WAIT_RE.test(o.label));
  if (prompt && stopWait) {
    const scan = stripAnsi(s.scrollback.slice(-6000));
    const det = detectLimitText(scan);
    core.markLimitBlocked(s, det.resetAt, det.weekly, scan.slice(-600));
    if (core.limitAuto(s)) {
      if (s.info.prompt) { s.info.prompt = null; core.emit("updated", s.info); }
      s.proc.write(String(stopWait.index) + "\r");
      // This menu is answered on the user's behalf and then never shown, so
      // the audit log is the ONLY place it is visible at all.
      recordSent({
        sessionId: s.info.id, actor: "auto", source: "limit", kind: "answer",
        text: String(stopWait.index), result: "written",
        detail: `took the usage-limit menu's "${stopWait.label}"`,
      });
      return;
    }
  }
  // A box IS the question, with buttons. Publishing both would put the same
  // ask on the row twice and in two different wordings.
  if (prompt) core.setAsking(s, null);
  // Field by field (`samePrompt`), never `JSON.stringify`: that also compares
  // KEY ORDER, and `mergeBox` builds its object in its own order, so the pass
  // after every merge reported a change for a card that had not moved — one
  // broadcast, one push and one plugin event per box, bought with nothing.
  const changed = !samePrompt(prompt, s.info.prompt ?? null);
  const had = !!s.info.prompt;
  if (changed) {
    s.info.prompt = prompt;
    // A numbered-choice suggestion answers THIS box; when the box goes, so
    // does it. (Output alone no longer clears either — see the data handler.)
    const sug = s.info.suggestion;
    if (!prompt && sug && sug.choice != null) s.info.suggestion = null;
    core.emit("updated", s.info);
    if (prompt) core.emit("prompt", s.info.id, prompt);
    // A box became published where none was — the one edge on which the
    // choice-box detector has provably worked. Not on every `changed`: a box
    // whose cursor moves republishes several times while it is up, and the
    // question is "can this app still read a question box", asked once per
    // box. Not on every strict pass either, for the reason `enrichPrompt`
    // states.
    if (prompt && !had) {
      core.noteFor(s, "prompt.box", "good");
      // The enrichment rides on the same edge, from what the poll stashed.
      // `asks: 0` is not a miss (see `enrichPrompt`); the fallback is that the
      // phone shows the labels as the terminal cut them, with the paragraph
      // that explains them nowhere on the device.
      const e = s.enrich;
      if (e && e.asks > 0) {
        if (e.matched) core.noteFor(s, "askbox.enrich", "good");
        else core.noteFor(s, "askbox.enrich", "fallback", { via: "the labels as the terminal cut them", raw: e.labels });
      }
    }
  }
}


/**
 * Press Return on a checkbox box's **Submit row**, walking the selection
 * cursor there first.
 *
 * A multi-select `AskUserQuestion` is answered by toggling rows and then
 * confirming on a Submit row that carries no index — so the phone's Submit
 * button, which sent a bare Return, pressed it wherever the cursor happened to
 * be: on option 1, where the box starts, that RE-TOGGLES the option and leaves
 * the box open. The box is never answered and the row the user did pick is
 * silently un-picked.
 *
 * Driven off the RENDERED screen rather than a count of rows we believe are
 * there (`navToSubmit`), and re-read between moves: whether a digit key also
 * moves the cursor, and whether the ends of the list wrap, are both upstream
 * details we would otherwise be encoding a guess about. Overshooting is
 * self-correcting — the next pass just walks back — so the loop converges
 * where an open-loop "press Down N times" would land on the wrong row.
 *
 * Falls back to the bare Return whenever the screen shows no Submit row or no
 * cursor (a box taller than the terminal can have scrolled either off): that
 * is exactly what this call did before, and guessing a direction from half a
 * box would toggle a row nobody chose.
 */
export async function submitPromptBox(core: SessionCore, id: string): Promise<{ ok: boolean; placed: boolean }> {
  const s = core.sessions.get(id);
  if (!s || !s.info.running || !s.info.remoteControl) return { ok: false, placed: false };
  let placed = false;
  /** Did the screen ever yield a Submit row AND a cursor? The two failures are
   *  different facts: "the box is not readable at all" is the fallback this
   *  signal is named for, while "readable but the walk never converged" is a
   *  navigation miss. Collapsing them would report an unreadable screen as a
   *  broken walk. */
  let readable = false;
  /** Kept for the sample: the screen the last decision was taken on. */
  let seen = "";
  for (let i = 0; i < SUBMIT_NAV_TRIES; i++) {
    seen = await core.screenText(id, SUBMIT_NAV_LINES);
    const nav = navToSubmit(seen);
    if (!nav) break;
    readable = true;
    if (nav.steps === 0) { placed = true; break; }
    const key = nav.steps > 0 ? "\x1b[B" : "\x1b[A";
    if (!core.input(id, key.repeat(Math.min(Math.abs(nav.steps), SUBMIT_NAV_MAX_KEYS)))) {
      return { ok: false, placed: false };
    }
    await pause(SUBMIT_NAV_SETTLE_MS);
  }
  // One observation per answered box — this is a user's tap, not a poll.
  // `placed` is the only outcome in which the Return that follows means
  // "submit"; without it the keystroke toggles whatever row the cursor sat on,
  // which is the bug this whole method exists to fix.
  // Both words the commit row is drawn with — see `prompt.ts`'s
  // `SUBMIT_ROW_RE`. Anchored, so a sentence containing "next" is not a row.
  const tail = healthTail(seen, (l) => /^\s*\S?\s*(Submit|Next)\s*$/.test(l));
  if (placed) core.noteFor(s, "prompt.submit", "good");
  else if (readable) core.noteFor(s, "prompt.submit", "miss", { raw: tail });
  else core.noteFor(s, "prompt.submit", "fallback", { via: "a bare Return", raw: tail });
  return { ok: core.input(id, "\r"), placed };
}
