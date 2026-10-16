// Cut from clihealth.ts (move only): the record, capturing a sample, observing, re-arming and the verdict sentence
// The one door stays `./clihealth.js`; this slice imports its siblings directly, never the barrel.

import { SAMPLE_CAP, VIA_CAP, type HealthThresholds } from "./healththresholds.js";
import { signalSpec, thresholdsFor, type CliSignalId } from "./healthcatalog.js";

// ── The record ──────────────────────────────────────────────────────────

/** One observation, as kept in the rolling window. Small on purpose: this is
 *  persisted, twenty deep, ten signals wide. */
export interface HealthObservation {
  at: number;
  /** True for a confirmed good. A fallback is `false` — see `observe`. */
  ok: boolean;
  /** This miss was a fallback being taken rather than a parse coming back empty. */
  fallback?: true;
}

export interface SignalRecord {
  id: CliSignalId;
  /** The CLI version this history is about. History from another version is
   *  cleared rather than carried — see `rearmForVersion`. */
  version: string | null;
  lastGoodAt: number | null;
  lastMissAt: number | null;
  /** Consecutive misses, reset by any good. */
  misses: number;
  /** When the current miss streak began — "since when", in the sentence. */
  missStreakSince: number | null;
  lastFallbackAt?: number | null;
  /** Which fallback was last taken, as named by the call site. */
  via?: string | null;
  /** The last input that failed, captured per the signal's `SampleMode`. */
  sample?: string | null;
  sampleAt?: number | null;
  /** Newest last. Capped at the signal's `rateWindow`. */
  window: HealthObservation[];
  totalGood: number;
  totalMiss: number;
  /** What the record said just before a version change wiped it. Kept because
   *  "this went red at the upgrade" is the sentence that names the cause. */
  priorVersion?: string | null;
  priorVerdict?: HealthVerdict;
}

export interface CliHealth {
  /** The `claude --version` this host last saw. */
  version: string | null;
  versionSeenAt: number | null;
  /** When the version last CHANGED — the re-arm instant, worth announcing. */
  versionChangedAt?: number | null;
  signals: Record<string, SignalRecord>;
}

export function emptyHealth(): CliHealth {
  return { version: null, versionSeenAt: null, signals: {} };
}

export function blankSignal(id: CliSignalId, version: string | null): SignalRecord {
  return {
    id,
    version,
    lastGoodAt: null,
    lastMissAt: null,
    misses: 0,
    missStreakSince: null,
    window: [],
    totalGood: 0,
    totalMiss: 0,
  };
}

// ── Capturing a sample, without capturing a secret ──────────────────────

/**
 * A sample as a SHAPE — the structure of the input, and none of its characters.
 *
 * Used wherever the failing input is prose somebody wrote. It is less than a
 * line of text and more than nothing, and it is exactly what most of these
 * parses were reasoning about in the first place: a probe cut from the head of
 * a prompt fails differently for one line and for forty, and a log record that
 * parses to zero turns is a different bug at 200 bytes than at 2 MB.
 */
export function shapeOf(text: string): string {
  if (!text) return "empty";
  const lines = text.split("\n");
  let longest = 0;
  for (const l of lines) if (l.length > longest) longest = l.length;
  return `${lines.length} line${lines.length === 1 ? "" : "s"}, ${text.length} chars, longest line ${longest}`;
}

/** Home directories, so a sample never carries the account name. */
const HOME_RE = /\/(?:Users|home)\/[^/\s]+/g;
const EMAIL_RE = /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g;
const URL_CREDS_RE = /(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi;
/**
 * `token: …`, `api-key=…`, `Authorization: Bearer …` — the value, whatever it
 * is, is not something a health readout needs.
 *
 * The optional scheme word is not decoration: `Authorization: Bearer <token>`
 * puts a word between the colon and the secret, so consuming a single `\S+`
 * eats "Bearer" and leaves the credential standing in the sample.
 */
const SECRET_ASSIGN_RE =
  /\b(tokens?|secrets?|passwds?|passwords?|api[-_ ]?keys?|apikeys?|authorization|auth|bearer|cookies?|credentials?)\b\s*[:=]\s*(?:(?:bearer|basic|token|jwt)\s+)?\S+/gi;
/**
 * A long unbroken opaque run.
 *
 * The catch-all, and the only rule here that works on a credential format
 * nobody has thought of yet: no legible line contains twenty-four characters of
 * base64-ish text with no separator, and every key ever issued does. `/` is
 * deliberately out of the class so a long path is not mistaken for one.
 */
const OPAQUE_RE = /[A-Za-z0-9_+=-]{24,}/g;

/**
 * Redact and cap a `line` sample.
 *
 * Applied by `observe()` rather than offered as a helper, for the reason stated
 * on `SampleMode`: the call site that leaks is always the one written later.
 */
export function redactSample(raw: string, cap = SAMPLE_CAP): string {
  let s = raw.replace(/\s+/g, " ").trim();
  s = s.replace(URL_CREDS_RE, "$1<redacted>@");
  s = s.replace(SECRET_ASSIGN_RE, (_m, k: string) => `${k}=<redacted>`);
  s = s.replace(EMAIL_RE, "<email>");
  s = s.replace(HOME_RE, "~");
  s = s.replace(OPAQUE_RE, (m) => `<redacted:${m.length}>`);
  return s.length > cap ? s.slice(0, cap - 1) + "…" : s;
}

/** Store a failing input the way this signal is allowed to store it. */
export function captureSample(id: string, raw: string): string {
  return signalSpec(id).capture === "line" ? redactSample(raw) : shapeOf(raw);
}

// ── Recording an observation ────────────────────────────────────────────

/**
 * What one observation says.
 *
 *   good     — the primary path answered, and the answer was usable.
 *   miss     — the primary path came back with nothing. The app degraded to
 *              null, correctly, and something the user wanted is not there.
 *   fallback — the app took the substitute instead. Counted as a miss, and the
 *              argument is worth stating because the alternative is tempting:
 *              a fallback is not a soft failure of the primary, it IS the
 *              primary not answering. The app keeps flying either way; the only
 *              difference is that this one has a name to put in the sentence.
 *
 * And a fourth case, which has no enum member because the right way to say it
 * is to say nothing: **the primary rule correctly declined to fire.** There was
 * no question box, only prose containing a footer's words; there was no turn, so
 * no `Stop` was owed; the log carries no pending question, so nothing was there
 * to match. None of those is a miss — the rule was not the right rule for that
 * input, so its silence proves nothing about it — and none of them is a `good`
 * either, because nothing was seen to WORK. Both mistakes were made on the live
 * host and both are the same mistake: a `miss` per correct refusal reported a
 * working detector as 44% broken, and a `good` per refusal would have filled a
 * twenty-slot window with successes and made the real misses arithmetically
 * invisible. A call site with no evidence records no observation, and the signal
 * ages back to `unknown` — which this file keeps distinct from `healthy`
 * precisely so that "I could not check" has somewhere to go.
 */
export type HealthOutcome = "good" | "miss" | "fallback";

export interface ObserveOpts {
  /** Time is always a parameter here — no rule in this file reads a clock. */
  at: number;
  /** The input that failed. Captured per the signal's `SampleMode`; ignored on
   *  a `good`, which needs no evidence. */
  raw?: string;
  /** Which fallback was taken. A literal from the call site, never data. */
  via?: string;
}

/**
 * Record one observation against a signal.
 *
 * Mutates the record in place and returns it. Deliberately not a copy: this is
 * called from the delivery path and from a prompt check that runs about twice a
 * second, and a readout whose bookkeeping is the expensive part is the failure
 * mode `nettraffic.ts` names — the measurement must never be the cost of the
 * thing measured. The store that owns the object is the one that persists it.
 */
export function observe(health: CliHealth, id: CliSignalId, outcome: HealthOutcome, opts: ObserveOpts): SignalRecord {
  let sig = health.signals[id];
  if (!sig) sig = health.signals[id] = blankSignal(id, health.version);
  // Belt and braces: a record stamped with another version has already been
  // invalidated by the fact of the change, whether or not anybody called
  // `noteCliVersion` first.
  if (sig.version !== health.version) sig = health.signals[id] = rearmForVersion(sig, health.version, opts.at);

  const th = thresholdsFor(id);
  const good = outcome === "good";
  sig.window.push({ at: opts.at, ok: good, ...(outcome === "fallback" ? { fallback: true as const } : {}) });
  while (sig.window.length > th.rateWindow) sig.window.shift();

  if (good) {
    sig.lastGoodAt = opts.at;
    sig.misses = 0;
    sig.missStreakSince = null;
    sig.totalGood++;
    return sig;
  }

  sig.lastMissAt = opts.at;
  if (sig.misses === 0) sig.missStreakSince = opts.at;
  sig.misses++;
  sig.totalMiss++;
  if (outcome === "fallback") {
    sig.lastFallbackAt = opts.at;
    if (opts.via) sig.via = opts.via.slice(0, VIA_CAP);
  }
  if (opts.raw != null) {
    sig.sample = captureSample(id, opts.raw);
    sig.sampleAt = opts.at;
  }
  return sig;
}

// ── Re-arming on a version change ───────────────────────────────────────

/**
 * A new `claude` makes every heuristic's history a statement about a program
 * that is no longer running, so the history is CLEARED and the signal returns
 * to `unknown`.
 *
 * Both directions of keeping it are wrong, which is what settles the question:
 *
 *   • Keep the GOODS and a signal that broke on the upgrade reads `healthy` off
 *     yesterday's successes — masking the single most likely cause of a break
 *     with the history that predates it.
 *   • Keep the MISSES and a signal the upgrade just fixed stays red until
 *     somebody notices, which is the permanent-mark problem `SIGNAL_FORGET_MS`
 *     exists to avoid.
 *
 * `unknown` is the only honest state for a heuristic against a binary it has
 * never been tried on, and it is a state this file is careful to keep distinct
 * from `healthy` precisely so it can be used here.
 *
 * What survives is one breadcrumb: the version we came from and the verdict it
 * ended on, because "this went red at the upgrade to 2.1.4" is the sentence
 * that names a cause, and it cannot be reconstructed from an empty record.
 */
export function rearmForVersion(sig: SignalRecord, version: string | null, now: number): SignalRecord {
  const prior = signalVerdict(sig, now).verdict;
  return {
    ...blankSignal(sig.id, version),
    priorVersion: sig.version,
    priorVerdict: prior,
  };
}

/**
 * Tell the record which `claude` is installed.
 *
 * Returns whether it CHANGED, because a version change is worth announcing on
 * its own — it is the most likely explanation for whatever the readout says
 * next, and saying so once beforehand is cheaper than working it out afterwards
 * from ten signals that all went `unknown` at the same minute.
 */
export function noteCliVersion(
  health: CliHealth,
  version: string | null,
  now: number,
): { changed: boolean; from: string | null } {
  const from = health.version;
  health.versionSeenAt = now;
  if (from === version) return { changed: false, from };
  health.version = version;
  health.versionChangedAt = now;
  for (const id of Object.keys(health.signals)) {
    health.signals[id] = rearmForVersion(health.signals[id], version, now);
  }
  // A first sighting on a fresh record is not a change anybody needs told
  // about: there is no history to have invalidated.
  return { changed: from !== null, from };
}

// ── The verdict ─────────────────────────────────────────────────────────

/**
 * `unknown` is a fourth state, not a shade of `healthy`.
 *
 * A signal with no observations has not proved anything, and a signal that has
 * gone quiet has stopped proving it. Both are "I cannot say", which leads
 * somewhere different from "it works" — the same distinction `attach.ts` keeps
 * between a host that was never asked and a host that answered "not here".
 */
export type HealthVerdict = "healthy" | "degraded" | "broken" | "unknown";

export interface HealthCheck {
  verdict: HealthVerdict;
  /** Which rule decided it — the UI's sentence, and the test's assertion. */
  because: "no-observations" | "gone-quiet" | "misses" | "rate" | "confirmed";
  /** Consecutive misses right now. */
  misses: number;
  /** Observations inside the rate window, after the age filter. */
  samples: number;
  /** How many of those were not good. */
  failed: number;
  /** Miss fraction, or null below `rateMinSamples` — never 0 as a stand-in. */
  rate: number | null;
  /** When the state being reported began: the streak's start, the window's
   *  oldest kept observation, or the last thing seen at all. */
  since: number | null;
}

/**
 * The one rule. Pure: a record, the clock, and the signal's own thresholds.
 *
 * Order is the argument. Nothing observed outranks everything (an empty record
 * cannot be graded); silence outranks a stale verdict (a red mark from
 * yesterday is not a fact about today); a streak outranks a rate (five in a row
 * is sharper evidence than a fraction, and it is what a genuinely broken regex
 * looks like); and `healthy` is only ever reached by having actually seen the
 * thing work.
 */
export function signalVerdict(sig: SignalRecord, now: number, override?: Partial<HealthThresholds>): HealthCheck {
  const th = { ...thresholdsFor(sig.id), ...(override ?? {}) };
  const newest = Math.max(sig.lastGoodAt ?? 0, sig.lastMissAt ?? 0) || null;

  const inWindow = sig.window.filter((o) => now - o.at <= th.rateMaxAgeMs);
  const samples = inWindow.length;
  const failed = inWindow.reduce((n, o) => n + (o.ok ? 0 : 1), 0);
  const rate = samples >= th.rateMinSamples ? failed / samples : null;
  const oldestInWindow = samples ? inWindow[0].at : null;

  const base = { misses: sig.misses, samples, failed, rate };

  if (newest == null) {
    return { ...base, verdict: "unknown", because: "no-observations", since: null };
  }
  if (now - newest > th.forgetMs) {
    return { ...base, verdict: "unknown", because: "gone-quiet", since: newest };
  }
  if (sig.misses >= th.brokenMisses) {
    return { ...base, verdict: "broken", because: "misses", since: sig.missStreakSince };
  }
  if (rate != null && rate >= th.rateBroken) {
    return { ...base, verdict: "broken", because: "rate", since: oldestInWindow };
  }
  if (sig.misses >= th.degradedMisses) {
    return { ...base, verdict: "degraded", because: "misses", since: sig.missStreakSince };
  }
  if (rate != null && rate >= th.rateDegraded) {
    return { ...base, verdict: "degraded", because: "rate", since: oldestInWindow };
  }
  if (sig.lastGoodAt != null) {
    return { ...base, verdict: "healthy", because: "confirmed", since: sig.lastGoodAt };
  }
  // Seen only failing, but not often enough to call it. Not healthy — nothing
  // here has ever worked — and not degraded either, on one bad moment.
  return { ...base, verdict: "unknown", because: "no-observations", since: newest };
}

// ── One sentence, generated once ────────────────────────────────────────

/**
 * A duration, compactly.
 *
 * Compact units ("12m", "3h", "2d") rather than prose, for two reasons: they
 * pluralize nothing, so the sentence has one form and a test can pin it; and
 * they match every other readout in this app, which says "250 ms" and "54
 * lost" rather than spelling numbers out.
 */
export function agoText(ms: number): string {
  if (!Number.isFinite(ms) || ms < 60_000) return "<1m";
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/**
 * One sentence about one signal: which signal, since when, how many misses, and
 * what it last saw.
 *
 * Generated here so the host's notification body, the phone's badge and a log
 * line cannot word the same fact three ways — the same argument
 * `budgetReasonText` and `blockedReasonText` are made from. It answers for every
 * verdict, including the healthy one, so no caller ever has a reason to write
 * its own.
 */
export function healthSentence(sig: SignalRecord, now: number): string {
  const spec = signalSpec(sig.id);
  const c = signalVerdict(sig, now);
  const sample = sig.sample
    ? spec.capture === "line"
      ? ` Last input: “${sig.sample}”.`
      : ` Last input: ${sig.sample}.`
    : "";
  const lastGood =
    sig.lastGoodAt != null ? `last confirmed ${agoText(now - sig.lastGoodAt)} ago` : "never confirmed at all";

  switch (c.because) {
    case "confirmed":
      return `${spec.name} is working — ${lastGood}.`;
    case "no-observations":
      return sig.priorVersion
        ? `${spec.name} has not been checked since claude ${sig.version ?? "?"} — its history was cleared when the CLI changed from ${sig.priorVersion}.`
        : `${spec.name} has not been checked yet.`;
    case "gone-quiet":
      return `${spec.name} has gone quiet — nothing observed for ${agoText(now - (c.since ?? now))}, so its state is unknown.`;
    case "misses":
      return `${spec.name} is ${c.verdict} — ${c.misses} misses in a row over the last ${agoText(now - (c.since ?? now))}, ${lastGood}.${sample}`;
    case "rate":
      return `${spec.name} is ${c.verdict} — ${c.failed} of the last ${c.samples} failed (${Math.round((c.rate ?? 0) * 100)}%) over the last ${agoText(now - (c.since ?? now))}, ${lastGood}.${sample}`;
  }
}

/**
 * Has the primary rule been CONFIRMED since the instant this breadcrumb was
 * stamped?
 *
 * The record keeps `via`, `sample` and their stamps for ever, and it should:
 * "this is the line that stopped matching" is the actionable half of the whole
 * feature, and deleting it on the next success throws away the only evidence
 * anybody could act on. But keeping it and RENDERING it in the present tense
 * are different things, and the board was doing the second: a signal reading
 * `healthy`, last confirmed 32 minutes ago, still wore *Falling back to the
 * weaker flag* over a captured screen from four days earlier. Read literally
 * that says the app is standing on its fallback right now — the exact wrong
 * answer for the one screen whose entire job is to stop a fallback becoming
 * permanent without anybody being told.
 *
 * The predicate is a fact, not a threshold, which is why there is no age
 * constant here: a `good` observation IS the primary rule running and working,
 * so one stamped after the fallback settles the question outright. Everything
 * else in this file that fades with time (`rateMaxAgeMs`, `forgetMs`) is
 * guessing from silence; this is not guessing.
 *
 * `>=` rather than `>` because both stamps come from one `opts.at` per
 * observation and a tie means the good is at worst the same moment — and a
 * caller that batches a good and a fallback into one instant has already said
 * the primary rule answered.
 */
export function supersededByGood(sig: SignalRecord, at: number | null | undefined): boolean {
  return at != null && sig.lastGoodAt != null && sig.lastGoodAt >= at;
}
