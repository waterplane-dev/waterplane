/**
 * What a probe will cost, said BEFORE the tap, and the words every probe card shares. Pure.
 *
 * The estimate is the pilot's measured tokens per question, priced at list for each arm's model;
 * the cache-write share is rounded UP (the first question of an arm pays the cold write), so the
 * figure errs high. The hard token budget the runner enforces is a multiple of the same estimate.
 */
import { CACHE_WRITE_1H_MULT, CACHE_READ_MULT, rateFor } from "../pricing.js";
import { agentSourceText } from "../wire/agentreadings.js";
import type { ProbeResult, ProbeTokens } from "../wire/probe.js";

/**
 * Tokens one question cost, rounded up: pilot means sonnet 5.5 cache read 91k / write 11k, opus write
 * 28k; the first real run (2026-11-14, a fresh scratch checkout at a new commit, sonnet 5.5) wrote
 * 27k and read 68k a question, and its reported spend ran 24% over a 20k-write estimate. Cache
 * writes dominate the price (priced at the 1-hour tier here), so the write share is set well above.
 */
export const PROBE_PILOT_RUN_TOKENS: ProbeTokens = { in: 10, cw: 40_000, cr: 95_000, out: 700 };
/** The runner stops starting new questions once the run has used this many times the estimate. */
export const PROBE_BUDGET_FACTOR = 2;
/** One question is killed (its process group) past this many tokens; the pilot's largest was 399k. */
export const PROBE_RUN_TOKEN_CAP = 600_000;

const perRun = (t: ProbeTokens): number => t.in + t.cw + t.cr + t.out;

export interface ProbeEstimate {
  readonly runs: number;
  readonly tokens: number;
  /** Null when a model has no list price here: the consent is then on tokens alone. */
  readonly usd: number | null;
  readonly text: string;
}

/** The estimate for `questions` × `repeats` per model listed (one entry per arm). */
export function probeEstimate(models: readonly string[], questions: number, repeats: number, t: ProbeTokens = PROBE_PILOT_RUN_TOKENS): ProbeEstimate {
  const runsPerArm = Math.max(0, questions) * Math.max(0, repeats);
  const runs = runsPerArm * models.length;
  const tokens = runs * perRun(t);
  let usd: number | null = 0;
  for (const m of models) {
    const r = rateFor(m);
    if (!r || usd == null) { usd = null; continue; }
    const cr = r.cacheRead ?? r.input * CACHE_READ_MULT;
    usd += runsPerArm * (t.in * r.input + t.out * r.output + t.cr * cr + t.cw * r.input * CACHE_WRITE_1H_MULT) / 1e6;
  }
  const money = usd == null ? "no list price for one of the models" : `about $${usd.toFixed(2)} at list price`;
  const text = `${runs} questions asked (${questions} × ${repeats} × ${models.length} ${models.length === 1 ? "arm" : "arms"}), ${money}, about ${Math.round(tokens / 1e5) / 10}M tokens — the pilot's tokens per question, erring high. It stops at ${PROBE_BUDGET_FACTOR}× the tokens.`;
  return { runs, tokens, usd: usd == null ? null : Math.round(usd * 100) / 100, text };
}

/** Whether what the person accepted covers the estimate now (the price may have moved since the sheet opened). */
export function probeAcceptedCovers(accepted: { tokens: number; usd?: number | null }, now: ProbeEstimate): boolean {
  if (!(Number.isFinite(accepted.tokens) && accepted.tokens >= now.tokens)) return false;
  if (now.usd == null) return true;
  return typeof accepted.usd === "number" && Number.isFinite(accepted.usd) && accepted.usd + 0.005 >= now.usd;
}

/**
 * Where a probe result comes from (R-metrics-069): the agent readings' one sentence, plus what a
 * probe adds. Said once per card, never per tile.
 */
export function probeSourceText(): string {
  return `${agentSourceText()} A search test asks this desktop's setup lookup questions in a scratch checkout; its runs are kept out of the agent readings.`;
}

/** A result's provenance line, naming the desktop it ran on. */
export function probeFromText(r: Pick<ProbeResult, "desktop" | "backend" | "commit" | "startedAt">): string {
  const day = new Date(r.startedAt).toISOString().slice(0, 10);
  return `Run on ${r.desktop} (${r.backend}) on ${day} at ${r.commit.slice(0, 8)} — from that desktop's setup, not from git.`;
}

