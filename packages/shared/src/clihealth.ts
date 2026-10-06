/**
 * The CLI integration's own health — "is the app still able to read the thing
 * it is driving, and if not, since when, and what did it last see?"
 *
 * Everything this app does rests on driving a TUI it does not own: regex
 * heuristics over rendered output (`host/prompt.ts`, `host/limit.ts`,
 * `host/context.ts`), a hook pipe that curls lifecycle events back at the
 * daemon, an echo read off the composer, and a conversation `jsonl` whose shape
 * upstream is free to change. The house rule for all of them is **degrade to
 * null, never to a wrong answer**, and that rule stands. What this file changes
 * is that degrading to null stops being QUIET.
 *
 * The failure that produced it was not a crash. 22% of deliveries came back
 * `unconfirmed` for a week, two thirds of them prompts that had actually run,
 * and nobody knew — because every single one of those failures was handled
 * gracefully, individually, in a code path designed to handle it. Graceful
 * degradation that nobody is told about is indistinguishable from working, and
 * it is how one wheel goes missing without the pilot noticing.
 *
 * Five things follow, and they are the whole design:
 *
 *   • **A rate is a signal.** "Every delivery handled its own failure" and
 *     "one send in five is being reported to the user as a gravestone" are both
 *     true at once. Only the second is actionable, and only a rolling window
 *     can say it. See `RATE_*`.
 *   • **`unknown` is not `healthy`.** A signal with no observations has proved
 *     nothing. Collapsing the two is exactly how a dead probe reads green — the
 *     same mistake `attach.ts` refuses to make between `unknown` and `missing`,
 *     and `useRemoteResource.ts` between `error` and `offline`.
 *   • **A version change clears the history.** The CLI's version is part of the
 *     record because an upgrade is the single most likely cause of a heuristic
 *     breaking, and yesterday's successes are statements about a binary that is
 *     no longer running. See `rearmForVersion`.
 *   • **Taking a fallback is an observation.** Silence heuristics instead of
 *     hooks, our own history instead of the conversation log — the fallback is
 *     what keeps the app flying, and the record is what stops it being
 *     permanent.
 *   • **An observation is only a miss if the primary rule was the RIGHT RULE
 *     and failed.** A rule that correctly declines to fire is the rule working,
 *     and recording it as a degradation converts a healthy heuristic into a
 *     permanent amber chip — which teaches the one person who can act on this
 *     board to ignore it, and costs the feature everything. See `HealthOutcome`
 *     for the three things a call site may say and the fourth thing it must say
 *     by saying nothing.
 *   • **The sentence is generated here.** One wording, so the host's
 *     notification, the phone's badge and a log line cannot describe the same
 *     fact three different ways.
 *
 * Pure and DOM-free like everything else in `shared/`: no filesystem, no
 * `Date.now()` inside a rule (time is always a parameter), no import from
 * `packages/host`. So `shared/dist` runs under node and `npm run test:unit` can
 * pin every threshold with no host to boot — which matters more here than
 * usual, because the states this file is about are ones a host cannot be asked
 * to produce on demand.
 */

// ── Thresholds, in one place ────────────────────────────────────────────
//
// A signal that fires constantly is noise, and noise is ignored, which is the
// same as not having the signal at all. Every number below is defended, because
// the temptation when one of these misfires is to nudge it quietly and the
// second nudge is the one that turns the readout off.

// The one door. The code lives in `./clihealth/` (a slice per subject, listed below);
// importers keep saying `./clihealth.js`. docs/notes/shared-architecture.md.

export {
  DEGRADED_MISSES,
  BROKEN_MISSES,
  RATE_WINDOW,
  RATE_MIN_SAMPLES,
  RATE_DEGRADED,
  RATE_BROKEN,
  RATE_MAX_AGE_MS,
  SIGNAL_FORGET_MS,
  SAMPLE_CAP,
  VIA_CAP,
  DEFAULT_THRESHOLDS,
} from "./clihealth/healththresholds.js";
export type {
  HealthThresholds,
} from "./clihealth/healththresholds.js";
export {
  CLI_SIGNALS,
  signalSpec,
  thresholdsFor,
} from "./clihealth/healthcatalog.js";
export type {
  SampleMode,
  CliSignalSpec,
  CliSignalId,
} from "./clihealth/healthcatalog.js";
export {
  emptyHealth,
  blankSignal,
  shapeOf,
  redactSample,
  captureSample,
  observe,
  rearmForVersion,
  noteCliVersion,
  signalVerdict,
  agoText,
  healthSentence,
  supersededByGood,
} from "./clihealth/healthrecord.js";
export type {
  HealthObservation,
  SignalRecord,
  CliHealth,
  HealthOutcome,
  ObserveOpts,
  HealthVerdict,
  HealthCheck,
} from "./clihealth/healthrecord.js";
export {
  unhealthySignals,
  healthRollup,
  cleanHealth,
} from "./clihealth/healthrollup.js";
export type {
  HealthRollup,
} from "./clihealth/healthrollup.js";
