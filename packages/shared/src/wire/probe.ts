/**
 * The lookup probe on the wire (R-metrics-071): a repo's question pool, one stored probe result
 * and its analysis. The pure rules over them are `probe.ts` (a barrel over `probe/`); the runner
 * is the host's `probe.ts`, through the sidecar seam (`sidecar/sidecarprobe.ts`).
 *
 * Every record carries `backend`, `model`, `cli` and `schema`, because a call count is what a
 * backend says a call is: results from two backends are never compared.
 */

/** Bumped when a stored result's meaning changes; a reader drops a schema it does not know. */
export const PROBE_SCHEMA = 1;

/** One question of a repo's pool. `all`: every pattern must match the final answer line (case-insensitive). */
export interface ProbeQuestion {
  readonly id: string;
  readonly q: string;
  readonly all: readonly string[];
  /** Free label (skill / memory / module / twohop / docs …); never scored. */
  readonly kind?: string;
  /** The answer in words, for a person reading the pool. Never shown to the probed session. */
  readonly key?: string;
}

/** A repo's committed pool (`.waterplane-shared/probe.json`). */
export interface ProbePool {
  /** Who keeps the answers true, in the repo's own words (required: a stale key reads as a worse setup). */
  readonly owner: string;
  readonly questions: readonly ProbeQuestion[];
}

/** One arm: the setup on this desktop, run on one model. */
export interface ProbeArm {
  readonly arm: string;
  readonly model: string;
}

/**
 * What kind of comparison a result is.
 * - `models`: two models on the same setup, arms interleaved (the first use).
 * - `baseline`: one arm, kept as the "before" of a later `against`.
 * - `against`: the same draw and model now, compared with a stored baseline.
 */
export type ProbeKind = "models" | "baseline" | "against";

export interface ProbeTokens {
  readonly in: number;
  readonly cw: number;
  readonly cr: number;
  readonly out: number;
}

/** One question asked once in one arm. */
export interface ProbeRunRecord {
  readonly arm: string;
  readonly rep: number;
  readonly id: string;
  readonly correct: boolean;
  /** The turn cap was hit: scored wrong, and said. */
  readonly capHit: boolean;
  /** The final `ANSWER:` line (clipped). */
  readonly final: string;
  readonly toolCalls: number;
  readonly requests: number;
  /** Absent when the run reported no usage — never a zero. */
  readonly tokens?: ProbeTokens;
  /** Tokens the first request carried (input + cache read + cache write): this run's start context. */
  readonly startTok?: number;
  readonly turns?: number;
  readonly ms: number;
  /** The model the CLI said it ran. */
  readonly model?: string;
  readonly cli?: string;
  /** A tool input outside the worktree (memory excepted) or naming the key: the whole result is void. */
  readonly leak?: string;
  /** The run did not produce an answer (timeout, crash, a token cap kill). Left out of every figure. */
  readonly error?: string;
}

/** What setup a result was measured under — the "before" a later run is told it differs from. */
export interface ProbeFingerprint {
  readonly backend: string;
  readonly model?: string;
  readonly cli?: string;
  /** Median start-context tokens over the arm's runs. */
  readonly startTok?: number;
  readonly commit: string;
}

/** One stored probe run on this desktop. */
export interface ProbeResult {
  readonly schema: number;
  readonly id: string;
  readonly kind: ProbeKind;
  readonly backend: string;
  /** This desktop's name: a result is always from the desktop that ran it (R-metrics-069). */
  readonly desktop: string;
  readonly startedAt: number;
  readonly finishedAt?: number;
  readonly commit: string;
  readonly seed: number;
  readonly repeats: number;
  readonly maxTurns: number;
  /** The question ids drawn, in draw order. */
  readonly questions: readonly string[];
  readonly arms: readonly ProbeArm[];
  readonly fingerprints: Readonly<Record<string, ProbeFingerprint>>;
  readonly runs: readonly ProbeRunRecord[];
  /** The `against` result's baseline id. */
  readonly against?: string;
  /** Why the run ended early (halted, a usage limit, the token budget), in words. */
  readonly stopped?: string;
  /** Why no figure of this result may be read (a leak), in words. */
  readonly void?: string;
  /** The estimate the person accepted before the tap. */
  readonly estimate: { readonly tokens: number; readonly usd: number | null };
  /** The CLI's own reported spend, for the budget only — never a metric (the prompt cache decides it). */
  readonly reportedUsd?: number;
}

/** One figure of a paired comparison, B against A, as a ratio. */
export interface ProbePairedFigure {
  readonly ratio: number;
  /** 95% interval of the observed paired differences; absent under three questions. */
  readonly lo?: number;
  readonly hi?: number;
  /** Half-width of the repeat-noise band, as a fraction (0.14 = ±14%). */
  readonly band: number;
  /** The band came from the pilot's prior, not this result's own repeats. */
  readonly bandFromPrior: boolean;
  readonly outside: boolean;
}

export interface ProbeArmSummary {
  readonly arm: string;
  readonly model: string;
  readonly runs: number;
  readonly correct: number;
  readonly capHits: number;
  readonly errors: number;
  readonly medianTokens?: number;
  readonly medianRequests?: number;
  readonly medianCalls?: number;
}

export interface ProbeAnalysis {
  readonly arms: readonly ProbeArmSummary[];
  /** Correctness is a gate, not the headline: tokens and requests are compared only when it passes. */
  readonly gate: { readonly pass: boolean; readonly text: string };
  /** B against A over the questions both answered right every time; absent with `pairedAbsent`. */
  readonly paired?: {
    readonly a: string;
    readonly b: string;
    readonly n: number;
    readonly tokens: ProbePairedFigure;
    readonly requests: ProbePairedFigure;
    readonly calls: ProbePairedFigure;
  };
  readonly pairedAbsent?: string;
  readonly void?: string;
  /** The sentences a card shows, in order. */
  readonly lines: readonly string[];
}

/** The live state of a repo's probe on this desktop. */
export interface ProbeStatus {
  readonly state: "idle" | "running";
  readonly id?: string;
  readonly done?: number;
  readonly of?: number;
  readonly note?: string;
}

/** `GET /api/repos/:id/probe`. */
export interface ProbeView {
  readonly ok: true;
  readonly status: ProbeStatus;
  /** The pool at HEAD, or the sentence why there is none. */
  readonly pool: { readonly count: number; readonly owner: string } | { readonly absent: string };
  readonly defaults: { readonly draw: number; readonly repeats: number; readonly maxTurns: number };
  /** Where this comes from, said once (R-metrics-069). */
  readonly source: string;
  /** One-shot token the start needs, bound to this worktree (`host/confirmgate.ts`); absent while a run is live and from an older desktop. */
  readonly confirm?: string;
}

/** `GET /api/repos/:id/probe/results`: newest first, each with its analysis. */
export interface ProbeResultsView {
  readonly ok: true;
  readonly results: readonly { readonly result: ProbeResult; readonly analysis: ProbeAnalysis }[];
  readonly source: string;
}

/** `POST /api/repos/:id/probe/start` body. `accepted` is the estimate the person saw before the tap. */
export interface ProbeStartBody {
  readonly kind: ProbeKind;
  readonly models?: readonly string[];
  readonly baselineId?: string;
  readonly repeats?: number;
  readonly seed?: number;
  readonly accepted: { readonly tokens: number; readonly usd?: number | null };
  /** The token `GET probe` handed the phone; a start without it is refused (a script cannot accept a price on its own). */
  readonly confirm?: string;
}

export type ProbeStartAnswer = { readonly ok: true; readonly id: string } | { readonly ok: false; readonly refused: string };
