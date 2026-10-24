/**
 * The TAIL of `runDelivery` — from the echo verdict on: the settle before the
 * Return, the no-turn presses, the unhooked press-and-look and the hooked
 * submit ladder. Moved whole as the run's last statement
 * (docs/notes/host-architecture.md, "The deliver slices").
 */
import { LOCAL_MOVE_POLLS, LOCAL_SUBMIT_TRIES, UNANNOUNCED_POLLS, UNANNOUNCED_TRIES, sleep } from "./deliverknobs.js";
import type { DeliveryResult, DeliveryRun } from "./delivertypes.js";
import { resolveBackend } from "../backends/index.js";
import { trustRule, type TrustRule } from "../backends/derive.js";

/** Does this session's backend have TURNS? A shell does not (`caps.turns`).
 *  Unknown backend / no lookup on a test double ⇒ true, today's behaviour. */
export function hasTurns(run: Pick<DeliveryRun, "sessions" | "sessionId">): boolean {
  try { return resolveBackend(run.sessions.get?.(run.sessionId)?.backend).caps.turns !== false; } catch { return true; }
}

/** This session's folder-trust rule (`derive.ts`'s `trustRule`). No backend id ⇒ claude (today's
 *  default, and every test double's); an id this host cannot resolve ⇒ never answered. */
export function trustRuleFor(id: string | undefined): TrustRule {
  try { return trustRule(resolveBackend(id)); } catch { return trustRule(null); }
}

export async function submitAndConfirm(run: DeliveryRun): Promise<{ result: DeliveryResult; detail?: string }> {
  const { sessions, sessionId, text, historyKind, shape, note, snapshot, noTurn, unannounced, proof, ranAnyway } = run;
  const { armSourceProof, submitProof, proofKind, submitProofWithin } = proof;
  // The text echoed in the composer ⇒ input is being accepted (NOT swallowed
  // by a usage view / prompt). That's our delivery confirmation.
  // Log the instruction to the session history and start capturing its output.
  sessions.recordPrompt(sessionId, text, historyKind);
  // Let the TUI settle before the submit keystroke. A fan-out boots several
  // `claude` processes at once, and a Return pressed into a mid-repaint TUI is
  // exactly the keystroke that gets dropped. Wait for a short quiet window
  // (bounded — a spinner may never stop) instead of a blind 150 ms.
  for (let i = 0; i < 6; i++) {
    if ((sessions.idleMs(sessionId) ?? 999) >= 250) break;
    await sleep(150);
  }
  // Submit — and, when the session can prove it, VERIFY the turn started.
  //
  // A redraw can swallow the Return and leave the text sitting in the composer
  // (the same bug the compose box hit). The old check accepted "the scrollback
  // grew by >80 bytes" as proof of submission — but a real claude TUI repaints
  // constantly (spinner, token counter, cursor), so that threshold is met
  // whether or not the Return landed. A whole fan-out came back "running" with
  // every session holding an un-run prompt.
  //
  // Re-pressing Return is ALWAYS safe — unlike retyping, a Return cannot stack a
  // second copy of the text — so on a hooked session press it until the turn
  // provably began: UserPromptSubmit flips `turnActive`, and a turn that already
  // finished has bumped `stopCount`.
  // The turn-start proof needs a turn that was NOT already running: `turnActive`
  // is the signal, so interjecting into a live turn makes it true before the
  // Return is even pressed. Fall back to press-and-look there rather than
  // reporting a proof we do not have.
  // A no-turn command never fires `UserPromptSubmit`, so the turn-start proof
  // can never arrive — pressing Return until it does means pressing it 5× into
  // the view the FIRST press opened, which dismisses it (`/usage` → "Settings
  // dialog dismissed") and then reports the command as not delivered. For the
  // one that opens nothing (`/btw`) the five presses were harmless and the
  // VERDICT was the damage: a note filed perfectly came back "sitting in the
  // composer, unsent — do not retype it", the one sentence this app says that a
  // person is meant to act on by hand.
  //
  // The proof that fits is the SCREEN MOVING. A no-turn command redraws — a
  // view opens, a picker replaces the conversation, the composer at least
  // empties — and an idle TUI that got a swallowed Return does not. Press again
  // only while the screen is provably unchanged, so a press can never reach a
  // view the previous one opened. (A busy session repaints on its own and reads
  // as moved; that costs us nothing but the proof, and pressing fewer Returns
  // is the whole point.)
  if (noTurn) {
    /**
     * **The second Return is the dangerous one, and it was on a 1.5 s fuse.**
     *
     * A press that OPENED a view is invisible for as long as the view takes to
     * draw, and `/usage` is an ink component behind a control-request — on a
     * loaded machine that is comfortably more than ten 150 ms polls. So the
     * screen still looked unchanged, the loop concluded the Return had been
     * swallowed, and pressed again INTO the view the first press had just
     * opened. The CLI logs what happens next in the conversation itself:
     * `/usage` → *"Settings dialog dismissed"*. That is the automatic keystroke
     * the user could see the effect of and not the cause.
     *
     * The two costs are not symmetric. Being patient costs latency on a Return
     * that really was swallowed — a wait, and the screen says nothing is
     * happening. Being impatient destroys the thing the person asked for, after
     * it had already worked. So: wait far longer before doubting the first
     * press, and press at most twice rather than three times.
     */
    for (let attempt = 0; attempt < LOCAL_SUBMIT_TRIES; attempt++) {
      let before = await snapshot();
      sessions.write(sessionId, "\r");
      let moved = false;
      for (let i = 0; i < LOCAL_MOVE_POLLS && !moved; i++) {
        await sleep(150);
        moved = (await snapshot()) !== before;
      }
      if (moved) {
        // The fixture leads with the command NAME, then the view it opened as
        // drawn (`snapshot()` squashes and folds case — a proof, not a picture).
        const cmd = text.trim().split(/\s+/)[0] ?? "";
        note("slash.local", "good", { fixture: async () => `${cmd}\n${await sessions.screenText(sessionId, 40)}` });
        shape.submit = "screen-moved";
        return { result: "ok" };
      }
    }
    // Three presses and the screen never moved. Either the command starts a turn
    // after all (so the app is waiting for a redraw that will never come) or the
    // list has drifted from the CLI's — and getting that list wrong in either
    // direction is the failure this signal names. The sample is the command
    // NAME only: everything else on that screen is prose.
    note("slash.local", "miss", { raw: text.trim().split(/\s+/)[0] ?? "" });
    // No log check here, and it is not an omission: a no-turn command is a slash
    // command by definition, and the CLI writes those as an envelope the
    // transcript reader drops (`isSlashText`) — or, for `/btw`, writes nothing
    // at all. The log is silent about them whether they ran or not.
    return { result: "unsubmitted" };
  }

  // Which proof is available here — and, separately, whether its absence is a
  // statement about the CLI at all.
  //
  // `isHooked` answers "has a hook reached THIS host process for this session",
  // not "does this session have a pipe"; `turnActive` answers "is a turn
  // running", which for an interjection is true before the Return exists. Both
  // send the delivery down the press-and-look branch, and only one of them is
  // the integration failing. Keeping them in one boolean is what made the
  // health record unable to tell them apart — see the branch below.
  const hookLive = sessions.isHooked(sessionId);
  // HOOK-announced only (`turnFromHook`): a turn the host read off the screen —
  // a `/compact`, a continuation a Stop hook refused — says the CLI is busy and
  // says nothing about a Return, so it must neither stand in for this
  // delivery's proof nor disqualify it from having one.
  const alreadyWorking = sessions.turnFromHook(sessionId);
  const hooked = hookLive && !alreadyWorking;

  /**
   * The Return went in but we could not prove the turn started.
   *
   * `unsubmitted` claims something specific and actionable — "your text is in
   * that composer, press Return there, never retype it" — so it must not be
   * said about a prompt that is running. On an UNHOOKED session the proof is a
   * guess in the first place (the branch below reports `ok` for that reason);
   * on a hooked one the hook can still be lost. The log answers both.
   *
   * Snapshotted BEFORE any Return goes in — including the press-and-look
   * branch's — so "did this delivery's keystroke start a turn" is asked about
   * this delivery's keystroke.
   *
   * `turnActive` counts only when a turn was not ALREADY running: interjecting
   * makes it true before there is anything to prove, so the interjection case
   * is left with the Stop counter, which is a fact about a turn ending and
   * never about ours starting. That is precisely why it records nothing.
   */
  const stopsBefore = sessions.stopCount(sessionId);
  /**
   * Was the CLI already visibly working before this Return — as against a
   * spinner this keystroke is about to produce?
   *
   * Only read for `unannounced` (`/compact`), and the reason it is read at all
   * is the reason `turnFromHook` exists: a screen-inferred turn is evidence
   * that the CLI is busy, never evidence about a Return. Snapshotting it BEFORE
   * the keystroke is what turns it into the second kind for this one command —
   * an idle session that swallowed the Return keeps painting nothing.
   */
  const screenTurnBefore = unannounced && sessions.turnFromScreen(sessionId);
  /**
   * `submitProof()` leads, and it is the only rung that is about this DELIVERY.
   * The two under it are about the session — a turn count that moved, a turn
   * that is running — and both are why the interjection case below has to fall
   * back to a guess: they were already true before the Return existed. A hook
   * that names our own text is not, which is why it is asked first and why it
   * is the one rung an interjection may use.
   */
  const turnStarted = () =>
    submitProof()
    || sessions.stopCount(sessionId) > stopsBefore
    || (!alreadyWorking && sessions.turnFromHook(sessionId))
    /**
     * **The rung that only `/compact` may stand on.**
     *
     * Every rung above rests on a hook, and this command fires none — not
     * `UserPromptSubmit`, not `Stop` — while working for minutes. The log is
     * silent too (a slash command is written as an envelope the transcript
     * reader drops), so `ranAnyway()` below cannot rescue it either, and the
     * delivery filed a running compaction as *"typed, but Return was swallowed
     * — open the session and press Return"*: a sentence written to be acted on
     * by hand, about work that was already 15% done on the screen beside it.
     *
     * What is left is the CLI's own working line, which `sessions/turn.ts` already
     * reads for exactly this command and publishes as a turn marked
     * `fromScreen`. It is admissible HERE and nowhere else because the two
     * things that make it weak elsewhere are both excluded: the command is
     * named (a `/compact` cannot be mistaken for a prompt whose turn some other
     * `/compact` is painting), and the session was not already working when the
     * Return went in (`screenTurnBefore`).
     */
    || (unannounced && !screenTurnBefore && sessions.turnFromScreen(sessionId));

  /**
   * Did the pipe answer after all, a moment behind the Return?
   *
   * The press-and-look loop breaks the instant the screen grows, which is
   * routinely BEFORE the hook it is racing lands — so a bare re-check is a coin
   * toss about scheduling, and the record it writes is a claim about the CLI.
   * Six slices of 150 ms, and only ever spent on a delivery that is otherwise
   * about to be filed as a fallback: a working host pays nothing for it.
   *
   * Both halves are required. A hook arriving proves the pipe is alive but not
   * that our Return landed (a `SessionStart` would do it); a turn starting on a
   * session we still cannot hear from is `markSubmitted` reporting our OWN
   * write back to us, which is not evidence of anything.
   */
  const lateTurnProof = async () => {
    for (let i = 0; i < 6; i++) {
      if (sessions.isHooked(sessionId) && turnStarted()) return true;
      await sleep(150);
    }
    return false;
  };

  if (!hooked && !hasTurns(run)) {
    // A SHELL: Return runs the line, and a second Return is a second (empty)
    // command — the press-and-look's re-press is wrong here, not just useless.
    // The echo was seen, so the words are on the line: one Return, `ok`.
    armSourceProof();
    sessions.write(sessionId, "\r");
    shape.submit = "none";
    return { result: "ok" };
  }
  if (!hooked) {
    // No hook pipe (stub binary, no curl, hooks off) ⇒ no way to tell a swallowed
    // Return from a quiet agent. Keep the old best-effort press-and-look: three
    // tries, stop as soon as the screen grows, and report ok either way, because
    // claiming a failure we can't see would be the same guess in reverse.
    for (let attempt = 0; attempt < 3; attempt++) {
      const before = sessions.scrollback(sessionId).length;
      armSourceProof();
      sessions.write(sessionId, "\r");
      await sleep(700);
      if (sessions.scrollback(sessionId).length - before > 80) break;
    }
    // Two fallbacks, one branch, and they are different facts. The hook pipe is
    // missing (recorded once per session — `noteHookFallback` owns that rule),
    // and BECAUSE it is missing this delivery returns `ok` on no proof at all.
    // The second is the "never silently substitute" case in its purest form:
    // the caller is told the prompt is running and nothing checked that it is.
    if (!sessions.isHooked(sessionId)) sessions.noteHookFallback(sessionId, "silence heuristics");

    // ── What this delivery is entitled to SAY about the submit proof ───────
    //
    // One code path, three completely different events, and the health record
    // used to be told only the code path. On the live host that read 5 misses
    // of the last 20 — degraded, amber, and permanent — and the sent log says
    // every one of those five deliveries came back `ok`. Four of them were the
    // two cases below that are not failures at all; the one real miss in that
    // window came from the branch further down and settled `composer`, i.e.
    // the signal working exactly as designed. A board whose amber is mostly
    // wolf is a board nobody taps, which costs the real reading everything.
    //
    //  • THE PIPE IS LIVE AND A TURN WAS ALREADY RUNNING — a person
    //    interjecting from the compose bar, which `DeliverOpts.interactive`
    //    already documents as costing exactly this proof. There is no
    //    turn-start to observe, because the turn started before the Return did.
    //    The rule is not failing; it is not applicable, so this records
    //    NOTHING — the fourth thing a call site may say (`clihealth.ts`,
    //    `HealthOutcome`). A `good` would be as wrong in the other direction:
    //    it would fill the window with successes nobody earned and bury the
    //    real misses arithmetically. And it is not rare — interjecting is the
    //    ordinary way this app is used, so counting it made the rate a
    //    measurement of the user's habits.
    //  • THE HOST HAD NOT YET HEARD FROM A PIPE THAT IS ALIVE, and our Return
    //    is what made it speak. A tmux session re-attached after a restart is a
    //    claude that started days ago; on the live host its first hook landed
    //    677 ms into this very loop, and the delivery still filed a fallback
    //    for a proof that had turned up. So ask again before writing the
    //    record: a turn that provably started is the primary rule ANSWERING,
    //    late. (This is the same mistake `noteHookFallback` was fixed for, one
    //    call site over — the re-check above was added for the hook signal and
    //    never extended to this one.)
    //  • NEITHER — the pipe is genuinely not there and this delivery returned
    //    `ok` on no proof at all. That is the fallback, and it is the one worth
    //    a word.
    if (await submitProofWithin(600)) {
      // The CLI named our text. This is the case the comment below calls
      // unprovable, and it stopped being unprovable: an interjection has a
      // proof of its own now, and it is a better one than the branch that CAN
      // reach a turn-start has — a hook carrying the prompt cannot be satisfied
      // by a session that was busy anyway. Short window: the press-and-look
      // loop above has already spent up to 2.1 s, so the hook is normally in
      // by the time this asks.
      shape.submit = proofKind();
      if (proof.submitProven) note("deliver.submit", "good");
    } else if (hookLive) {
      // Interjection into a live turn, with no prompt-carrying hook to settle
      // it: nothing observed, nothing recorded.
    } else if (await lateTurnProof()) {
      shape.submit = "turn";
      note("deliver.submit", "good");
    } else {
      shape.submit = "none";
      note("deliver.submit", "fallback", { via: "press-and-look", raw: text });
    }
    return { result: "ok" };
  }

  /**
   * **How long to wait before doubting the first press, and how many to press.**
   *
   * A hook answers in milliseconds, so for a prompt six 150 ms slices is
   * generous and five presses are cheap (a Return can never stack a copy). The
   * screen-inferred proof cannot be that quick: `sessions/turn.ts` arms its watch a
   * fixed window after output and then wants a repaint inside it, so a budget
   * cut for a hook concludes the Return was swallowed while the compaction is
   * still drawing its first frame — and presses again. Same asymmetry the
   * no-turn branch above spells out: being patient costs latency, being
   * impatient presses Return into work that had already started.
   */
  const submitPolls = unannounced ? UNANNOUNCED_POLLS : 6;
  const submitTries = unannounced ? UNANNOUNCED_TRIES : 5;
  let submitted = false;
  for (let attempt = 0; attempt < submitTries && !submitted; attempt++) {
    armSourceProof();
    sessions.write(sessionId, "\r");
    // Poll instead of sleeping a fixed slice: the hook reports the turn start
    // within milliseconds, so the common case costs one press and ~150 ms.
    for (let i = 0; i < submitPolls && !submitted; i++) {
      await sleep(150);
      submitted = turnStarted();
    }
  }
  if (submitted) {
    // Which proof answered is kept apart on the audit row: `prompt-hook` is the
    // CLI naming our text, `turn` is a turn boundary that could only have been
    // ours, `screen-turn` is the working line of a command that announces
    // nothing. Same verdict, three strengths of evidence, and the measurement
    // this was built for is about exactly that difference.
    shape.submit = proof.submitProven ? "prompt-hook" : proof.sourceLanded ? "source" : (unannounced && !sessions.turnFromHook(sessionId) ? "screen-turn" : "turn");
    if (shape.submit !== "source") note("deliver.submit", "good");
    return { result: "ok" };
  }
  // The Return went in five times and no turn started. Same split as the echo
  // above: the log rescuing it is the fallback working and the primary still
  // not answering; nothing rescuing it is a miss, and it is the point at which
  // this app tells a user their text is sitting unsent in a composer — a
  // specific, actionable claim that must not be made about a prompt that ran.
  if (await ranAnyway()) {
    shape.submit = "log";
    note("deliver.submit", "fallback", { via: "asking the conversation log later", raw: text });
    return { result: "ok" };
  }
  shape.submit = "none";
  note("deliver.submit", "miss", { raw: text });
  return { result: "unsubmitted" };
}
