/**
 * What the LOCAL runner has done, kept — `GET /api/localusage`.
 *
 * A THIRD kind of document beside the two token ledgers, never merged with
 * either: Claude's jsonl and opencode's store count what a CLIENT sent; this
 * counts what the RUNNER did (ollama's own `print_timing` lines and its `/api/ps`),
 * whichever client asked — claude-local, Codex and opencode all reach the same
 * runner. Reasoning and measurements:
 * docs/analysis/spikes/2026-10-02-local-usage-metrics.md.
 *
 * Three families, each kept apart for ever:
 *  - COMPUTE — the runner's own durations (prompt processing vs generation),
 *    loading apart, and "time to answer" (the HTTP request's wall time, which
 *    includes waiting in the runner's queue) apart again. Never summed together.
 *  - TOKENS — the runner's own counts: prompt tokens it PROCESSED vs prompt
 *    tokens it reused from its prompt cache, and tokens it generated.
 *  - MEMORY — the resident size `/api/ps` reported while the model was loaded,
 *    and the machine's memory while it was.
 *
 * Every field is optional and absent means NOT MEASURED — never zero.
 */

/** The runner's own durations and counts, for the requests that had them. */
export interface LocalCompute {
  /** Requests whose timing block was read. */
  requests: number;
  /** Prompt tokens the runner processed (not served from its cache), and how long that took. */
  promptTok: number;
  promptMs: number;
  /** Prompt tokens reused from the runner's prompt cache — no compute. Only
   *  counted where the block logged the prompt's full length. */
  cachedTok: number;
  /** Tokens generated, and how long generating them took. */
  genTok: number;
  genMs: number;
}

/** Wall-clock time to answer (the runner's HTTP access line), for a set of requests. */
export interface LocalWall { requests: number; ms: number }

/** Model loads the runner logged, and how long they took. */
export interface LocalLoads { loads: number; ms: number }

/** What `/api/ps` said a model held, over the samples it was resident in. */
export interface LocalMemory {
  samples: number;
  /** Σ resident bytes over the samples — mean = sumBytes / samples. */
  sumBytes: number;
  peakBytes: number;
  /** The same for the GPU's share (equal on Apple silicon: unified memory). */
  sumVram: number;
  peakVram: number;
  /** How long it was seen resident: sum of sample intervals, each capped. */
  residentMs: number;
  /** The context the runner allocated for it, when ps said. */
  contextLength?: number;
}

/** The machine's memory, sampled while a model was resident. */
export interface LocalMachine {
  samples: number;
  usedSum: number;
  usedPeak: number;
  /** The least memory a new program could have had. */
  availMin: number;
  totalBytes: number;
  /** Swap in use at its highest — absent where no reader. */
  swapPeak?: number;
  source: "vm_stat" | "meminfo";
}

/** One model on one day. `model: null` = the runner ran it but this host
 *  could not tell which model (see `LocalUsageAvailable.unattributedWhy`). */
export interface LocalModelDay {
  model: string | null;
  compute?: LocalCompute;
  /** Time to answer for the requests that ALSO have `compute` (paired). */
  timed?: LocalWall;
  /** Requests the access log closed with no runner timings — time to answer only. */
  untimed?: LocalWall;
  loads?: LocalLoads;
  /** Requests per HTTP path (`/v1/messages`, `/v1/responses`, …): which API asked. */
  byApi?: Record<string, number>;
  mem?: LocalMemory;
  machine?: LocalMachine;
}

export interface LocalUsageDay {
  /** Local calendar day, `YYYY-MM-DD`. */
  day: string;
  models: LocalModelDay[];
}

export type LocalUsageLog =
  | { readable: true; file: string; readAt: number | null }
  | { readable: false; file: string | null; reason: string };

export interface LocalUsageAvailable {
  available: true;
  runner: "ollama";
  url: string;
  /** When this host started keeping the ledger — nothing before it is in it. */
  since: number;
  /** The last `/api/ps` attempt, and whether it answered. null = not asked yet. */
  lastSampleAt: number | null;
  reachable: boolean | null;
  /** Models resident at the last answered sample. */
  loaded: string[];
  intervalMs: number;
  log: LocalUsageLog;
  days: LocalUsageDay[];
  /** Why a `model: null` row exists — one sentence, the same everywhere. */
  unattributedWhy: string;
}

export type LocalUsageDoc = LocalUsageAvailable | { available: false; reason: string };
