/**
 * **When to try a limit-blocked session again — and when to stop.**
 *
 * Lifted out of `SessionManager` as a pure decision for the reason
 * `sessionSearch.ts` was: what it answers is arithmetic
 * over four numbers, the failure it had was invisible on a screen, and the
 * sentence worth having when it rots is "this cadence gives up before the reset
 * it is waiting for" rather than "the session never came back".
 *
 * ── The failure this replaces ────────────────────────────────────────────────
 *
 * A WEEKLY wall was scheduled as *now + 5 s, then every ten minutes*, bounded by
 * an attempts cap of 24. The 5 s had a good argument behind it — a weekly
 * banner prints a bare clock time with no date, so the reset it resolves to is
 * the wrong day, and a plan that has just been upgraded serves immediately, so
 * probing is worth one attempt. The cadence behind it did not: twenty-four
 * attempts ten minutes apart is under four hours, and a weekly window resets
 * DAYS later. Every weekly wall therefore ran out of attempts on the same
 * afternoon, emitted `gaveup`, and the conversation stayed shut until somebody
 * reopened it by hand — while the phone had been told it would come back.
 *
 * Three rules replace it, and each one is a thing that was being conflated:
 *
 *  1. **A DATED reset is trusted, weekly or not.** What is unreliable is a bare
 *     time scraped off a screen, not the instant the CLI recorded in its own log
 *     (`limitlog.ts`'s `resetsAt`). Those were being thrown away together.
 *  2. **Waiting is not churn.** With no dated reset the delay WIDENS —
 *     `LADDER_MS` — instead of hammering a flat cadence: a few quick probes for
 *     the cases that resolve immediately, then hours between attempts, which is
 *     the right rate for something that resets next week.
 *  3. **Patience is a CLOCK, not a count.** The attempts cap is a churn guard
 *     and says nothing about how long a wall may last; `giveUpMs` is the bound
 *     that means what "stop waiting" should mean. A session may now wait out a
 *     weekly window and still stop rather than retrying for ever.
 */

/**
 * The widening delay, by attempt index, when nobody has dated the reset.
 *
 * The first rung is short on purpose (an upgraded plan, or a banner left over
 * from a wall that has already lifted, both answer immediately); the last is the
 * cap, and it is the one that has to be small enough that the reset is not
 * missed by much and large enough that a week costs tens of attempts rather than
 * hundreds. Six hours puts the worst case at a quarter-day late on a window
 * measured in days.
 */
export const LADDER_MS: readonly number[] = [
  5_000,
  60_000,
  5 * 60_000,
  30 * 60_000,
  2 * 3_600_000,
  6 * 3_600_000,
];

export interface LimitRetryInput {
  /** Attempts already spent on THIS block (`SessionLimit.attempts`). */
  attempts: number;
  /**
   * The reset as an INSTANT, or null when nobody could date one.
   *
   * Null is the honest value for a screen-scraped weekly banner: its bare time
   * resolves to today, which is the wrong day. A dated instant from the CLI's
   * own log belongs here whether the window is weekly or five-hourly.
   */
  resetAt: number | null;
  /** When this block started (`SessionLimit.blockedSince`). */
  blockedSince: number;
  now: number;
  /** Host-wide hold-off: a resume that came back still blocked proves the wall
   *  is up for the ACCOUNT, so no session's next attempt may precede it. */
  holdUntil?: number;
  /** Fire this long after the reset instant, so a clock a second fast does not
   *  spend an attempt on a wall that is still up. */
  buffer: number;
  /**
   * The FIRST rung, when something needs it shorter than five seconds.
   *
   * A knob for the same reason every other timing in this subsystem has one: an
   * e2e cannot sit out a real cadence, and a test that waits for the production
   * delay is a test nobody runs. Absent means `LADDER_MS[0]`; it never affects
   * the rungs after it, so a shortened probe cannot turn the backoff into the
   * flat cadence this module replaced.
   */
  probeMs?: number;
  /**
   * The whole ladder, when a caller has its own.
   *
   * `probeMs`'s argument, one rung further: a test about the SECOND wall cannot
   * sit out a minute any more than one about the first can sit out five
   * seconds. Absent means `LADDER_MS`, which is the only value production ever
   * passes — an override short enough to be sat out is short enough to be the
   * flat cadence this module exists to replace, so it belongs to tests.
   */
  ladder?: readonly number[];
  /** Churn guard. It bounds how MANY times we try, never how long we wait. */
  maxAttempts: number;
  /** Patience. Past this much of one continuous block, stop. */
  giveUpMs: number;
}

export type LimitRetry =
  | { kind: "at"; at: number; why: "probe" | "reset" | "backoff" }
  | { kind: "giveup"; why: string };

/**
 * The next attempt for one blocked session, or the reason there is no next one.
 *
 * `why` on the `at` branch is what the log and the tests read: *probe* is the
 * one cheap early try, *reset* is an instant somebody actually recorded, and
 * *backoff* is the widening wait for a wall nobody dated.
 */
export function nextLimitAttempt(i: LimitRetryInput): LimitRetry {
  // Patience first: a block that has lasted longer than anybody means by "it
  // comes back at the reset" is over, whatever the attempt count says. Stated
  // in whole hours because that is the unit the sentence is read in.
  const blockedFor = i.now - i.blockedSince;
  if (i.blockedSince > 0 && blockedFor >= i.giveUpMs) {
    return { kind: "giveup", why: `blocked for ${Math.round(blockedFor / 3_600_000)}h — longer than this desktop waits out a usage limit` };
  }
  if (i.attempts >= i.maxAttempts) {
    return { kind: "giveup", why: `${i.attempts} attempts on one block — stopping rather than retrying for ever` };
  }
  const floor = Math.max(i.now, i.holdUntil ?? 0);
  // The two candidates, and the answer is the EARLIER of them.
  //
  //  - the ladder: when the next check-in would be if nobody had dated
  //    anything. The first rung is short on purpose (an upgraded plan, or a
  //    banner left over from a wall that has already lifted, both answer
  //    immediately and cost one attempt to find out), and it widens from there.
  //  - the reset: an instant somebody actually recorded, trusted whatever the
  //    window is. A reset in the PAST is not an instant to wait for and falls
  //    through to the ladder rather than firing in a loop.
  //
  // Taking the earlier is what keeps BOTH properties. Waiting only for the
  // reset means a wall that lifts early — an upgraded plan, a reset parsed a
  // day late — is never noticed; hammering only the ladder is the cadence that
  // ran a weekly wall out of attempts in an afternoon. So: check in on the
  // ladder while the reset is far away, and land exactly on the reset once it
  // is the nearer of the two.
  const ladder = i.ladder?.length ? i.ladder : LADDER_MS;
  const rung = i.attempts === 0 && i.probeMs != null && i.probeMs > 0
    ? i.probeMs
    : ladder[Math.min(i.attempts, ladder.length - 1)];
  const rungAt = i.now + rung;
  const target = i.resetAt != null ? i.resetAt + i.buffer : null;
  // **A reset we can sit out is sat out.** Within one slowest check-in of now,
  // the instant IS the answer — second-guessing it would spend attempts at a
  // wall somebody has already told us the end of, and typing `continue` at a
  // live wall costs a queue slot and the host-wide hold-off behind it.
  //
  // Past that horizon the ladder runs underneath the wait instead, because the
  // instant may be days out and a wall that lifts EARLY — an upgraded plan, a
  // reset parsed a day late — would otherwise never be noticed. The attempt
  // still lands exactly on the reset once it comes inside the horizon.
  const horizon = ladder[ladder.length - 1];
  const useReset = target != null && target > i.now && (target <= rungAt || target - i.now <= horizon);
  const at = Math.max(floor, useReset ? (target as number) : rungAt);
  return { kind: "at", at, why: useReset ? "reset" : i.attempts === 0 ? "probe" : "backoff" };
}

/**
 * What a session that has just been REOPENED into a wall should count as: the
 * block it was carrying, or a fresh one.
 *
 * Here rather than inline in `markLimitBlocked` because it is the rule that
 * silently defeated everything above it. A reopened conversation re-blocks
 * seconds later, and "a block beginning" zeroed `attempts` and stamped
 * `blockedSince` now — so across a resurrection the backoff restarted at its
 * shortest rung and the patience clock restarted at zero, every time. A weekly
 * wall then reopened the conversation for days, hundreds of processes deep, and
 * neither bound was ever reached because neither was ever more than one reopen
 * old.
 *
 * Stale carries are dropped rather than trusted: a session that came back,
 * worked for a week and met a NEW wall must not adopt the old one's clock and
 * give up on arrival.
 */
export interface CarriedBlock {
  attempts: number;
  blockedSince: number;
  /** When the carry was written — i.e. when the reopen happened. */
  at: number;
}

export function adoptCarriedBlock(
  carried: CarriedBlock | undefined | null,
  now: number,
  carryMs: number,
): { attempts: number; blockedSince: number; carried: boolean } {
  if (carried && now - carried.at <= carryMs && carried.blockedSince > 0) {
    return { attempts: carried.attempts, blockedSince: carried.blockedSince, carried: true };
  }
  return { attempts: 0, blockedSince: now, carried: false };
}
