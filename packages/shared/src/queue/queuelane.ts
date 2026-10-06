// Cut from queue.ts (move only): lane state and walls
// The one door stays `./queue.js`; this slice imports its siblings directly, never the barrel.

/**
 * The facts about a session that decide whether a `holdUntilIdle` entry may go
 * out. Primitives rather than a `SessionInfo` so this module stays node-runnable
 * and DOM-free — the caller maps its own state onto it.
 */
export interface LaneSessionState {
  /** A turn is in flight (exact on a hooked session, a silence guess otherwise). */
  turnActive?: boolean;
  /** The session is parked on a usage limit and is waiting for the reset. */
  limitBlocked?: boolean;
  /** Kind of the choice prompt on screen, if `prompt.ts` parsed one. */
  promptKind?: string | null;
  /** A dialog is up that could NOT be parsed into options. */
  awaitingInput?: boolean;
}

/**
 * Is this session unable to take a parked send right now?
 *
 * "Hold until idle" means "deliver it when the agent can actually run it", and
 * `turnActive` alone does not answer that. Three states are quiet AND unable to
 * take a prompt, and each one breaks differently:
 *
 *   • parked on a question — prose typed at an open dialog goes INTO the dialog.
 *     It neither runs nor answers; the same trap `answerInsertAt` exists for.
 *     On a hooked session the turn stays active while the box is up, so the hold
 *     already worked; on a NON-hooked one `turnActive` is the silence guess, and
 *     a session waiting for an answer is perfectly silent — so exactly the
 *     sessions with no hook pipe were the ones that got a prompt typed into a
 *     dialog.
 *   • an unparsable dialog (`awaitingInput`) — same thing, minus the options.
 *   • blocked on a usage limit — the session is waiting out a reset, and a
 *     prompt delivered into it is typed at a menu.
 *
 * This is the client-side twin of the host's `sessions.autoFireBlocker()`, which
 * gates backlog auto-fire on the same three facts. The backlog has refused to
 * fire into all three since it was written; the send queue's own park did not,
 * which made "queue for this session" and "hold until idle" — the same intent,
 * expressed two ways — behave differently.
 *
 * A session that has ENDED is deliberately not busy: parking an entry against a
 * dead session would hold it (and its lane) forever, when the right outcome is
 * to attempt it, get `ok:false`, and tell the user.
 */
export function laneBusy(s: LaneSessionState): boolean {
  return sessionWall(s) !== null;
}

/**
 * WHICH of the three walls a session is behind, or null when it is ready.
 *
 * `laneBusy` collapses this to a boolean, which is all a lane needs; every
 * other caller wants the reason, and each of them used to re-derive it from the
 * same four fields in its own order with its own words. There were four copies
 * — this one, `intent.ts`'s `sessionBlocker`, the host's `autoFireBlocker` and
 * the phone's `holdWall` — each carrying a comment saying the others existed.
 * A fifth session state would have had to be added in four places, two of which
 * fail silent.
 *
 * The ORDER is the load-bearing part and is `intent.ts`'s: a limited session is
 * reported as limited even when a box happens to be on screen, because the
 * reset is the thing the user is actually waiting for. `laneBusy` is unaffected
 * by the order — it only asks whether the answer is null.
 *
 * The names are `BlockReason` values on purpose, so a caller can hand one
 * straight to `intentReasonText` rather than writing a fourth set of sentences.
 */
export type SessionWall = "limit" | "awaitingAnswer" | "sessionBusy";

export function sessionWall(s: LaneSessionState): SessionWall | null {
  if (s.limitBlocked) return "limit";
  // An unparsable dialog is the same trap as a parsed one, minus the options.
  // A trust prompt is not a question in this sense — delivery auto-accepts it.
  if (s.awaitingInput || (s.promptKind && s.promptKind !== "trust")) return "awaitingAnswer";
  if (s.turnActive) return "sessionBusy";
  return null;
}
