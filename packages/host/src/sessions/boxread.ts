/**
 * The choice box, READ and PUBLISHED: when to look for one (`scheduleChecks`,
 * `armPromptCheck`), reading it off the rendered screen (claude's numbered box in
 * `checkPrompt`, opencode's highlighted row in `checkNavBox`), putting the CLI's own
 * words on it (`enrichPrompt`), the "unparsable dialog" flag, the sign-in link and
 * `applyPrompt` — the one place a read box becomes `info.prompt`. Answering it is
 * `boxes.ts`. Stateless — every per-session fact lives on the `Session` record.
 * Reasoning: `waterplane-heuristics` (`prompt.ts`, `ocprompt.ts`, `askbox.ts`,
 * `login.ts`) and docs/notes/host-architecture.md.
 */
import { type DetectedPrompt, type PluginScreenReader } from "@waterplane/shared";
import { screenReaderFor } from "../backends/readers.js";
import { derive } from "../backends/derive.js";
import { detectPrompt, dialogStillUp, dialogEvidence, hasDialogFooter, isDialogFooterRow, MAX_BOX_OPTIONS, mergeBox, navToSubmit, sameBox, samePrompt, stripAnsi } from "../prompt.js";
import { asksFromCall, descFor, pendingAskQuestions, pendingAskRecord, pickAsk, recoverHead, type AskQuestion } from "../askbox.js";
import { isPlanBox, planPathFor, readPlan } from "../planbox.js";
import { detectLimitText, STOP_WAIT_RE } from "../limit.js";
import { detectLogin, loginCandidate, sameLogin, type DetectedLogin } from "../login.js";
import { logMtime, transcriptPath } from "../transcript.js";
import { recordSent } from "../sentlog.js";
import type { Session, SessionCore } from "./core.js";
import { healthTail, pause, safe } from "../boxkit.js";
import { PROMPT_CHECK_MS, PROMPT_MAX_STALE_MS, PROMPT_MISS_MAX, PROMPT_SETTLE_MS, RESIZE_REPAINT_MS, PROMPT_GATE_BYTES, PROMPT_CELL_ROWS, IDLE_PING_MS, HEALTH_SAMPLE_ROWS } from "./knobs.js";

/** How long the `askbox.enrich` fixture waits for the log to write the call: 2 min. */
const ASK_RECORD_POLLS = 60;
const ASK_RECORD_POLL_MS = 2_000;

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
  const reader = derive(s.backend).screen("dialogs");
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
  const nav = screenReaderFor(s.backend);
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
export function readTwice(s: Session, read: DetectedPrompt): boolean {
  const agreed = !!s.promptPending && samePrompt(s.promptPending, read);
  s.promptPending = agreed ? null : read;
  return agreed;
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
    // The log does not hold the call while its box is up on 2.1.304 (it is
    // written once answered); the `PreToolUse` hook carried it before the box.
    if (!asks.length && s.askHook) asks = asksFromCall(s.info.cwd, cid, s.askHook);
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
        raw: healthTail(screen, (l) => isDialogFooterRow(l), HEALTH_SAMPLE_ROWS),
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
  // A tick toggled on a checkbox box is the box being answered, not a new
  // question: the phone redraws it, nobody is pushed "needs you" per tap.
  const ticked = changed && samePrompt(prompt, s.info.prompt ?? null, "ignore");
  const had = !!s.info.prompt;
  if (changed) {
    s.info.prompt = prompt;
    // A numbered-choice suggestion answers THIS box; when the box goes, so
    // does it. (Output alone no longer clears either — see the data handler.)
    const sug = s.info.suggestion;
    if (!prompt && sug && sug.choice != null) s.info.suggestion = null;
    core.emit("updated", s.info);
    if (prompt && !ticked) core.emit("prompt", s.info.id, prompt);
    // A box became published where none was — the one edge on which the
    // choice-box detector has provably worked. Not on every `changed`: a box
    // whose cursor moves republishes several times while it is up, and the
    // question is "can this app still read a question box", asked once per
    // box. Not on every strict pass either, for the reason `enrichPrompt`
    // states.
    if (prompt && !had) {
      // The fixture is the screen the box was published off (`clifixtures.ts`).
      core.noteFor(s, "prompt.box", "good", { fixture: () => core.screenText(s.info.id) });
      // The enrichment rides on the same edge, from what the poll stashed.
      // `asks: 0` is not a miss (see `enrichPrompt`); the fallback is that the
      // phone shows the labels as the terminal cut them, with the paragraph
      // that explains them nowhere on the device.
      const e = s.enrich;
      if (e && e.asks > 0) {
        // The fixture is the LOG's record of the call, which 2.1.304 writes only
        // once the box is answered — so it is waited for (once per CLI version).
        if (e.matched) core.noteFor(s, "askbox.enrich", "good", { fixture: async () => {
          for (let i = 0; i < ASK_RECORD_POLLS; i++) {
            const rec = pendingAskRecord(s.info.cwd, s.info.claudeSessionId);
            if (rec) return rec;
            await pause(ASK_RECORD_POLL_MS);
          }
          return null;
        } });
        else core.noteFor(s, "askbox.enrich", "fallback", { via: "the labels as the terminal cut them", raw: e.labels });
      }
    }
  }
}



