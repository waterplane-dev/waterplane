/**
 * The evidence that is not a rendering — the CLI's log and the CLI naming the
 * words it took — moved out of `deliver.ts`'s `runDelivery`
 * (docs/notes/host-architecture.md, "The deliver slices").
 */
import type { SessionManager } from "../sessions.js";
import { awaitLanded } from "../settle.js";
import { channelUp, liveSourceFor } from "../livesources.js";
import { LOG_PROOF_MS, SOURCE_LANDED_MS, sleep } from "./deliverknobs.js";

export function makeLogProof(
  sessions: SessionManager,
  sessionId: string,
  text: string,
  startedAt: number,
  key: string,
) {
  /**
   * The witness that is not a rendering: did the CLI's own conversation log
   * record this prompt as a turn?
   *
   * Everything above reasons about a SCREEN — 40 rows of a TUI that repaints on
   * its own schedule, hides pasted text behind a placeholder, and draws views
   * over its own composer. The conversation log is what the CLI wrote down when
   * it ACCEPTED the prompt, and it settles the question the screen could only
   * fail to answer. So no delivery is filed as unconfirmable until this has
   * been asked (`settle.ts`, the one implementation — deliberately not a second
   * jsonl reader here).
   *
   * Ordering matters and is easy to lose: this runs BEFORE the composer sweep.
   * The sweep opens with an Esc, and an Esc at a session that is running the
   * prompt INTERRUPTS the turn — so the old order could take a prompt that had
   * landed perfectly, stop it, and then report it as never seen.
   */
  // `key` is passed as the claimer: a log turn is evidence for exactly one
  // delivery, and this is the path that answers `ok` — the verdict nothing ever
  // revisits. Without it, two deliveries of the same words inside the recency
  // window both read the one turn and both report success, and only one of them
  // ran.
  const ranAnyway = () => awaitLanded(sessions, sessionId, text, startedAt, LOG_PROOF_MS, undefined, key);
  return ranAnyway;
}

/**
 * The hook / side-channel proof. Its mutable state stays these closure `let`s;
 * the run reads it through the getters, at the moment it always did, and the
 * re-read after the channel hold is `refreshSource()`.
 */
export function makeSubmitProof(
  sessions: SessionManager,
  sessionId: string,
  text: string,
  startedAt: number,
) {
  /**
   * **The CLI naming the words it just took.**
   *
   * `UserPromptSubmit` carries the submitted prompt, and until now the host
   * read only the fact that it had fired. Everything else in this file is
   * evidence about a SESSION — the screen moved, a turn is running, the
   * scrollback grew — and every one of those is equally true of a session that
   * is busy for its own reasons. This is the only signal that says *your text*,
   * which makes it the only one that survives the two cases the ladder below is
   * blind in: an interjection (a turn was already running, so no turn-start can
   * be attributed to our Return) and an echo the screen was never readable for.
   *
   * CLAIMED once, in `sessions/turn.ts` (`claimSubmittedPrompt`) — two deliveries of identical text must not
   * both read one hook event as their own. Memoised here for the same reason
   * from the other side: a claim is spent on the first true, so a second call
   * in a polling loop would read the proof it has already been given as absent.
   *
   * False for a backend with no hooks, a session whose pipe never spoke, and a
   * CLI that sends the event without the text. Every caller falls through to
   * the proof it had before this existed; nothing here may downgrade a verdict.
   */
  let submitProven = false;
  /**
   * **The same proof from a side channel** (`sources.delivery`, design §2): the
   * backend's own record of a user message whose text EQUALS ours. One rung
   * beside the hook, never a fork of the ladder — it is OR-ed into
   * `submitProof()`, so every branch that already waits on the CLI naming our
   * words waits on this too, and a backend with no source (null below) is this
   * file exactly as it was.
   *
   * **Only after the Return.** `armSourceProof()` is called at each press and
   * subscribes ONCE, floored at that press: words sitting typed in a composer
   * are not a user turn, and a landing stamped before our keystroke is somebody
   * else's (the person at the desk, an earlier identical send). Nothing is
   * asked before a Return exists, so nothing can stand in for one.
   *
   * Asked only while the channel is UP — a down channel would answer false
   * after its whole timeout, which is no evidence at the price of a wait. And
   * NO health observation when this is the proof (design §2: health none): the
   * health record measures the claude TUI's readers, and a side channel
   * answering says nothing about them.
   */
  const sourceOf = () => {
    const live = liveSourceFor(sessionId);
    return live?.sources.delivery && channelUp(live) ? { src: live.sources.delivery, session: live.session } : null;
  };
  // Re-read after the channel hold below: a channel that was still connecting
  // when this delivery began is the one that proves it.
  let deliverySrc = sourceOf();
  let sourceLanded = false;
  let sourceArmed = false;
  const armSourceProof = () => {
    if (!deliverySrc || sourceArmed) return;
    sourceArmed = true;
    const pressedAt = Date.now();
    try {
      deliverySrc.src.landed(deliverySrc.session, text, pressedAt, SOURCE_LANDED_MS)
        .then((v) => { if (v === true) sourceLanded = true; }, () => { /* no answer is no proof */ });
    } catch { /* a source that throws is a source that did not answer */ }
  };
  const submitProof = () => (submitProven ||= sessions.claimSubmittedPrompt(sessionId, text, startedAt)) || sourceLanded;
  /** Which of the two proved it — the hook outranks the source when both did. */
  const proofKind = (): "prompt-hook" | "source" => (submitProven ? "prompt-hook" : "source");
  /** Give the hook a moment to arrive — it races the screen, and on the live
   *  host it has landed hundreds of milliseconds AFTER the write that caused
   *  it. Only ever spent where the delivery is otherwise out of proofs. */
  const submitProofWithin = async (ms: number) => {
    const deadline = Date.now() + ms;
    for (;;) {
      if (submitProof()) return true;
      if (Date.now() >= deadline) return false;
      await sleep(150);
    }
  };
  return {
    get submitProven() { return submitProven; },
    get sourceLanded() { return sourceLanded; },
    get deliverySrc() { return deliverySrc; },
    refreshSource: () => { deliverySrc = sourceOf(); },
    armSourceProof, submitProof, proofKind, submitProofWithin,
  };
}
