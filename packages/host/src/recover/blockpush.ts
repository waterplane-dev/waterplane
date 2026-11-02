/**
 * What the phone is told about a blocked session — the push, the decision-log
 * row and the plan sentence — worded per KIND from this one place.
 *
 * The account wall carries two kinds on one `SessionLimit` (`blockOf`): a plan's
 * usage window (`limit`) and an API-key / cloud account out of credit or over
 * its spend cap (`spend`). They recover differently — a usage window clears by
 * the clock and is retried on a widening ladder (`limitretry.ts`); a spend wall
 * gets ONE try at a reset somebody can name, else it needs the person
 * (`spendwall.ts`) — and a push that called the second "Usage limit" and
 * promised a retry "every N min" told the person to wait for something that was
 * never going to happen. The cadence sentence was stale for the usage limit
 * too: `LIMIT_RETRY_MS` is only the hold-off after a failed resume now, and the
 * real cadence is the ladder, so the plan names the next try when one is
 * booked and otherwise says the tries widen, never a fixed period.
 *
 * Pure: no clock of its own (`now`), the clock format injectable for a test.
 * Wording dodges `limit.ts`'s detection regexes — a session printing this file
 * must not trip them — so the CLI's own sentences are never quoted here.
 * The network give-up has no push yet: it needs a notification kind of its own
 * (`limit` is the person's usage-limit switch), which is a shared change.
 */
import type { SessionInfo, SessionLimit } from "@waterplane/shared";

/** The account wall's lifecycle, as `sessions` emits it (`limit` event). */
export type WallPhase = "blocked" | "scheduled" | "attempt" | "resumed" | "gaveup";

/** Which wall a `SessionLimit` is — `blockOf`'s kind, read off the limit alone
 *  so it still answers once the block has cleared (`resumed`). */
export type WallKind = "limit" | "spend";
export const wallKindOf = (lim: Pick<SessionLimit, "spend"> | null | undefined): WallKind => (lim?.spend === true ? "spend" : "limit");

/** A push, minus its notification kind (always `limit`). */
export interface WallPush {
  title: string;
  body: string;
  sessionId: string;
  tag: string;
  outcome?: "ok" | "failed";
  key?: string;
}

export interface WallWords {
  /** The decision-log row; null for `scheduled` (one a minute would drown the log). */
  log: { question: string; rationale: string } | null;
  /** The push; null where a phase pushes nothing. */
  push: WallPush | null;
  /** The attention key a phase resolves, and the sentence it resolves with. */
  resolve: { key: string; why: string } | null;
}

export const fmtClock = (ms: number): string => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
export const fmtDur = (ms: number): string => {
  const m = Math.max(0, Math.round(ms / 60000));
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
};
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

/**
 * What auto-continue will do about this wall, in one clause — the push body,
 * the blocked row's rationale. Never a promise the ladder does not keep.
 */
export function wallPlan(lim: SessionLimit | null | undefined, clock: (ms: number) => string = fmtClock): string {
  // A source wall nobody can date (`SessionLimit.needsYou`) schedules nothing:
  // say so, in the backend's own words, never "will retry".
  if (lim?.needsYou) return `nothing is retried by itself — it needs you: ${lim.needsYou}`;
  if (!lim?.autoContinue) return "auto-continue is off — resume manually";
  const when = lim.resetAt ? clock(lim.resetAt) : null;
  if (wallKindOf(lim) === "spend") {
    return when
      ? `one try after the reset (~${when}) — if still out of credit, it needs you`
      : "nothing is retried by itself — add credit or raise the spend cap, then resume";
  }
  if (when) return `auto-continue after the reset (~${when})`;
  const next = lim.nextAttemptAt ? clock(lim.nextAttemptAt) : null;
  return next
    ? `auto-continue tries again ~${next}, then less often until the limit lifts`
    : "auto-continue keeps trying, less often each time, until the limit lifts";
}

/** Everything the phone is told for one `limit` event. */
export function wallEventWords(
  phase: WallPhase,
  id: string,
  info: Pick<SessionInfo, "title" | "limit">,
  now: number = Date.now(),
  clock: (ms: number) => string = fmtClock,
): WallWords {
  if (phase === "scheduled") return { log: null, push: null, resolve: null };
  const lim = info.limit;
  const spend = wallKindOf(lim) === "spend";
  const next = lim?.nextAttemptAt ? clock(lim.nextAttemptAt) : null;
  const att = lim?.attempts ?? 0;
  const dur = lim?.blockedSince ? fmtDur(now - lim.blockedSince) : "";
  const tag = `limit-${id}`;

  if (phase === "blocked") {
    const plan = wallPlan(lim, clock);
    const question = lim?.needsYou ? "Session stopped: its CLI reports a wall with no time it lifts."
      : spend ? "Session stopped: the account is out of credit or over its spend cap."
      : "Session stopped at the Claude usage limit.";
    const title = lim?.needsYou ? "Needs you" : spend ? "Out of credit" : "Usage limit";
    return {
      log: { question, rationale: plan.charAt(0).toUpperCase() + plan.slice(1) + "." },
      push: { title: `${title} · ${info.title}`, body: plan, sessionId: id, tag },
      resolve: null,
    };
  }
  if (phase === "attempt") {
    const after = spend ? "it needs you" : `retry${next ? ` ~${next}` : " later"}`;
    return {
      log: {
        question: `Auto-continue attempt ${att} — typing "continue" into the session.`,
        rationale: spend ? "If still blocked, it needs you — add credit or raise the spend cap." : next ? `If still blocked, next retry ~${next}.` : "",
      },
      // Same tag as the blocked push: a state update, not a new thread.
      push: { title: `Auto-continue sent · ${info.title}`, body: `attempt ${lim?.attempts ?? "?"} — "continue" typed; still blocked → ${after}`, sessionId: id, tag },
      resolve: null,
    };
  }
  if (phase === "resumed") {
    const lifted = spend ? "spend wall lifted" : "usage limit lifted";
    return {
      log: { question: `${spend ? "Spend wall" : "Usage limit"} lifted — session resumed.`, rationale: `${plural(att, "attempt")}${dur ? ` · blocked ${dur}` : ""}` },
      push: { title: `Session resumed · ${info.title}`, body: `${lifted} after ${plural(att, "attempt")}${dur ? ` · blocked ${dur}` : ""} — work continues`, sessionId: id, tag: `${tag}-done`, outcome: "ok" },
      resolve: { key: `limit:${id}`, why: "session resumed" },
    };
  }
  // gaveup
  return {
    log: {
      question: `Auto-continue gave up after ${plural(att, "attempt")}.`,
      rationale: spend ? "Still blocked — add credit or raise the spend cap, then resume." : "Still blocked — resume manually.",
    },
    push: {
      title: `Auto-continue gave up · ${info.title}`,
      body: spend ? `still out of credit after ${plural(att, "attempt")} — add credit or raise the spend cap, then resume` : `still limit-blocked after ${att} attempts — resume manually`,
      sessionId: id, tag: `${tag}-done`, outcome: "failed", key: `limit:${id}`,
    },
    resolve: null,
  };
}

/** The account's sign-in episode moved (`recover/authgate.ts`): `signedOut` when it began,
 *  `signedIn` when the host confirmed the sign-in, `stillOut` when a confirmed episode turned
 *  out still signed out (a continue refused, another sign-out), `ended` when nobody waits any more. */
export type SignInTransition = "signedOut" | "signedIn" | "stillOut" | "ended";

/** What `sessions` emits as `signIn` (`sessions/signinwait.ts`): the transition, the sessions it
 *  counts, and the account key (`claude|<config dir>`). */
export interface SignInEvent { transition: SignInTransition; n: number; account: string }

/** The attention key both sign-in pushes are filed under: the second REPLACES the first, and
 *  the episode emptying resolves it. One per account — today one claude.ai sign-in per host. */
export const SIGNIN_KEY = "signin";

/**
 * The words for one sign-in transition — push ONCE per transition, never per session, opening
 * the blocked sheet. After the sign-in it ASKS (owner, 2026-11-02): nothing is typed until the
 * person taps continue. `ended` pushes nothing; it resolves the standing item with `resolve`.
 */
export function signInWords(t: SignInTransition, n: number): { push: { title: string; body: string; tag: string; key: string } | null; resolve: string | null } {
  const sessions = plural(n, "session");
  if (t === "signedOut") {
    return {
      push: { title: `Signed out — ${sessions} stopped`, body: `Sign in once from any of them; ${n === 1 ? "it waits" : "they wait"} for you and nothing is lost.`, tag: SIGNIN_KEY, key: SIGNIN_KEY },
      resolve: null,
    };
  }
  if (t === "signedIn") {
    return {
      push: { title: `Signed in again — continue the ${n === 1 ? "session" : sessions} that stopped?`, body: `Nothing is typed until you tap continue; the first goes alone, the rest once it gets through.`, tag: SIGNIN_KEY, key: SIGNIN_KEY },
      resolve: null,
    };
  }
  if (t === "stillOut") {
    // Under the same key: REPLACES the standing "signed in again" item rather than adding one.
    return {
      push: { title: "Still signed out — sign in again", body: `The account is still signed out; ${n === 1 ? "the session waits" : `${sessions} wait`}. Nothing is typed until you tap continue.`, tag: SIGNIN_KEY, key: SIGNIN_KEY },
      resolve: null,
    };
  }
  return { push: null, resolve: "no session waits for a sign-in any more" };
}
