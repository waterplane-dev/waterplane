/**
 * Why a session is blocked on something OUTSIDE it — the one derivation both
 * ends ask (`blockOf`), so the host's walls, the phone's chip and its sheet
 * cannot each re-read four wire shapes in their own order.
 *
 * Four reasons, each with its own detector and recovery today:
 *  - `auth`  — the CLI is not signed in (`signedOut`, a sign-in link on screen
 *              `login`, or first-launch setup on a signed-out desktop `cliSetup`).
 *  - `spend` — an API-key / cloud account out of credit or over a spend limit
 *              (`limit.spend`).
 *  - `limit` — a plan's usage window (`limit` without `spend`).
 *  - `net`   — the host retrying a turn the CLI gave up on a transient API
 *              error (`netRetry`).
 *
 * Derived ONLY from today's wire fields — no wire change (a later phase makes
 * `SessionInfo.block` the field). Pure, no clock, no IO. It never filters on
 * `running`: whether an exited session's block still matters is the caller's
 * question.
 *
 * PRECEDENCE when several hold: auth > spend > limit > net. Nothing else works
 * while signed out, so a sign-in is the first thing a person must do; a spend
 * wall needs the person where a usage window clears by the clock; a network
 * retry is the one that most often clears by itself.
 *
 * PHASE — what the host is doing about it, as far as the wire can say:
 *  - `waiting`  — a try is scheduled (`nextAt`) or the session holds a place
 *                 in the resume queue, and none is in flight.
 *                 A limit/spend continue HELD on a person's draft
 *                 (`limit.held`) is `waiting` with `nextAt` null and the
 *                 reason as `detail` — the host only looks again, it promises
 *                 no try.
 *  - `retrying` — a try is in flight right now (a limit resume typed, a net
 *                 retry's `continue` sent and its turn running).
 *  - `needsYou` — nothing will happen by itself BY DESIGN: signed out, a spend
 *                 wall nobody can date, a wall the backend says needs the
 *                 person, or auto-continue switched off for this session.
 *  - `gaveUp`   — automatic recovery ran out: nothing is scheduled and the
 *                 host stopped trying. A person's own send still goes through.
 *
 * The sign-in episode (`signInWait`, host `recover/authgate.ts`) — a session
 * whose turn a sign-out stopped, kept past the on-screen `signedOut`/`login`
 * flags that the `/login` flow clears: `needsYou` + `SIGNED_OUT_DETAIL` while
 * the account is signed out; once the host confirms the sign-in, `waiting` +
 * `SIGNED_IN_AGAIN_DETAIL` — waiting for the PERSON's continue, which the host
 * never types unasked (owner, 2026-11-02); `waiting` + `SIGNIN_QUEUED_DETAIL`
 * behind the first after the tap; `retrying` while its continue is in flight;
 * `needsYou` + `SIGNIN_UNSURE_DETAIL` while the host cannot tell (`unsure`).
 * A sign-in link on its own screen outranks all of that (`needsYou`).
 *
 * Two net cases, decided here once:
 *  - A STALL PROBE is never `gaveUp`: a stalled session the host still probes
 *    is retrying slowly — `waiting` while the next probe is due (a `gaveup` row
 *    with `nextAt`), `retrying` while it runs (`probe` + `sent`). Only a
 *    `gaveup` with no next probe (switch off, halt, cancelled) is `gaveUp`.
 *  - A DISMISSED net retry is still a block: dismissing only hides the line,
 *    the stall stands (`netRetryStalls` ignores it too), so work waiting on the
 *    session keeps waiting. Hiding is the reader's business (`netRetry.dismissed`).
 */
import type { SessionInfo } from "./wire/session.js";

export type BlockKind = "auth" | "spend" | "limit" | "net";
export type BlockPhase = "waiting" | "retrying" | "needsYou" | "gaveUp";

export interface SessionBlock {
  kind: BlockKind;
  phase: BlockPhase;
  /** Epoch ms the block began, or null when no field says (signed out carries
   *  no stamp; a sign-in link's own `at` is used when there is one). */
  since: number | null;
  /** Automatic tries already made for this block (0 for auth). */
  attempts: number;
  /** Epoch ms of the next automatic try, or null when none is scheduled. */
  nextAt: number | null;
  /** limit / spend only: when the wall is expected to lift, null = unknown. */
  resetAt?: number | null;
  /** net only: this retry is HELD behind another session's (`SessionNetRetry.heldBy`,
   *  the holder's session id). Absent = not held. */
  heldBy?: string;
  /** The source's own words: a wall's `needsYou` sentence, the CLI's short
   *  error line for a net give-up. Absent = none given. */
  detail?: string;
}

/** The fields `blockOf` reads — a `SessionInfo` or anything shaped like its slice. */
export type BlockFacts = Pick<SessionInfo, "signedOut" | "login" | "cliSetup" | "limit" | "netRetry" | "signInWait">;

/** `detail` of a session stopped by a sign-out while the account is still signed out. */
export const SIGNED_OUT_DETAIL = "signed out";
/** `detail` once the host confirmed the sign-in: it ASKS, it types nothing until the tap. */
export const SIGNED_IN_AGAIN_DETAIL = "signed in again — continue?";
/** `detail` while the host cannot tell whether the sign-in happened (`signInWait.unsure`):
 *  continue is offered, the person decides. */
export const SIGNIN_UNSURE_DETAIL = "cannot tell whether you signed in again — continue if you have";
/** `detail` while the person's continue waits behind the first session (which goes alone). */
export const SIGNIN_QUEUED_DETAIL = "signed in again — continues after the first session gets through";
/** `detail` while the host's continue for this session is typed and its verdict owed. */
export const SIGNIN_CONTINUING_DETAIL = "continuing after the sign-in";
/** `SessionLimit.held` (and so a limit/spend block's `detail`) while words a person
 *  typed sit in the desk's composer: the host's continue is held, never typed over them. */
export const LIMIT_HELD_DRAFT = "words in the composer at the desk — continue waits until they are sent or cleared";

/** The one block a session is behind, or null when nothing outside it holds it. */
export function blockOf(info: BlockFacts): SessionBlock | null {
  const w = info.signInWait;
  if (info.signedOut || info.login || info.cliSetup || w) {
    const auth = { kind: "auth" as const, since: info.login?.at ?? w?.since ?? null, attempts: 0, nextAt: null };
    // A sign-in link on THIS screen is a sign-in under way here: it needs the person whatever the account says.
    if (!w || info.login) return { ...auth, phase: "needsYou" };
    if (w.continuing) return { ...auth, phase: "retrying", detail: SIGNIN_CONTINUING_DETAIL };
    if (w.queued) return { ...auth, phase: "waiting", detail: SIGNIN_QUEUED_DETAIL };
    // Signed in again: waiting for the person's continue (never typed unasked).
    // The session's own `signedOut` is about its LAST turn and stays until its next one.
    if (w.signedInAt != null) return { ...auth, phase: "waiting", detail: SIGNED_IN_AGAIN_DETAIL };
    // The reader cannot confirm (a stale local "in"): the person's word is the confirmation.
    if (w.unsure) return { ...auth, phase: "needsYou", detail: SIGNIN_UNSURE_DETAIL };
    return { ...auth, phase: "needsYou", detail: SIGNED_OUT_DETAIL };
  }
  const lim = info.limit;
  if (lim?.blocked) {
    const spend = lim.spend === true;
    const base = {
      kind: (spend ? "spend" : "limit") as BlockKind,
      since: lim.blockedSince > 0 ? lim.blockedSince : null,
      attempts: lim.attempts,
      // HELD on a draft: `nextAttemptAt` is only the next look, never a try anybody
      // can count down to — the sentence says why instead.
      nextAt: lim.held && !lim.needsYou ? null : lim.nextAttemptAt,
      resetAt: lim.resetAt,
      ...(lim.needsYou ? { detail: lim.needsYou } : lim.held ? { detail: lim.held } : {}),
    };
    return { ...base, phase: limitPhase(lim) };
  }
  const n = info.netRetry;
  if (n) {
    return {
      kind: "net",
      phase: n.state === "sent" ? "retrying" : n.nextAt != null || n.state === "waiting" ? "waiting" : "gaveUp",
      since: n.at > 0 ? n.at : null,
      attempts: n.attempt,
      nextAt: n.nextAt,
      ...(n.heldBy && n.state === "waiting" ? { heldBy: n.heldBy } : {}),
      ...(n.error ? { detail: n.error } : {}),
    };
  }
  return null;
}

/**
 * The block as a WALL for automatic work (`LaneSessionState.block`): what
 * `blockOf` says, minus the two blocks nothing is working to lift — so a lane
 * that waits on them would wait for ever.
 *
 *  - A net give-up with no next probe (halted, or the retry switched off):
 *    nothing re-arms it, and the next automatic item typed in IS the retry
 *    (before this wall existed, that is exactly what happened).
 *  - `cliSetup` alone (claude's first-launch setup, read once at spawn):
 *    cleared only by the session's first hook, so on a session whose hook pipe
 *    never goes live it would hold for the session's whole life. A real sign-out
 *    on a running session is `signedOut`/`login`, which stay walls.
 *
 * The badge and sheet still show both (`blockOf`); only the hold is dropped.
 */
export function blockWallOf(info: BlockFacts): BlockKind | null {
  const b = blockOf(info);
  if (!b) return null;
  if (b.kind === "net" && b.phase === "gaveUp") return null;
  if (b.kind === "auth" && !info.signedOut && !info.login && !info.signInWait) return null;
  return b.kind;
}

function limitPhase(lim: NonNullable<SessionInfo["limit"]>): BlockPhase {
  if (lim.needsYou != null) return "needsYou";
  if (lim.resuming) return "retrying";
  if (lim.nextAttemptAt != null || lim.queuePos != null) return "waiting";
  if (!lim.autoContinue) return "needsYou";
  // Nothing scheduled, nothing in line, auto-continue on: the host stopped. A
  // spend wall stops BY DESIGN (no reset anybody can name, or its one attempt
  // failed) — it needs the person; a usage window ran out of patience.
  return lim.spend ? "needsYou" : "gaveUp";
}
