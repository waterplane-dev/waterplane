/**
 * The dearest subagents as list rows (`AgentTopList.tsx`). Its own slice, imported directly: it is
 * not re-exported by the `contextPlot.ts` facade, whose surface is pinned (`plotpins.test.mjs`).
 */

import type { AgentRun } from "@waterplane/shared";
import { modelLabel } from "./cplotModels.ts";

/** One row of the most-expensive-agents list. Every figure ABSENT when unmeasured, never 0. */
export interface AgentTopRow {
  run: AgentRun;
  id: string;
  /** `type`, or "agent" when its meta file named none. */
  type: string;
  /** The model's alias; null when no record named one. */
  model: string | null;
  /** Requests it made; null = not measured (older host), drawn as nothing. */
  turns: number | null;
  peakTok: number | null;
  tok: number;
  costUsd: number | null;
  running: boolean;
}

/**
 * The `n` dearest agents, as rows. Dollars lead where there are dollars
 * (descending); an agent whose model has no published rate follows the priced
 * ones, by tokens — the two units are never compared with each other. Ties keep
 * the roster's order. Pure and total: the caller says "n of N".
 */
export function agentTop(agents: AgentRun[], models: string[] | undefined, n = 5): AgentTopRow[] {
  return agents
    .map((run, i) => ({ run, i }))
    .sort((a, b) => {
      const ca = a.run.costUsd ?? null, cb = b.run.costUsd ?? null;
      if (ca != null && cb != null) return cb - ca || b.run.tok - a.run.tok || a.i - b.i;
      if (ca != null) return -1;
      if (cb != null) return 1;
      return b.run.tok - a.run.tok || a.i - b.i;
    })
    .slice(0, Math.max(0, n))
    .map(({ run }) => {
      const who = models && run.model != null ? models[run.model] : null;
      return {
        run,
        id: run.id,
        type: run.type ?? "agent",
        model: who ? modelLabel(who) : null,
        turns: run.turns && run.turns > 0 ? run.turns : null,
        peakTok: run.peakTok && run.peakTok > 0 ? run.peakTok : null,
        tok: run.tok,
        costUsd: run.costUsd ?? null,
        running: !!run.running,
      };
    });
}
