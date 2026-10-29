/**
 * The one wording of the host's retry of a turn the CLI gave up on a transient
 * API error (`SessionNetRetry`) — the phone's line and the host's log say the
 * same thing. Pure; the clock is the caller's (the phone's, at render).
 */
import type { SessionNetRetry } from "./wire/session.js";

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
    return `Network error — ${when} (${n.attempt + 1}/${n.max})${n.why ? ` · ${n.why}` : ""}`;
  }
  if (n.state === "sent") return `Network error — retried (${n.attempt}/${n.max}), waiting for the reply`;
  return `Network error — stopped retrying${n.why ? `: ${n.why}` : ""}. Type to try again.`;
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
 *    stopped them) — the work did not happen, and `detail` says so.
 * Absent = an ordinary turn end.
 */
export type TurnEndNet =
  | { net: "retrying" }
  | { net: "checking" }
  | { net: "gaveup"; detail: string };

/** The sentence a piece of work waiting on the turn is FAILED with when the retries ran out. */
export function netGaveUpDetail(error: string, why: string): string {
  return `the API could not be reached (${error}) and the host stopped retrying ${why} — the work did not run; check the conversation before running it again`;
}
