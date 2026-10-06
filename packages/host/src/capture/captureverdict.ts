/**
 * The capture loop's pure cores: the verification ladder, the verdict line, the
 * emit gate and the diff record. Split out of `capture.ts` (move only).
 */
import type { CaptureOverlayKind, CaptureVerification, CaptureTheme, CaptureViewport } from "@waterplane/shared";

// ─────────────────────────────────────────────────────────────────────────────
// The pure cores. Everything below this comment is fixture-in, verdict-out and
// is pinned by `packages/host/test/capture.test.mjs` with no daemon, no
// browser and no simulator — which is the only way the ladder's ceilings can be
// asserted at all: a wrong level does not crash, it produces a plausible
// screenshot with a claim on it nobody checked.
// ─────────────────────────────────────────────────────────────────────────────

/** What `verificationLevel()` is allowed to look at. */
export interface VerificationInput {
  /** Frames sampled in the settle loop. One frame can never be `stable`. */
  sampled: number;
  /** Two consecutive frames were byte-identical. */
  settled: boolean;
  /** An ORACLE reading actually happened. False for every backend whose
   *  `oracle()` returned null, and for a run where the oracle was there but
   *  could not be read. */
  oracle: boolean;
  /** How many anchors the target named, and how many were not on screen. */
  wanted: number;
  missing: number;
}

/**
 * How much this frame can be trusted — the one derivation, for every backend.
 *
 * The ladder is MONOTONE: `anchor` sits on top of `stable`, which sits on top
 * of `unverified`, and each rung requires the one below it. That is why a
 * confirmed anchor on a single frame still answers `unverified` — an anchor
 * found in a screen that is still moving was found in a screen that is still
 * moving, and "verified" is the strongest word this app has. Under-claiming is
 * the bias everywhere in this repo; the frame is written either way and the
 * anchor record still says what was found.
 *
 * The ceiling that matters most: `oracle: false` can NEVER answer `anchor`.
 * `capture/window.ts` is permanently in that state.
 */
export function verificationLevel(v: VerificationInput): CaptureVerification {
  const settled = v.settled && v.sampled >= 2;
  if (settled && v.oracle && v.wanted > 0 && v.missing === 0) return "anchor";
  if (settled) return "stable";
  return "unverified";
}

/** Everything the verdict line is allowed to look at. A `CaptureSidecar` is
 *  structurally one of these, so the sidecar's own `verdict` and a run row's
 *  cannot be worded two ways. */
export interface VerdictInput {
  verification: CaptureVerification;
  /** The frame is one flat colour — nothing painted. Measured only where a
   *  pixel tool exists; absent means the check did not run, not "not blank". */
  blank?: boolean;
  errorOverlay?: { kind: CaptureOverlayKind; text?: string };
  score?: number;
  viewport?: CaptureViewport;
  theme?: CaptureTheme;
  /**
   * How many DISTINCT geometry+theme combinations the run's passes covered.
   *
   * Absent or 1 ⇒ `viewport`/`theme` describe every frame. More than that and
   * they describe the FIRST pass only, so the line SAYS there were others
   * rather than quoting one pass's shape as if it were the run's — a
   * `theme: "both"` run printing `390x844 light` is a sentence that is true of
   * half the frames and silent about the other half.
   */
  shapes?: number;
  console?: { errors: number; warnings: number; lines: string[] };
  network?: { failed: number; lines: string[] };
}

/**
 * The ~50-token line a person — or an agent that cannot see the picture — reads
 * instead of the frame.
 *
 * Grammar, pinned by the test:
 *   `{level} · score {n|n/a} · {w}x{h}[ {theme}][ +N more]|n/a · console: {clean|N err}|n/a · net: {clean|N failed}|n/a`
 *
 * The separator is U+00B7 with spaces. The phone treats the whole line as an
 * OPAQUE string and never splits it, which is why there is no shared separator
 * constant: nothing at the other end is entitled to parse this back apart.
 *
 * Every `n/a` is a measurement that did not happen. `console: clean` means the
 * console was READ and held no errors; `console: n/a` means there was no
 * console to read — a different fact, and the reason the sidecar's fields are
 * optional rather than zeroed.
 */
export function verdictLine(v: VerdictInput): string {
  const level = v.errorOverlay
    ? `error-overlay:${v.errorOverlay.kind}`
    : v.blank
      ? "blank"
      : v.verification === "anchor"
        ? "verified:anchor"
        : v.verification === "stable"
          ? "settled:stable"
          : "unverified";

  const score = typeof v.score === "number" ? `score ${v.score}` : "score n/a";

  // The `n/a` arm exists because a whole-desktop grab whose PNG header will not
  // parse has no honest geometry — and `0x0` would read as a real answer.
  const geom = v.viewport ? `${v.viewport.w}x${v.viewport.h}` : "n/a";
  const one = v.theme ? `${geom} ${v.theme}` : geom;
  // `+N more` rather than a second pair of numbers: the slot names the pass the
  // geometry belongs to and admits the rest exist. The per-frame truth is in
  // the sidecar's `files[]`, which is where a reader who needs all of them goes.
  const shape = v.shapes && v.shapes > 1 ? `${one} +${v.shapes - 1} more` : one;

  const con = v.console
    ? (v.console.errors === 0 ? "console: clean" : `console: ${v.console.errors} err`)
    : "console: n/a";
  const net = v.network
    ? (v.network.failed === 0 ? "net: clean" : `net: ${v.network.failed} failed`)
    : "net: n/a";

  return [level, score, shape, con, net].join(" · ");
}

/** What `shouldEmit()` weighs. */
export interface EmitInput {
  /** No previous frame to compare against. */
  first: boolean;
  /** Percent of pixels changed, or `null` when NOTHING on this machine could
   *  measure it. Never conflate the two: `0` is a measurement. */
  changedPct: number | null;
  /** The target's threshold, in percent. */
  diffPct: number;
  /** Frames already written this run. */
  emitted: number;
  maxFrames: number;
}

/**
 * The watch-mode diff gate: is this frame worth a file?
 *
 * Two degradations matter and they go opposite ways. Past the cap the answer is
 * always no, because an unbounded watch run fills an outbox somebody then has
 * to look at. With no pixel tool the answer is always YES — capped, and SAYING
 * so — because a gate that cannot measure and therefore emits nothing is a
 * feature that silently does not work, which is worse than a few redundant
 * frames a sentence in the output accounts for.
 *
 * The reason is returned rather than logged, so the output line, the sidecar's
 * `diff.reason` and the test all read the same string.
 */
export function shouldEmit(e: EmitInput): { emit: boolean; reason: string } {
  if (e.emitted >= e.maxFrames) return { emit: false, reason: `frame cap reached (${e.maxFrames})` };
  if (e.first) return { emit: true, reason: "first frame" };
  if (e.changedPct === null) {
    return { emit: true, reason: "no pixel tool here, so every frame is emitted (capped)" };
  }
  return e.changedPct >= e.diffPct
    ? { emit: true, reason: `changed ${e.changedPct}% (threshold ${e.diffPct}%)` }
    : { emit: false, reason: `changed ${e.changedPct}%, under the ${e.diffPct}% threshold` };
}

/**
 * One frame's difference from the one before it — the record, built once.
 *
 * The whole point of this function is that a MEASURED zero and an
 * UNMEASURABLE difference must stay telling apart. `changedPct: 0` means
 * ImageMagick compared two files and found no differing pixels. `reason` with
 * no `changedPct` means nothing on this machine could look. Writing `0` for
 * the second would say "the screen did not change" about a screen nobody
 * examined, which is the exact failure CLAUDE.md's "never to a wrong number"
 * names.
 */
export function diffRecord(
  againstRelPath: string,
  pct: number | null,
  reasonWhenUnmeasured: string,
): { againstRelPath: string; changedPct?: number; reason?: string } {
  return pct === null
    ? { againstRelPath, reason: reasonWhenUnmeasured }
    : { againstRelPath, changedPct: pct };
}
