/**
 * What the LOCAL model runner is holding, on the wire.
 *
 * These two shapes were born in `packages/host/src/localrt.ts` and moved here
 * the moment the phone had to draw them: a fact the host measures and the phone
 * renders is a fact both ends must word identically, and two copies of
 * "`reachable: false` is not an empty model list" is one copy too many.
 *
 * The host keeps NO history of these — it emits samples and the phone keeps the
 * ring (`link.ts`'s pulse split, for its reason: a ring buffer on the host is a
 * second copy of a series the phone is already drawing).
 *
 * **Tokens per second is deliberately absent and must stay absent** until there
 * is a real measurement path. Neither ollama's `/api/ps` nor opencode publishes
 * live throughput, and the available estimate — PTY bytes over wall clock — is
 * wrong in both directions that matter: a TUI repaints (screen bytes are not
 * output tokens) and a model thinking emits nothing while doing the expensive
 * part. A throughput figure nobody can act on is worse than a blank space.
 */

import type { SysStat } from "./sysstat.js";

/** One resident model, as the runner describes it. */
export interface LoadedModel {
  /** The runner's own name for it — `gemma4:e4b`, not `ollama/gemma4:e4b`. */
  name: string;
  /** Bytes the model is holding in total. */
  size: number;
  /** Bytes of that which are on the GPU. On Apple silicon this equals `size`
   *  (unified memory) and is kept apart anyway, because on a discrete-GPU box
   *  the difference is the whole story. */
  vram: number;
  /** When the runner intends to evict it, ms epoch — or absent when it said
   *  nothing parseable. NOT defaulted to "now" or "never": both are claims. */
  expiresAt?: number;
  /** How many LIVE sessions on this host are currently running this model —
   *  the host's own `SessionInfo.model`, joined by `modelBaseName`. Absent
   *  when the host never wired the join (an old build, or a unit test with no
   *  `SessionManager`); a real `0` is a measured "nobody", never a guess. */
  sessionsUsing?: number;
}

/** One sample. The client keeps the history; this keeps none — see `link.ts`'s
 *  pulse for the same split, and for the reason: a ring buffer on the host is a
 *  second copy of a series the phone is already drawing. */
export interface LocalRuntimeSample {
  at: number;
  /** Resident models. EMPTY means the runner answered and is holding nothing —
   *  a different fact from `reachable: false`, and the two must not collapse. */
  models: LoadedModel[];
  /** Did the runner answer at all? False ⇒ every model field above is empty
   *  because nothing was asked, not because nothing is loaded. */
  reachable: boolean;
  cpuPct: number;
  memTotal: number;
  memFree: number;
  /** GPU compute utilization, 0-100, as the OS reports it. ABSENT — never 0 —
   *  on a host with no reader for it: today that is Apple Silicon only
   *  (`ioreg`'s own "Device Utilization %"), so a discrete-GPU box or a Linux
   *  desktop says nothing rather than a borrowed CPU number. */
  gpuPct?: number;
  /** Bytes the GPU driver reports in use, system-wide — not just the models
   *  below. Kept apart from a model's own `vram` on purpose: that is ollama's
   *  per-model figure, this is the OS's total, and folding them into one
   *  number would make a multi-model host's row disagree with what the
   *  machine actually holds. */
  gpuMemInUse?: number;
  /**
   * The rest of the machine — the CPU split, where the memory went, which
   * programs are holding it, and how hot the box is running (`wire/sysstat.ts`).
   *
   * **Absent on a host that predates it, and every section inside it is
   * optional again** for the same reason: a reader this platform has not got
   * produces no field, never a zero. It rides HERE rather than on its own
   * message because it answers the questions this sample provokes — "1.1 GB
   * free of 64 GB, held by WHAT?" — and a second stream to join against would
   * be a second lease, a second cadence and a readout that can disagree with
   * the one beside it.
   */
  sys?: SysStat;
}
