// Cut from clihealth.ts (move only): thresholds in one place
// The one door stays `./clihealth.js`; this slice imports its siblings directly, never the barrel.

/**
 * Consecutive misses before a signal reads `degraded`.
 *
 * Two, not one. Each of these misses is already narrow and already
 * user-visible by construction — the host records one only where the app
 * actually lost something (a question box that never reached the phone, a
 * delivery it could not confirm), not on every failed regex of a detector that
 * runs twice a second. But one miss is still a moment: a screen captured
 * mid-repaint, a session two seconds into booting, a log file that appears
 * 200 ms late. Two in a row is a pattern.
 */
export const DEGRADED_MISSES = 2;

/**
 * Consecutive misses before a signal reads `broken`.
 *
 * Five. A heuristic that has failed five times running against five separate
 * inputs is not having a bad moment — nothing in this app retries a heuristic
 * five times for one input — and `broken` is the word that should send somebody
 * to look at the regex.
 */
export const BROKEN_MISSES = 5;

/**
 * Observations kept for the rolling rate, per signal.
 *
 * COUNT-based rather than time-based, and the reason is the shape of the
 * traffic: a fan-out fires twenty deliveries in a minute and a quiet afternoon
 * fires two in eight hours. Any fixed time window is therefore either empty
 * (and says nothing when it matters) or enormous (and averages Monday into
 * Wednesday). "Of the last twenty deliveries, how many were confirmed?" is the
 * question a human actually asks, and it is count-shaped.
 *
 * Twenty, because the failure this exists to catch was 22%: at a window of 20
 * that is four or five bad rows, which trips inside one working session, while
 * still being wide enough that two bad deliveries in a row (a laptop that
 * slept, a session still booting) do not.
 */
export const RATE_WINDOW = 20;

/**
 * Fewest observations before a rate is allowed to mean anything.
 *
 * One miss out of two is 50% and is not a fact about anything. Below this the
 * rate is reported as `null` and the verdict falls back to the streak rules —
 * never to `healthy` on the strength of a rate nobody has enough samples for.
 */
export const RATE_MIN_SAMPLES = 8;

/**
 * Miss fraction at which a rate reads `degraded` — one in five.
 *
 * Set at or below the level that already happened: the measured week ran at
 * 22%, undetected. An alarm calibrated above the failure it was created by is
 * a decoration. Below one in five, an integration that scrapes a terminal is
 * doing roughly what it was designed to do and the app's own recovery paths
 * (`settle.ts`, `opendeliveries.ts`) absorb the rest.
 */
export const RATE_DEGRADED = 0.2;

/** Miss fraction at which a rate reads `broken` — half of everything. At this
 *  point the fallback IS the code path, and calling that "degraded" understates
 *  it: the primary has stopped working and nobody has said so. */
export const RATE_BROKEN = 0.5;

/**
 * How old an observation may be and still count toward the rate.
 *
 * Twelve hours. A rate is a claim about the state of the integration NOW; long
 * enough that this morning's fan-out still informs this afternoon's screen,
 * short enough that a bad Monday can never be the reason Wednesday is red.
 * Aged-out observations still count for `lastGoodAt`/`lastMissAt` — they are
 * dropped from the RATE, not from the history.
 */
export const RATE_MAX_AGE_MS = 12 * 3600_000;

/**
 * How long a signal keeps its verdict once nothing at all is observed.
 *
 * A day. These paths are exercised many times a day when they are exercised at
 * all, so silence for a whole day means the path was not TAKEN — not that it
 * was fixed. Going quiet therefore returns a signal to `unknown`, which is a
 * third thing: not green, not red, "I have not been able to check". Without
 * this a single bad afternoon three weeks ago leaves a permanent red mark, and
 * a permanent mark is one nobody reads.
 *
 * Overridden per signal for the ones that are legitimately rare (a usage block
 * can be weeks apart) — see `CLI_SIGNALS`.
 */
export const SIGNAL_FORGET_MS = 24 * 3600_000;

/** Characters of a captured sample that are kept. Long enough to hold the row a
 *  matcher was matching against plus its neighbours; short enough that two
 *  hundred persisted signals stay a small file. */
export const SAMPLE_CAP = 240;

/** Characters of a fallback label. It is a literal from the call site, never
 *  data — the cap is for a call site that forgets that. */
export const VIA_CAP = 60;

export interface HealthThresholds {
  degradedMisses: number;
  brokenMisses: number;
  rateWindow: number;
  rateMinSamples: number;
  rateDegraded: number;
  rateBroken: number;
  rateMaxAgeMs: number;
  forgetMs: number;
}

export const DEFAULT_THRESHOLDS: HealthThresholds = {
  degradedMisses: DEGRADED_MISSES,
  brokenMisses: BROKEN_MISSES,
  rateWindow: RATE_WINDOW,
  rateMinSamples: RATE_MIN_SAMPLES,
  rateDegraded: RATE_DEGRADED,
  rateBroken: RATE_BROKEN,
  rateMaxAgeMs: RATE_MAX_AGE_MS,
  forgetMs: SIGNAL_FORGET_MS,
};
