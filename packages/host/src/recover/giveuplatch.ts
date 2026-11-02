/**
 * THE give-up latch: a recovery that stops trying says so ONCE per episode.
 *
 * Every give-up path is re-asked while the session stays blocked — the minute
 * sweep re-enters `scheduleLimitAttempt`, an exited session is re-examined on
 * every scan, a stalled net retry gives up again after every probe — so a
 * give-up that announced itself from each of them pushed once a minute, or
 * once a probe, for as long as the block stood. And two copies of the latch
 * meant one path could forget it: the wall's max-attempts branch emitted
 * `gaveup` with no latch at all.
 *
 * One latch per LANE, because a lane is one episode: `wall` is the account wall
 * (usage limit and spend share one `SessionLimit`, so a block whose kind is
 * re-read mid-wall is still one wait), `net` is the net retry's episode (from
 * its first rung to a served reply, a person typing, or a wall). The latch is
 * set by the transition (`giveUpOnce`), cleared where an episode ends or a new
 * one begins (`endGiveUp`), and taken silently by a restored stall that was
 * announced before the restart (`holdGiveUp`).
 *
 * Memory only, on the session (`Session.gaveUp`): a host restart forgets it,
 * which re-announces at most one give-up per blocked session — the direction
 * that tells a person too much, never too little.
 */

/** Which recovery a give-up belongs to — one episode each. */
export type RecoveryLane = "wall" | "net";

/** Lanes that have announced their give-up for the episode they are in. */
export type GiveUpLatch = Partial<Record<RecoveryLane, true>>;

/** Anything carrying the latch (a `Session`, or a test's fake of one). Absent = none held. */
export interface Latched { gaveUp?: GiveUpLatch }

/** Has this lane's give-up been announced for the episode it is in? */
export function giveUpHeld(s: Latched, lane: RecoveryLane): boolean {
  return s.gaveUp?.[lane] === true;
}

/** The episode ended (or a new one began): the next give-up is owed its own word. */
export function endGiveUp(s: Latched, lane: RecoveryLane): void {
  if (s.gaveUp?.[lane]) delete s.gaveUp[lane];
}

/** Take the latch WITHOUT announcing — a give-up already announced before a restart. */
export function holdGiveUp(s: Latched, lane: RecoveryLane): void {
  (s.gaveUp ??= {})[lane] = true;
}

/**
 * THE transition: `announce` runs exactly once per episode, the first time the
 * lane gives up; every later call is a no-op. True when this call announced.
 */
export function giveUpOnce(s: Latched, lane: RecoveryLane, announce: () => void): boolean {
  if (giveUpHeld(s, lane)) return false;
  holdGiveUp(s, lane);
  announce();
  return true;
}
