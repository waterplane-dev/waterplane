/**
 * The one wording of the host's retry of a turn the CLI gave up on a transient
 * API error (`SessionNetRetry`) — the phone's line and the host's log say the
 * same thing. Pure; the clock is the caller's (the phone's, at render).
 */
import type { SessionNetRetry } from "./wire/session.js";

/** What a HELD net retry (`SessionNetRetry.heldBy`) says it waits for. The host also
 *  writes it to `why`, for a phone that predates the field. */
export const NET_HELD_WHY = "waiting for another session's retry to get through first";

/** The reason a `waiting` retry gives, if any: the field (`heldBy`) first, then the
 *  host's own sentence (`why`, an older host's way of saying the same). */
export function netRetryWhy(n: SessionNetRetry): string | undefined {
  return n.heldBy ? NET_HELD_WHY : n.why || undefined;
}

/** "40s", "2m", "1m 30s" — whole seconds, never negative. */
export function netRetryWait(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60), r = s % 60;
  return r ? `${m}m ${r}s` : `${m}m`;
}

/**
 * The line under a session whose turn ended on a transient API error:
 *  - waiting: "Network error — retrying in 40s (2/8)"
 *  - sent:    "Network error — retried (2/8), waiting for the reply"
 *  - gaveup:  "Network error — stopped retrying after 8 tries. Type to try again."
 * Null for an absent value, so a caller never draws an empty line.
 */
export function netRetryLine(n: SessionNetRetry | null | undefined, now: number): string | null {
  if (!n) return null;
  if (n.state === "waiting") {
    const when = n.nextAt != null ? `retrying in ${netRetryWait(n.nextAt - now)}` : "retry waiting";
    return `Network error — ${when} (${n.attempt + 1}/${n.max})${netRetryWhy(n) ? ` · ${netRetryWhy(n)}` : ""}`;
  }
  if (n.state === "sent") {
    return n.probe
      ? `Network error — tried once more (try ${n.attempt}), waiting for the reply`
      : `Network error — retried (${n.attempt}/${n.max}), waiting for the reply`;
  }
  const probe = n.nextAt != null ? `; one more try in ${netStallWait(n.nextAt - now)}` : "";
  return `Network error — stopped retrying${n.why ? `: ${n.why}` : ""}${probe}. Type to try again.`;
}

/** The stall probe's wait: whole minutes (rounded up) past one minute, so the
 *  note does not tick every second for half an hour. */
export function netStallWait(ms: number): string {
  return ms < 60_000 ? netRetryWait(ms) : `${Math.ceil(ms / 60_000)}m`;
}

/**
 * Whether a session's net retry means work waiting on it is STALLED: the
 * ladder gave up (`gaveup`, dismissed or not), or a stall probe is under way
 * (`probe`). The ONE predicate — the phone's note (`netStalledOf`), the host's
 * silence sweep (`IntentDeps.sessionNetStalled`) and the serial sentence
 * (`SerialSessionState.netStalled`) all ask it.
 */
export function netRetryStalls(n: SessionNetRetry | null | undefined): boolean {
  return !!n && (n.state === "gaveup" || n.probe === true);
}

/**
 * What a turn end says about the host's net retry, carried on the host's
 * `turnEnded` event (and `netTurnSettled`, the late answer to `checking`) so
 * deferred work waiting on that turn (`intents/watch.ts`) does not complete off
 * a turn the CLI gave up on:
 *  - `retrying`: a `continue` is armed — the turn is not done, nothing happened yet;
 *  - `checking`: our `continue`'s turn ended and its log row has not landed —
 *    the verdict follows as `netTurnSettled` ~1.5 s later;
 *  - `gaveup`: the API stayed unreachable and the retries ran out (or the halt
 *    stopped them) — the work is STALLED: it stays `running` (never failed,
 *    never re-fired) until a real turn end; `detail` is the sentence for it.
 *  - `signedOut`: the turn ended because the CLI is not signed in (claude's
 *    `StopFailure authentication_failed`) — nothing ran, so the work waiting on
 *    it stays `running` exactly like `gaveup`, until a real turn end after a
 *    sign-in. Not a net give-up: the net retry is not asked about this turn.
 * Absent = an ordinary turn end.
 */
export type TurnEndNet =
  | { net: "retrying" }
  | { net: "checking" }
  | { net: "gaveup"; detail: string }
  | { net: "signedOut" };

/** What became of the turn when the retries ran out, as one sentence (carried on
 *  `TurnEndNet.detail`; the work waiting on it is stalled, not failed by it). */
export function netGaveUpDetail(error: string, why: string): string {
  return `the API could not be reached (${error}) and the host stopped retrying ${why} — the work did not run; check the conversation before running it again`;
}

/**
 * A piece of work that is STALLED on the API (R-connection-024): its row is
 * `running` — the prompt was delivered, so at-most-once never re-fires it — and
 * the session it runs in has a `gaveup` net retry. DERIVED, never stored: the
 * row carries no field for it, so every reader (the backlog row, the Activity
 * row, a test) asks this with the row and the live sessions. The host's
 * watchdog asks the same fact of the session (`intents/watch.ts`'s
 * `sweepRunning`), so a stalled row is never failed for its silence.
 * Null for anything else: a row not running, no session, a retry still going.
 */
export function netStalledOf(
  row: { state: string; sessionId?: string | null },
  sessions: readonly { id: string; netRetry?: SessionNetRetry | null }[],
): SessionNetRetry | null {
  if (row.state !== "running" || !row.sessionId) return null;
  const n = sessions.find((s) => s.id === row.sessionId)?.netRetry;
  return n && netRetryStalls(n) ? n : null;
}

/**
 * The note a stalled row wears: "Stalled — API unreachable, 8 retries used ·
 * next try in 23m" (the stall probe, `nextAt` on a `gaveup`), or "… · trying
 * again now" while a probe runs. A `waiting` record that says WHY it waits
 * (held behind another session's stalled probe, `SessionNetRetry.why`) says
 * that instead, with the clock it waits for when there is one. `now` is the
 * caller's clock; without it the probe clause is left out rather than guessed.
 */
export function netStalledText(n: SessionNetRetry, now?: number): string {
  const used = n.attempt === 1 ? "1 retry used" : `${n.attempt} retries used`;
  // `why` opens with the count ("after 8 tries") the note already says; only
  // what follows it (the halt, the switch being off) is worth a clause.
  const rest = n.state === "gaveup" ? (n.why ?? "").replace(/^after \d+ tr(?:y|ies)(?: — )?/, "").trim() : "";
  const next = n.nextAt != null && now != null ? ` · next try in ${netStallWait(n.nextAt - now)}` : "";
  const probe = n.state === "gaveup" ? next
    : n.state === "waiting" && netRetryWhy(n) ? ` · ${netRetryWhy(n)}${next}`
    : " · trying again now";
  return `Stalled — API unreachable, ${used}${rest ? ` (${rest})` : ""}${probe}`;
}

/**
 * The note work wears while its session is SIGNED OUT (`TurnEndNet` `signedOut`,
 * `blockOf(s)?.kind === "auth"`): the row stays `running` — held exactly like a
 * net stall, never failed for its silence (`intents/watch.ts`) — and says why.
 * One sentence for every reader; "continue" is the person's tap after signing in.
 */
export const SIGNED_OUT_STALL_TEXT = "stopped: the CLI is signed out — sign in, then continue";

/** What "Retry now" does, as the line beside it and its receipt. */
export const NET_RETRY_NOW_NOTE = "Retry now types “continue” into that session, the way the automatic retry does; the work completes on the next real reply.";
export const NET_RETRY_NOW_SENT = "retrying now — “continue” is typed once the session is quiet";
