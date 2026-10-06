// Cut from clihealth.ts (move only): the signal catalog
// The one door stays `./clihealth.js`; this slice imports its siblings directly, never the barrel.

import { DEFAULT_THRESHOLDS, type HealthThresholds } from "./healththresholds.js";

// ── The catalog ─────────────────────────────────────────────────────────

/**
 * How a failing input may be captured.
 *
 * This is the redaction rule, and it is declared on the SIGNAL rather than left
 * to the call site on purpose. A screen and a conversation log carry whatever
 * the agent happened to print — a file it just read, an environment it just
 * dumped, the user's own prose — so "remember to sanitize before you record"
 * is a rule that holds until somebody adds the eleventh call site. `observe()`
 * applies the mode itself, so a caller that hands prose to a `shape` signal
 * cannot leak it: the characters never enter the record.
 *
 *   • `line`  — the input is TUI CHROME the CLI drew: a dialog footer, a meter
 *               row, a banner, an option row. Kept as text (redacted, capped),
 *               because "this line no longer matches" is only actionable if the
 *               line is kept, and that is the whole point of a sample.
 *   • `shape` — the input is PROSE somebody wrote: a prompt, a log record, an
 *               option's description. No characters survive. What is kept is
 *               the structure (`shapeOf`), which is what the parse was reasoning
 *               about anyway: how many lines, how long, how wide.
 */
export type SampleMode = "line" | "shape";

export interface CliSignalSpec {
  id: CliSignalId;
  /** Verb phrase, used as the subject of the generated sentence. */
  name: string;
  /** What breaks in the app when this stops working. */
  means: string;
  capture: SampleMode;
  /** What the app does instead when this misses — named in the readout, because
   *  a fallback that nobody knows is running becomes the architecture. */
  fallback?: string;
  thresholds?: Partial<HealthThresholds>;
}

/**
 * Every point where this app reads something it does not own.
 *
 * Declared as a list rather than a bare union for the same reason
 * `NOTIFICATION_KINDS` is: it is also the ORDER a readout lists them in, and
 * the set a persisted record is validated against — a signal removed from here
 * must not keep occupying a row in a file written by an older host.
 */
export const CLI_SIGNALS: readonly CliSignalSpec[] = [
  {
    id: "prompt.box",
    name: "Reading a question box off the screen",
    means:
      "The choice-box detector. When it stops matching there is no error and no empty state — a live question simply never reaches the phone, and the session sits blocked in silence.",
    capture: "line",
    fallback: "the weaker “something is asking you something” flag",
  },
  {
    id: "prompt.submit",
    name: "Placing the cursor on a multi-select Submit row",
    means:
      "Where the answer keystroke goes on a checkbox box. Without it the app sends a bare Return, which toggles whatever row the cursor happens to be on instead of submitting.",
    capture: "line",
    fallback: "a bare Return",
  },
  {
    id: "askbox.enrich",
    name: "Reading the CLI's own words for a question box",
    means:
      "The full question and per-option descriptions, taken from the conversation log rather than the truncated screen. Without it the phone shows one-tap buttons whose explanation is nowhere on the device.",
    capture: "shape",
    fallback: "the labels as the terminal cut them",
  },
  {
    id: "limit.reset",
    name: "Reading when a usage block ends",
    means:
      "The reset instant parsed out of the CLI's own block notice. Without it a blocked session has no time to resume at and waits for a blind sweep instead.",
    capture: "line",
    fallback: "a periodic re-scan with no scheduled resume",
    // A usage block is not a daily event, so a day of silence here says nothing
    // about the parser. Thirty days is long enough to span the gaps and short
    // enough that a verdict never outlives the CLI version that earned it.
    thresholds: { forgetMs: 30 * 24 * 3600_000 },
  },
  {
    id: "context.meter",
    name: "Reading the context-window figure",
    means:
      "The context badge. A miss hides a number rather than losing work, which is why it is the one signal here allowed to fail a few more times before it is worth a word.",
    capture: "line",
    // Lowest stakes on the board: nothing is lost, a badge is absent. Flagging
    // it at the same sensitivity as a lost question box would put the two in
    // the same list and teach the reader to skim it.
    thresholds: { degradedMisses: 4, brokenMisses: 10 },
  },
  {
    id: "hook.pipe",
    name: "The CLI's lifecycle hooks",
    means:
      "The positive turn-boundary signal. Without it a session falls back to guessing from silence, so turn ends get mushy, the backlog's readiness is a timer, and auto-fire can land mid-task.",
    capture: "shape",
    fallback: "silence heuristics",
  },
  {
    id: "deliver.echo",
    name: "Confirming a prompt reached the composer",
    means:
      "The echo probe. When it stops finding text, deliveries come back unconfirmed — which is not a lost prompt but is reported to the user as one, and is the exact signal that ran at 22% for a week.",
    capture: "shape",
    fallback: "asking the conversation log later",
    // Rate-led, deliberately. A run of misses here is ordinary — one busy
    // session repainting through a fan-out produces several in a row and none
    // of them mean the probe is broken. What means something is the fraction,
    // so the streak thresholds are loosened rather than removed: eight in a row
    // is beyond what a busy screen explains.
    //
    // The thresholds are also why a ~30% reading was believed for as long as it
    // was: it sat just the right side of amber. It was not the probe. The probe
    // FOUND the text and `deliver.ts` refused to PLACE it, because "within ~11
    // rows of the bottom of the render" measures a torn repaint rather than the
    // composer. The rule is structural now — is the text inside the box the CLI
    // draws to take typing (`echo.ts`'s `composerEcho`, the same one
    // `settle.ts` asks later) — and the distance test survives only for a
    // screen with no such box on it.
    //
    // And one thing `deliver.ts` deliberately does NOT record here, the "right
    // rule" rule above again: a composer that ALREADY holds text this app
    // cannot tell apart from the caller's. Nothing has been typed at that
    // point, so no echo of our text was ever owed; the probe declining to
    // credit a stranger's words to this delivery is it working. It fires on a
    // re-send of a prompt whose first attempt is still in the box, which is the
    // commonest shape there is, so counting it would have pinned this signal
    // amber for ever.
    thresholds: { degradedMisses: 5, brokenMisses: 8 },
  },
  {
    id: "deliver.submit",
    name: "Confirming a submitted prompt started a turn",
    means:
      "Proof the Return was not swallowed. When it fails the app says the text is sitting unsent in a composer — a specific, actionable claim that must not be made about a prompt that is running.",
    capture: "shape",
    fallback: "asking the conversation log later",
    // Two things `deliver.ts` deliberately does NOT record here, both of them
    // the "right rule" rule above and both of them found on the live host:
    // interjecting into a session that is already working (the turn started
    // before the Return did, so there is no turn-start to observe — that is a
    // fact about how the app is used, not about the CLI), and a hook that lands
    // during the press-and-look loop (the pipe was alive, the host simply had
    // not heard from it yet — the proof turning up late is the primary rule
    // answering). Counting either read 5 of 20 on a path whose sent log says
    // every one of those deliveries came back `ok`.
    thresholds: { degradedMisses: 5, brokenMisses: 8 },
  },
  {
    id: "transcript.jsonl",
    name: "Reading the CLI's conversation log",
    means:
      "The reader view, the archive titles, and the evidence that settles an unconfirmable delivery. This is the witness that is not a rendering; without it the app is back to believing screens.",
    capture: "shape",
    fallback: "our own record of what we typed",
  },
  {
    id: "slash.local",
    name: "Delivering a TUI-local command",
    means:
      "Commands that open a view instead of running a turn. Get the list wrong in either direction and the app either hammers Return into the view it just opened, or waits for a turn that never starts.",
    capture: "line",
  },
] as const;

export type CliSignalId =
  | "prompt.box"
  | "prompt.submit"
  | "askbox.enrich"
  | "limit.reset"
  | "context.meter"
  | "hook.pipe"
  | "deliver.echo"
  | "deliver.submit"
  | "transcript.jsonl"
  | "slash.local";

const BY_ID = new Map<string, CliSignalSpec>(CLI_SIGNALS.map((s) => [s.id, s]));

/** The catalog entry for an id. Synthesized for an id we do not know rather
 *  than thrown: a record written by a newer host must render as a row, not as
 *  an exception inside a readout whose whole job is to be reliable. */
export function signalSpec(id: string): CliSignalSpec {
  return BY_ID.get(id) ?? { id: id as CliSignalId, name: id, means: "", capture: "shape" };
}

/** Thresholds in force for one signal — the defaults, with the catalog's own
 *  overrides on top. One merge point, so a rule read from a comment above is
 *  the rule the verdict actually uses. */
export function thresholdsFor(id: string): HealthThresholds {
  return { ...DEFAULT_THRESHOLDS, ...(BY_ID.get(id)?.thresholds ?? {}) };
}
