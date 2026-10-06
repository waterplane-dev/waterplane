// Cut from clihealth.ts (move only): the rollup and the read off disk
// The one door stays `./clihealth.js`; this slice imports its siblings directly, never the barrel.

import { VIA_CAP } from "./healththresholds.js";
import { CLI_SIGNALS, thresholdsFor, type CliSignalId } from "./healthcatalog.js";
import { emptyHealth, redactSample, signalVerdict, healthSentence, type HealthObservation, type SignalRecord, type CliHealth, type HealthVerdict } from "./healthrecord.js";

// ── The rollup ──────────────────────────────────────────────────────────

export interface HealthRollup {
  /** The worst verdict on the board — what a badge shows. */
  verdict: HealthVerdict;
  broken: CliSignalId[];
  degraded: CliSignalId[];
  unknown: CliSignalId[];
  /** One sentence per unhealthy signal, worst first. */
  lines: string[];
  version: string | null;
}

/** Signals that are not healthy, worst first — the list a sheet renders and the
 *  list a notification is cut from. `unknown` is included: a probe nobody has
 *  been able to run is a thing to say, just not a thing to alarm on. */
export function unhealthySignals(health: CliHealth, now: number): SignalRecord[] {
  const rank: Record<HealthVerdict, number> = { broken: 0, degraded: 1, unknown: 2, healthy: 3 };
  return Object.values(health.signals)
    .filter((s) => signalVerdict(s, now).verdict !== "healthy")
    .sort((a, b) => rank[signalVerdict(a, now).verdict] - rank[signalVerdict(b, now).verdict]);
}

/**
 * The whole board as one answer.
 *
 * `unknown` never drags the rollup down past a healthy signal, and that is a
 * deliberate call: several of these are exercised rarely, so a badge that goes
 * grey whenever one of them has not fired today is a badge that is always grey,
 * i.e. one nobody reads (see the argument on `DEGRADED_MISSES`). The unknown
 * signals are still LISTED — they are just not an alarm.
 */
export function healthRollup(health: CliHealth, now: number): HealthRollup {
  const broken: CliSignalId[] = [];
  const degraded: CliSignalId[] = [];
  const unknown: CliSignalId[] = [];
  let anyHealthy = false;
  for (const s of Object.values(health.signals)) {
    const v = signalVerdict(s, now).verdict;
    if (v === "broken") broken.push(s.id);
    else if (v === "degraded") degraded.push(s.id);
    else if (v === "unknown") unknown.push(s.id);
    else anyHealthy = true;
  }
  const verdict: HealthVerdict = broken.length
    ? "broken"
    : degraded.length
      ? "degraded"
      : anyHealthy
        ? "healthy"
        : "unknown";
  return {
    verdict,
    broken,
    degraded,
    unknown,
    lines: unhealthySignals(health, now)
      .filter((s) => signalVerdict(s, now).verdict !== "unknown")
      .map((s) => healthSentence(s, now)),
    version: health.version,
  };
}

// ── Off disk ────────────────────────────────────────────────────────────

/**
 * Sanitize a record that came off disk or off the wire.
 *
 * Same posture as `cleanBudget` and `cleanIntentRow`: a stored file is not a
 * trusted value. Unknown signal ids are dropped (a signal deleted from the
 * catalog must not keep occupying a row), windows are re-capped, and every
 * number is coerced — a hand-edited `misses: 9999` would otherwise pin a
 * permanent `broken` with no way back through the UI.
 */
export function cleanHealth(raw: unknown): CliHealth {
  const r = (raw ?? {}) as Partial<CliHealth>;
  const out = emptyHealth();
  out.version = typeof r.version === "string" && r.version ? r.version.slice(0, 40) : null;
  out.versionSeenAt = num(r.versionSeenAt);
  if (num(r.versionChangedAt) != null) out.versionChangedAt = num(r.versionChangedAt);

  const sigs = (r.signals ?? {}) as Record<string, unknown>;
  for (const spec of CLI_SIGNALS) {
    const s = sigs[spec.id] as Partial<SignalRecord> | undefined;
    if (!s || typeof s !== "object") continue;
    const th = thresholdsFor(spec.id);
    const window = Array.isArray(s.window)
      ? s.window
          .filter((o): o is HealthObservation => !!o && typeof o === "object" && Number.isFinite((o as HealthObservation).at))
          .map((o) => ({ at: Number(o.at), ok: o.ok === true, ...(o.fallback ? { fallback: true as const } : {}) }))
          .slice(-th.rateWindow)
      : [];
    const rec: SignalRecord = {
      id: spec.id,
      version: typeof s.version === "string" && s.version ? s.version.slice(0, 40) : null,
      lastGoodAt: num(s.lastGoodAt),
      lastMissAt: num(s.lastMissAt),
      misses: Math.max(0, Math.min(9_999, Math.round(Number(s.misses) || 0))),
      missStreakSince: num(s.missStreakSince),
      window,
      totalGood: Math.max(0, Math.round(Number(s.totalGood) || 0)),
      totalMiss: Math.max(0, Math.round(Number(s.totalMiss) || 0)),
    };
    if (num(s.lastFallbackAt) != null) rec.lastFallbackAt = num(s.lastFallbackAt);
    if (typeof s.via === "string" && s.via) rec.via = s.via.slice(0, VIA_CAP);
    // Re-redacted on the way in: the file is hand-editable, and a sample that
    // was pasted in by hand has never been through `observe`.
    if (typeof s.sample === "string" && s.sample) rec.sample = redactSample(s.sample);
    if (num(s.sampleAt) != null) rec.sampleAt = num(s.sampleAt);
    if (typeof s.priorVersion === "string" && s.priorVersion) rec.priorVersion = s.priorVersion.slice(0, 40);
    if (s.priorVerdict && ["healthy", "degraded", "broken", "unknown"].includes(s.priorVerdict)) {
      rec.priorVerdict = s.priorVerdict;
    }
    out.signals[spec.id] = rec;
  }
  return out;
}

function num(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}
