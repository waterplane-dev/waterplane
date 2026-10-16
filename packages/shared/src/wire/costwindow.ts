/**
 * The cost WINDOW: what an arbitrary `[from, to)` span cost, by hour, by repo
 * and by conversation — `GET /api/costwindow`.
 *
 * Exists because the all-time ledger (`TokenStatsDoc`) cannot answer "where did
 * THIS week go": its repo rows and its costliest list are all-time, and nothing
 * in it groups the ~36 sessions one fan-out opened into the one thing a person
 * launched. The host folds its existing per-file store over the span and JOINS
 * the titles and launches it already holds; the phone groups and words it with
 * `shared/costwindow.ts`, so both ends bucket an hour the same way.
 *
 * Every dollar here is the same list-price COUNTERFACTUAL as the rest of the
 * token readout (`pricing.ts`), and every total ships beside its split.
 */

import type { CostBreakdown } from "../pricing.js";
import type { ModelSlice, TokenTotals } from "./telemetry.js";

/** How a conversation was opened, when the host could tell. Absent = NO LAUNCH RECORD — the
 *  daemon's own `claude -p` spenders, a session older than the closed stack keeps, or one this
 *  host never opened. Never read as "by hand": `hand` is a person's explicit open, recorded. */
export interface CostLaunch {
  kind: "fanout" | "backlog" | "schedule" | "agent" | "resurrect" | "hand" | "fork";
  /** The fan-out run (or scheduled-sweep occurrence) this session belonged to. */
  runId?: string;
  /** The intent/backlog row that opened it. */
  itemId?: string;
  /** The run's or item's display label at open time, clipped to 120. */
  label?: string;
  /** The model it was launched with / ran (alias or id). */
  model?: string;
}

/** One hour of one conversation inside the window. */
export interface CostConvoHour {
  /** `YYYY-MM-DDTHH`, host-local, like `TokenHour.hour`. */
  hour: string;
  usd: number;
  tok: number;
}

export interface CostConvo {
  /** The CLI's conversation id (log file name; a live session's `claudeSessionId`). */
  id: string;
  /** Absolute worktree with agent worktrees folded in (`repoOfWorktree`); "" when the log named no cwd. */
  repo: string;
  /** Repo base name; "unknown repo" for "". */
  label: string;
  /** First/last hour WITH A TURN inside the window, top-of-hour ms; null if none parsed. */
  firstAt: number | null;
  lastAt: number | null;
  /** Everything in the window, parent + agents. */
  totals: TokenTotals;
  cost: CostBreakdown;
  /** The agents' slice OF totals/cost — never a second total. */
  agentTotals: TokenTotals;
  agentCost: CostBreakdown;
  /** Subagent transcripts with at least one turn in the window. */
  agents: number;
  /** Parent + agents by model, descending by tokens. */
  byModel: ModelSlice[];
  /** The agents' slice by model — "Opus subagents: N% of this session's cost". */
  agentByModel: ModelSlice[];
  /** Per hour inside the window, ascending. The ONE source for "which hour was this in". */
  byHour: CostConvoHour[];
  /** A live session holds it right now. */
  live: boolean;
  /** Host-resolved title (live tab name/title, else the closed row's). Absent = nobody named it. */
  title?: string;
  launch?: CostLaunch;
  /** Largest context carried by one request in this conversation (input+cacheRead+cacheWrite),
   *  whole log, not just the window. Absent until the store carries it. */
  peakCtx?: number;
}

/** One repo's slice of one hour. `repo` is the worktree key ("" = unknown). */
export interface CostHourRepo {
  repo: string;
  label: string;
  totals: TokenTotals;
  cost: CostBreakdown;
}

export interface CostHour {
  /** `YYYY-MM-DDTHH`, host-local, like `TokenHour.hour`. */
  hour: string;
  /** Top of that hour, epoch ms. */
  t: number;
  totals: TokenTotals;
  cost: CostBreakdown;
  /** Descending by cost. */
  byRepo: CostHourRepo[];
  byModel: ModelSlice[];
  /** Conversations with a turn in this hour that are in `CostWindowDoc.rest`, not `convos` —
   *  so the hour's list can say "n of N". Absent = none (or an older host). */
  restConvos?: number;
}

/**
 * Conversations past `CostWindowDoc`'s cap, folded by repo × launch so every
 * aggregate stays whole: a fan-out of forty cheap sessions is still the run it
 * was, and a repo's total still has its small sessions in it. Carries no
 * conversation ids, so nothing on the phone can open a row that is not there.
 */
export interface CostConvoRest {
  /** Worktree key, as `CostConvo.repo` ("" = unknown). */
  repo: string;
  label: string;
  /** The launch the folded conversations share (grouped by `runId ?? itemId`); absent = no launch record. */
  launch?: CostLaunch;
  /** How many conversations were folded here. */
  count: number;
  agents: number;
  totals: TokenTotals;
  cost: CostBreakdown;
  agentTotals: TokenTotals;
  agentCost: CostBreakdown;
  byModel: ModelSlice[];
  firstAt: number | null;
  lastAt: number | null;
}

export interface CostWindowDoc {
  /** The span asked for. */
  from: number;
  to: number;
  /** Top of the hour `from` falls in — the cut's real left edge, because an hour is the finest
   *  bucket on record. A window's read already sends `from` on the hour (`windowStartHour`, the
   *  rule `windowCells` and the live cut share), so there the two are equal; `from - fromHour` is
   *  how much wider than asked a raw instant came out. */
  fromHour: number;
  /** Ascending, only hours with activity. */
  hours: CostHour[];
  /** The dearest `COST_CONVOS_CAP` conversations with ≥1 counted turn in the window, descending
   *  by cost (tokens tie-break). The rest are folded into `rest`; `hours`, the totals and every
   *  `byRepo` still count them. */
  convos: CostConvo[];
  /** Every conversation in the window, carried or folded. Absent = nothing was folded (an older
   *  host never folds), so `convosTotal ?? convos.length` is always the N of "n of N". */
  convosTotal?: number;
  /** What the cap folded away, by repo × launch. Absent = nothing was. */
  rest?: CostConvoRest[];
  totals: TokenTotals;
  cost: CostBreakdown;
  agentTotals: TokenTotals;
  agentCost: CostBreakdown;
  /** Tokens no list price covered — counted, never charged zero. */
  unpriced: TokenTotals;
  pricesAsOf: string;
  scannedAt: number;
}
