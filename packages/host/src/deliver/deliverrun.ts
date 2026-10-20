/**
 * `runDelivery` — the one delivery, from its health gate to the echo verdict;
 * moved out of `deliver.ts`, which stays the facade and the only way in
 * (docs/notes/host-architecture.md, "The deliver slices"). Its last statement
 * hands the rest — the settle and the submit ladder — to `deliverreturn.ts`.
 */
import type { SessionManager } from "../sessions.js";
import type { DeliveryShape, HistoryEntry } from "@waterplane/shared";
import { fixtureWanted, noteHealth } from "../clihealth.js";
import { asksYesNo } from "../shelllinks.js";
import { readNavBox, trustKeys } from "../prompt.js";
import { ROW_WINDOW, composerFramesAmbiguous } from "../echo.js";
import { isLocalCommand, startsNoTurn, worksUnannounced } from "../slash.js";
import { CHANNEL_CONNECT_WAIT_MS, ECHO_WAIT_MS, PROMPT_HOOK_WAIT_MS, sleep } from "./deliverknobs.js";
import type { DeliverOpts, DeliveryResult } from "./delivertypes.js";
import { composerHoldsOnlyHint, foreignInComposer, makeScreenReader } from "./deliverscreen.js";
import { makeLogProof, makeSubmitProof } from "./deliverproof.js";
import { hasTurns, submitAndConfirm } from "./deliverreturn.js";

/**
 * The delivery itself. Returns the verdict AND, where the verdict needs one, the
 * sentence that explains it — which then rides into the audit log rather than
 * being lost. A `retry` that means "the session never became ready" and a
 * `retry` that means "this session's composer already holds text I cannot tell
 * apart from yours" are the same enum and completely different events.
 */
export async function runDelivery(
  sessions: SessionManager,
  sessionId: string,
  text: string,
  historyKind: HistoryEntry["kind"],
  opts: DeliverOpts,
  key: string,
  shape: DeliveryShape,
): Promise<{ result: DeliveryResult; detail?: string }> {
  /**
   * File one health observation about THIS delivery — or file nothing, when the
   * session's backend is outside the health record's scope.
   *
   * **A data plumb, not a delivery rule.** Every `noteHealth` call in this file
   * goes through here and nothing else changes: the same observations, in the
   * same places, on the same conditions, for every session the record already
   * covered. What it adds is the gate `sessions/` has had at its own ten call
   * sites (`noteFor`, `sessions/health.ts`) and this file never got — so a confirmed delivery into an
   * opencode session stopped filing a `deliver.submit fallback` (that backend is
   * never hooked, so its submit proof is always press-and-look), a missed echo
   * stopped filing a `deliver.echo miss`, and `slash.local` stopped firing on a
   * binary whose slash vocabulary this app has never measured. Rules that were
   * never the right rules for that backend record NOTHING — not a miss, because
   * they correctly declined to fire, and not a `good` either, because nothing
   * was seen to work.
   *
   * A local const rather than ten inline guards, for the reason
   * `clihealth.ts` gives for its own singleton: call site eleven forgets.
   */
  const note: typeof noteHealth = (id, outcome, o) => {
    if (!sessions.healthScope(sessionId)) return;
    // Every `deliver.submit` good, wherever it is filed, can carry the one
    // input that proves a submit on a hooked session: the `UserPromptSubmit`
    // payload, kept as a skeleton (`clifixtures.ts`). Any other proof — a turn
    // boundary, the screen — leaves nothing to keep.
    if (id === "deliver.submit" && outcome === "good" && !o?.fixture) {
      o = { ...o, fixture: () => {
        const h = sessions.lastHook(sessionId) as { hook_event_name?: unknown } | undefined;
        return h?.hook_event_name === "UserPromptSubmit" ? JSON.stringify(h) : null;
      } };
    }
    noteHealth(id, outcome, o);
  };
  /**
   * The `deliver.echo` fixture: the composer AS the echo was seen in it. Read
   * here, before the Return clears it, and so only while one is wanted — once
   * per CLI version (`fixtureWanted`), never per delivery.
   */
  const echoFixture = async () => {
    if (!sessions.healthScope(sessionId) || !fixtureWanted("deliver.echo")) return {};
    // The screen the echo rule PROVED on, as drawn — not a fresh read (on
    // 2.1.304 a read a moment later held a half-repainted frame, or one with
    // no echo in it) and not `snapshot()`, which squashes the spaces a
    // fixture's layout is read by.
    const grid = lastSeen() || await sessions.screenText(sessionId, 40);
    return { fixture: () => JSON.stringify({ prompt: text, grid }) };
  };
  /** When this delivery began — the recency floor every log lookup below is
   *  matched against, so an identical prompt fired at the same session this
   *  morning can never be mistaken for proof about this one. */
  const startedAt = Date.now();
  const shell = !hasTurns({ sessions, sessionId });
  const { screen, probe, placeEcho, proven, snapshot, waitForEcho, lastSeen } = makeScreenReader(sessions, sessionId, text, key, shape, { firstLineProbe: shell && /[\r\n]/.test(text) });
  const ranAnyway = makeLogProof(sessions, sessionId, text, startedAt, key);
  const proof = makeSubmitProof(sessions, sessionId, text, startedAt);
  const { armSourceProof, proofKind, submitProofWithin } = proof;

  /**
   * Best-effort empty the composer. ctrl-U kills ONE line and an instruction
   * wraps over several, so press it repeatedly. Only meaningful when we can
   * SEE the text — otherwise there is nothing to verify against.
   */
  const clearComposer = async (esc = true) => {
    // The Esc is for a view COVERING the composer. Never send it for a local
    // command: the view it would close is the one the command just opened, and
    // the user asked for that view.
    if (esc) {
      sessions.write(sessionId, "\x1b"); // Esc: close any open view/overlay
      await sleep(150);
    }
    for (let i = 0; i < 6; i++) {
      sessions.write(sessionId, "\x15"); // ctrl-U: kill one input line
      await sleep(120);
    }
  };

  // A TUI-local command (`/cost`, `/context`, `/resume`, …) opens a view instead
  // of running a turn, so both halves of the submit contract change below.
  //
  // **Two booleans, because they are two facts.** `noTurn` is the wider one and
  // the one the submit contract hangs off: no `UserPromptSubmit`, so no
  // turn-start proof, and nothing in the conversation log either way. `local` is
  // the narrower "this opened a VIEW", and it is asked exactly once — by the
  // composer sweep, whose Esc would close the view the command just opened.
  // `/btw` is the command that made the difference real: it submits, files a
  // note and clears the box, opening nothing, so it needs the submit contract
  // and must NOT be spared the Esc. (`shared/slash.ts` carries the rest.)
  const local = isLocalCommand(text);
  const noTurn = startsNoTurn(text);
  // …and the third fact, narrower than both: this SUBMITS and does a turn's
  // worth of work while announcing none of it (`/compact`). The echo contract
  // is the ordinary one — the words go in the composer like any prompt — and
  // only the submit proof changes, at the bottom of this function.
  const unannounced = worksUnannounced(text);

  /**
   * **The side channel's hold** (design §2, "channel down ⇒ sends are held").
   * A backend whose TUI SWALLOWS a prompt typed while its own server is gone
   * (`delivery.requiresChannel` — opencode attached to a dead `serve`, spike §9:
   * the box clears, nothing runs, nothing on screen says so) is not typed into
   * while that channel is down: `retry` — provably nothing typed, so the queue
   * may send it again — with the SENTENCE, never a blind write. A channel still
   * CONNECTING (a session seconds old) is waited for, briefly; one that was up
   * and dropped, or failed, holds at once. Not a lane state and not a fork of
   * this ladder: one question asked before anything is typed.
   */
  const channelHold = async (): Promise<string | null> => {
    const deadline = Date.now() + CHANNEL_CONNECT_WAIT_MS;
    for (;;) {
      if (!sessions.get(sessionId)?.running) return null; // the not-running paths answer that
      const hold = sessions.sendHold?.(sessionId) ?? null; // a test double may not have it
      if (!hold) return null;
      if (!hold.connecting || Date.now() >= deadline) return hold.sentence;
      await sleep(250);
    }
  };
  {
    const held = await channelHold();
    if (held) return { result: "retry", detail: held };
  }

  // Readiness. Two different questions — see `DeliverOpts.interactive`.
  if (opts.interactive) {
    // Only "is the TUI mid-draw?", never "is the agent busy?". A person typing
    // at a working agent is interjecting on purpose; the composer holds the line
    // until the turn ends, which is exactly what they asked for.
    let settled = false;
    for (let i = 0; i < 40 && !settled; i++) {
      if (!sessions.get(sessionId)?.running) return { result: "retry" };
      if ((sessions.idleMs(sessionId) ?? 0) >= 250) settled = true;
      else await sleep(150);
    }
    // Not settled after 6 s means a TUI that simply never stops repainting (a
    // spinner does exactly that). Type anyway — the echo check below is what
    // decides whether it landed, and waiting longer buys nothing.
  } else if (!(await sessions.waitReady(sessionId, 1200, 45000))) {
    // 45 s, not 30: a fan-out boots several `claude` processes at once, and the
    // last batch on a loaded machine can take well over half a minute to draw
    // its first prompt. Timing out early is what leaves a repo silently un-fed.
    return { result: "retry" };
  }
  // …and asked again AFTER the readiness wait, which can take 45 s: a channel
  // that dropped meanwhile must not be typed past either.
  {
    const held = await channelHold();
    if (held) return { result: "retry", detail: held };
    proof.refreshSource();
  }

  // ── A SHELL's input line (`caps.turns === false`) ──────────────────────
  //
  // Two ways a shell runs words BEFORE the one confirmed Return, both refused
  // here, before a byte is typed (`retry`: provably nothing typed):
  //  - a PROGRAM is in front of the shell (`vim`, `sleep`, a REPL): the words
  //    would be typed into it. The exceptions are a CLI the links reader saw
  //    asking for a code (`awaitingCode`), and one line to a program whose
  //    last row asks yes/no (`asksYesNo`, `[y/N]`) — that is the input it wants.
  //  - a newline in the text: the shell runs each line the moment it arrives.
  //    Where the shell in front takes bracketed paste (zsh, fish —
  //    `sessions/drive.ts` says why by name) the text goes in as ONE paste,
  //    held until the Return; anywhere else the send is refused in words.
  // Raw keys (`session.input` without submit) never come here.
  let typed = text;
  if (shell) {
    const facts = (await sessions.shellLineFacts?.(sessionId)) ?? { front: null, bracketed: false };
    if (facts.front && !sessions.get(sessionId)?.awaitingCode && (/[\r\n]/.test(text) || !asksYesNo(await sessions.screenText(sessionId, 40)))) {
      return { result: "retry", detail: `the shell is running \`${facts.front}\` — use the keys, or quit it first` };
    }
    if (/[\r\n]/.test(text)) {
      if (!facts.bracketed) {
        return { result: "retry", detail: "a shell runs each line the moment it arrives — send one line at a time" };
      }
      typed = `\x1b[200~${text}\x1b[201~`;
    }
  }

  // A never-trusted dir → claude shows its folder-trust box. Auto-accept so the
  // instruction doesn't land in the trust dialog. After accepting, claude
  // redraws the whole TUI — so we must wait for it to settle.
  // Never in a shell: those words on a shell's screen are output, and `1⏎` a command.
  //
  // The keys are `trustKeys`', never a bare `1⏎`: since 2.1.293 the box is
  // UNNUMBERED with the cursor on "No, exit", so the digit typed nothing and the
  // Return chose "No, exit" — every first prompt into a new repo quit claude
  // (code 0, "session gone, left no readable conversation log"). An unnumbered
  // box this cannot place a Yes on is refused, nothing typed: a Return there is
  // a guess, and the guess under the cursor is "exit".
  if (!shell && /trustthisfolder|createdoroneyoutrust|doyoutrust/.test(await screen())) {
    const nav = readNavBox(await sessions.screenText(sessionId, 60));
    const keys = trustKeys(nav);
    if (!keys || (!nav && /noexit/.test(await screen()))) {
      return { result: "retry", detail: "claude is asking whether to trust this folder and this app could not read the box — answer it in the terminal" };
    }
    sessions.write(sessionId, keys);
    // Quiet is not ready here: claude boots AFTER the Yes, and words typed into
    // that boot vanish (measured on 2.1.296 — an empty composer, `unconfirmed`).
    // Wait for the composer's own status line, the box gone, then settle.
    for (let t = Date.now(); Date.now() - t < 20000; await sleep(200)) {
      if (!sessions.get(sessionId)?.running) return { result: "retry" };
      const now = await screen();
      if (/shifttabtocycle|forshortcuts/.test(now) && !/trustthisfolder|noexit/.test(now)) break;
    }
    await sessions.waitReady(sessionId, 1500, 20000);
  }

  // Type with echo verification, and type AT MOST ONCE.
  //
  // The old code retyped up to 3× per feed, and the caller retried the whole
  // feed up to MAX_FIRE_ATTEMPTS — so a session whose echo we couldn't read got
  // the same instruction hammered in ~15 times (the repeated-prompt bug). The
  // screen cannot distinguish "the keystrokes were swallowed" from "they landed
  // but I can't see them", so a retype is never provably safe: one missed
  // delivery the user re-fires with a tap beats N copies of the same prompt.
  //
  // A leftover from an earlier attempt counts as typed — submit what's there
  // rather than stacking a second copy on top of it.
  // Every exit below records one observation against the echo probe, and this
  // is the 22% signal: the week that produced this whole feature was a week in
  // which this check quietly stopped finding text, every failure was handled
  // gracefully and individually, and two thirds of the resulting gravestones
  // were prompts that had actually run. It is one observation per DELIVERY —
  // a discrete event, not a poll — and the rate over the last twenty is the
  // thing no single delivery could ever say.
  //
  // …but "counts as typed" needs the leftover to be OURS. A prefix hit that
  // another open delivery into this session would have produced equally well
  // says only that SOME text starting like this is in that composer, and the
  // two ways of guessing are both bad: type, and a copy is stacked under
  // somebody else's prompt; press Return, and a turn runs their words while
  // this delivery reports `ok` — which is exactly what the live run caught, and
  // an `ok` is the verdict nothing ever revisits. So neither is done. Nothing
  // is typed and nothing is submitted, and the honest verdict for that is
  // `retry`: provably no side effect, safe to run again once the composer is
  // clear, and never a gravestone. The sentence goes into the audit row,
  // because "the session was not ready" and "I could not tell your prompt from
  // another one" are the same enum and completely different events.
  //
  // Asked of the NEWEST composer frame only. "Already typed" is a claim about
  // the box that is live right now, and a torn repaint can leave an older frame
  // further down the replay still holding text that has since been submitted.
  //
  // …which is also why the same rows are asked a second question. "The newest
  // frame holding anything" is a GUESS about which frame is live, and the tear
  // runs both ways: `composerFramesAmbiguous` is the case where it guesses
  // wrong and this file presses Return at an empty box. Two frames that do not
  // agree is "I cannot tell", and the branch below is where that answer goes.
  const beforeRows = probe ? (await sessions.screenText(sessionId, ROW_WINDOW)).split("\n") : [];
  let before = probe ? placeEcho(beforeRows, true) : "none";
  // Our words drawn DIM in an empty box are the CLI's own proposal of them
  // (`composerHoldsOnlyHint`), not a copy typed earlier: the box is empty, type.
  if (before !== "none" && await composerHoldsOnlyHint(sessions, sessionId)) before = "none";
  const unplaceable = before !== "none" && composerFramesAmbiguous(beforeRows);
  if (before !== "none" && (unplaceable || !proven(before))) {
    // NO health observation here, and that is the point of the branch rather
    // than an omission. Nothing has been typed yet, so no echo of OUR text was
    // ever owed — the probe was not asked to find it and did not fail to. What
    // the rule actually did was refuse to credit somebody else's words to this
    // delivery, which is the rule being RIGHT. Filing it as a `miss` is the
    // "was this the right rule" mistake (`shared/clihealth.ts`), and it fires
    // on the commonest shape there is — a re-send of a prompt whose first
    // attempt is still sitting in the box — so it would peg this signal amber
    // on a path where nothing is broken at all. A `good` would be as wrong in
    // the other direction: nothing was seen to work.
    //
    // Two sentences for the audit row, because they are two different events
    // with the same safe verdict: another delivery's words are in the box, or
    // two drawn boxes disagree about what the live one is holding.
    return {
      result: "retry",
      detail: unplaceable
        ? "that session drew two composers and this app cannot tell which one is live — nothing was typed"
        : "that session's composer already holds text this app cannot tell apart from yours — nothing was typed",
    };
  }
  // …and a box holding words that are NOT ours is not a box to type into either.
  //
  // `before === "none"` says only that nothing in the composer is OUR text. A
  // key pressed at the desk a moment after the phone answered a box (Codex's
  // `y`, measured: 4 of 4 live rounds came out `yReply …`, acked ok) leaves a
  // composer holding text that no rule above matches, and typing now appends
  // the prompt to it. Same verdict as the branch above and for the same reason:
  // `retry`, nothing typed, a sentence the phone shows. No health observation —
  // no echo was owed.
  if (before === "none") {
    const foreign = await foreignInComposer(sessions, sessionId, text, beforeRows);
    if (foreign) {
      return {
        result: "retry",
        detail: `the desk's input box already holds text ("${foreign}") — nothing was typed; clear it at the desk or send again`,
      };
    }
  }
  if (before === "none") {
    // What the screen looked like BEFORE our keystrokes, kept only for a local
    // command — see the rescue below. Cheap: one render we would otherwise have
    // paid for on the next branch anyway.
    const beforeWrite = noTurn ? await snapshot() : null;
    sessions.write(sessionId, typed);
    const echoed = await waitForEcho(ECHO_WAIT_MS);
    if (!echoed) {
      // Never saw it — which is a fact about the screen, not about the prompt.
      // Ask the log before believing the screen.
      //
      // Recorded AFTER the rescue, so the two cases stay apart: the log saving
      // a delivery the screen lost is the fallback WORKING, and it still means
      // the primary did not answer.
      if (await ranAnyway()) {
        note("deliver.echo", "fallback", { via: "the conversation log", raw: text });
        return { result: "ok" };
      }
      /**
       * **Ask the CLI, in the only language it answers this question in.**
       *
       * Everything above has failed for the SAME reason, and it is not that the
       * prompt is missing: the composer is a viewport (`echo.ts`'s `scrolled`),
       * a long single-line phone message draws only its tail, and the head this
       * file cuts its probe from is off the top of the box. Measured on this
       * desktop over a fortnight: 46% of deliveries between 300 and 800
       * characters came back unconfirmable against 19% of the shorter ones, and
       * the health record's own sample for the signal is `1 lines, 632 chars`.
       * Those prompts were typed, sitting in the composer, one keystroke from
       * running — and this is the branch that used to erase them with a ctrl-U
       * sweep and report them unsent.
       *
       * So press the keystroke and let the CLI say what it did with it.
       * `UserPromptSubmit` carries the submitted text, so the answer is about
       * THIS delivery and not about the session being busy — which is what
       * makes a Return admissible here at all. The two costs, stated:
       *
       *  - **A Return can never stack a copy** (the file's own rule for the
       *    submit ladder below, and the reason that ladder presses up to five).
       *    Retyping is what duplicates; this types nothing.
       *  - **The box may hold more than our text.** Nothing readable was in it
       *    before the write (`before === "none"`) — but "readable" is exactly
       *    what is in doubt here, so a stranger's words are possible, and a
       *    Return would run the mixture. That case is no longer silent: the
       *    hook names what went in, so the delivery SAYS that something else
       *    was submitted rather than reporting a clean failure.
       *
       * And if nothing is proved, the composer is deliberately NOT swept. The
       * sweep opens with an Esc, we have just pressed Return, and a turn that
       * started without the hook reaching us would be interrupted by it —
       * losing the words for real, which is the outcome this whole branch
       * exists to stop. `settle.ts` reads the log and the screen minutes later
       * and answers `landed` / `composer` / `absent`; only that last one
       * authorises a re-send, and it is the one verdict that cannot be wrong
       * about a prompt that ran.
       */
      let mixedUp: string | null = null;
      if (!noTurn && (sessions.isHooked(sessionId) || proof.deliverySrc)) {
        const pressedAt = Date.now();
        armSourceProof();
        sessions.write(sessionId, "\r");
        if (await submitProofWithin(PROMPT_HOOK_WAIT_MS)) {
          shape.submit = proofKind();
          if (proof.submitProven) {
            note("deliver.echo", "fallback", { via: "the CLI's own submitted-prompt hook", raw: text });
            note("deliver.submit", "good");
          }
          sessions.recordPrompt(sessionId, text, historyKind);
          return { result: "ok" };
        }
        shape.submit = "none";
        // Nothing was proved — so everything below is unchanged, INCLUDING the
        // sweep and the rule that it never fires mid-turn. That order is what
        // keeps this addition honest: a Return is free (it cannot stack a copy),
        // and the leftover text it may not have submitted is still cleared by
        // the same ctrl-Us as before, so a later re-send still starts clean.
        //
        // The one thing worth saying out loud is the case the hook makes
        // visible for the first time.
        mixedUp = sessions.lastSubmittedPrompt(sessionId, pressedAt);
      }
      /**
       * **A no-turn command has a second proof, and little to fear from using it.**
       *
       * `ranAnyway()` asks the conversation log, and for a slash command the log
       * is silent by construction — the CLI writes those as an envelope the
       * transcript reader drops (`isSlashText`), whether they ran or not. So the
       * rescue that saves an ordinary prompt from a slow repaint can never fire
       * for `/usage`, `/context` or `/resume`: on a link where the echo does not
       * arrive inside `ECHO_WAIT_MS`, they go straight to `unconfirmed`, which is
       * never retried. Reported from a phone as "/cost — not delivered · typed,
       * but never appeared on screen", with the command sitting in the composer.
       *
       * The proof that fits is the one the submit branch below already rests on
       * for exactly this class of command: the SCREEN MOVED. Typing into an idle
       * composer redraws it; typing nothing does not.
       *
       * And the reason this is allowed to be weaker evidence than an echo is
       * that the thing `unconfirmed` protects against barely exists here. That
       * verdict is never retried because a second attempt could send a prompt
       * TWICE. A command that opens a view sends nothing at all: running it
       * twice shows the usage screen twice. `/btw` is the one that does leave
       * something behind, and the worst it costs is a duplicate note the agent
       * reads at the end of the turn — against the cost of the honest-looking
       * alternative, which is telling a person their note is unsent, in a
       * sentence written to be acted on by hand. If the text in fact never
       * landed, the Return below falls through to `unsubmitted`, which is a
       * better answer than this one and equally un-retried.
       *
       * **The caveat, said out loud rather than hidden:** a busy screen reads
       * as moved. This TUI repaints on its own, so a session already drawing
       * something satisfies "the screen moved" whether or not the keystrokes
       * landed, and a genuinely swallowed command can be upgraded to `ok` on
       * that — the same caveat the submit proof below carries, resting on the
       * same evidence. It is not a reason to record a `good`: this path notes
       * the FALLBACK, and only the fallback.
       */
      if (noTurn && beforeWrite !== null && (await snapshot()) !== beforeWrite) {
        note("deliver.echo", "fallback", { via: "the screen moving", raw: text });
      } else {
        note("deliver.echo", "miss", { raw: text });
        // Still nothing. Sweep the composer in case it DID land (so a re-fire
        // starts clean) and report the ambiguity to the caller — which must not
        // silently retry.
        //
        // **Never mid-turn, though.** The sweep opens with an Esc, and an Esc
        // at a session that is running INTERRUPTS the turn — the hazard
        // `ranAnyway()` above is ordered around, which the ordering alone does
        // not remove: a miss that is a misplaced echo rather than a missing one
        // reaches here with the turn very much alive. The six ctrl-Us then
        // delete an interjection that HAD landed, and the sweep re-sends it
        // minutes later. There is nothing to clean up anyway: text left in a
        // busy composer is `settle.ts`'s `composer` verdict — one keypress from
        // running, and not `absent`, so no re-send can stack under it. Only a
        // HOOKED session can prove a turn is live; without the pipe this is
        // unchanged, because the alternative is guessing from silence and the
        // guess that skips the sweep leaves a stale composer for the re-fire.
        const midTurn = sessions.isHooked(sessionId) && sessions.get(sessionId)?.turnActive === true;
        if (!midTurn) await clearComposer(!local);
        return {
          result: "unconfirmed",
          // Only when the CLI actually said so. `mixedUp` is a submitted prompt
          // that is not ours, in the window between our Return and now — the
          // one outcome here where a person's words went in mixed with
          // somebody else's, which no screen rule could ever have reported.
          ...(mixedUp ? { detail: "that session submitted something other than your text — its composer may have held words this app could not read, and yours were typed into the same box" } : null),
        };
      }
    }
    // **One observation per delivery, and only for what was actually seen.**
    // The rescue above has already written this delivery's — a `fallback`,
    // which `shared/clihealth.ts` counts as a MISS, the primary rule having not
    // answered. Falling through to a `good` on top of it claimed an echo nobody
    // saw, and put a miss and a success in the same twenty-slot window for one
    // delivery: a rate describing no event at all, with the real misses this
    // signal exists to surface diluted out of it.
    if (echoed) note("deliver.echo", "good", await echoFixture());
  } else {
    // The short-circuit: the text was already on screen from an earlier
    // attempt, and provably ours. The probe found it, which is the thing this
    // signal measures.
    shape.echo = before;
    note("deliver.echo", "good", await echoFixture());
  }
  return submitAndConfirm({ sessions, sessionId, text, historyKind, shape, note, snapshot, noTurn, unannounced, proof, ranAnyway });
}
