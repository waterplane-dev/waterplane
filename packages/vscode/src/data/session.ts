/**
 * One conversation as the extension shows it: the context window over time,
 * what it spent and on what, what each prompt cost, and what its subagents
 * spent beside it.
 *
 * Every figure is the host's own: `updateContextLog` (the incremental cursor)
 * and `projectContextLog` (the wire projection) bundled verbatim, so this
 * screen and the phone's context sheet read one log into one set of numbers.
 * The turns ride a cursor of their own over the same records (`turns.ts`); the
 * subagents are the host's own `agentUsage` (`ctxlog/ctxagents.ts`, bundled with
 * only its meta-file reader shimmed), so their spend, their roster and their
 * running total are the phone's figures too.
 *
 * Degrades to absent, never to a wrong number: a missing log is a null doc with
 * a sentence, an unknown model is a null window, nothing priced is a null cost.
 */
import { basename, dirname, join } from "node:path";
import type { CostBreakdown } from "@waterplane/shared";
import { PRICES_AS_OF, resolveContextWindow } from "@waterplane/shared";
import { updateContextLog } from "../../../host/src/ctxlog/ctxupdate.js";
import { projectContextLog } from "../../../host/src/ctxlog/ctxproject.js";
import type { SeriesCursor } from "../../../host/src/ctxlog/ctxcursor.js";
import { agentCumOf, agentUsage, withAgentRuns } from "../../../host/src/ctxlog/ctxagents.js";
import type { AgentUsage } from "../../../host/src/ctxlog/ctxagents.js";
import type { SessionDoc } from "../protocol.js";
import { advanceTurns, projectTurns } from "./turns.js";
import type { TurnCursor } from "./turns.js";

/** Where a session read stopped. Opaque to callers: hand it back to `readSession` on the next poll. */
export interface SessionCursor {
  ctx: SeriesCursor;
  turns: TurnCursor;
  /** The host's per-agent-log cursors (`agentUsage`); null until the directory was read once. */
  agents: AgentUsage | null;
}

type AgentsDoc = NonNullable<SessionDoc["agents"]>;

/**
 * The subagents beside the conversation: `<uuid>/subagents/agent-*.jsonl`, read
 * by `agentUsage` — every log whole, incrementally, priced per record on its own
 * model and day. Asked on EVERY poll, not only when the parent log moved: an
 * agent writes while its parent sleeps.
 *
 * `agents` is null when there are no agent logs (a missing directory is a
 * measured zero and is shown as nothing). When the directory exists but could
 * not be read, `agents` is null AND `unread` carries the sentence: the host's
 * rule (`ctxproject.ts`) is no total rather than one the agents are missing
 * from, so `sessionTotal` withholds the figure. The cursor keeps its last tally
 * only so the next poll resumes rather than restarts — it is never published.
 */
export const AGENTS_UNREAD =
  "Subagent logs could not be read, so there is no total; the tokens shown are this conversation's own.";

function readAgents(path: string, prev: AgentUsage | null, models: string[]): { use: AgentUsage | null; models: string[]; agents: AgentsDoc | null; unread: string | null } {
  const dir = join(dirname(path), basename(path, ".jsonl"), "subagents");
  const use = agentUsage(dir, prev);
  if (!use) return { use: prev, models, agents: null, unread: AGENTS_UNREAD };
  if (use.logs === 0) return { use, models, agents: null, unread: null };
  const roster = withAgentRuns(models, use.runs);
  return {
    use,
    models: roster.models,
    agents: {
      logs: use.logs,
      tok: use.tok,
      split: { ...use.split },
      // Nothing priced ⇒ no cost, never a breakdown of zeros.
      cost: use.cost.total > 0 ? { ...use.cost } : null,
      unpricedTok: use.unpriced,
      runs: roster.agents,
      cum: agentCumOf(use),
    },
    unread: null,
  };
}

/**
 * Read (or advance) one conversation log into its `SessionDoc`.
 *
 * `prevCursor` is what the previous call returned for the same path, or null
 * for a fresh read; only what the CLI appended since is parsed. `folder` is the
 * workspace folder the doc is for, echoed on it. A log that is gone is
 * `{cursor: null, doc: null, why}`.
 */
export async function readSession(
  path: string, prevCursor: SessionCursor | null, folder: string,
): Promise<{ cursor: SessionCursor | null; doc: SessionDoc | null; why?: string }> {
  const ctx = updateContextLog(path, prevCursor?.ctx ?? null);
  const turns = ctx ? advanceTurns(path, prevCursor?.turns ?? null) : null;
  if (!ctx || !turns) {
    return { cursor: null, doc: null, why: `The conversation log ${basename(path)} is no longer there — Claude Code may have moved or removed it.` };
  }
  const log = projectContextLog(ctx);
  const sub = readAgents(path, prevCursor?.agents ?? null, log.models);
  // The strongest evidence of the window: the most context this conversation
  // was seen to carry, off the RAW readings (the projection is thinned).
  const observedTok = ctx.samples.reduce((m, s) => (s.tok > m ? s.tok : m), 0);
  const win = resolveContextWindow({ model: log.model, observedTok: observedTok || null });
  const cost: CostBreakdown | null = log.cost;
  // The latest reading off the RAW series: `log.samples` is downsampled to min/max per bucket, so
  // its last point can be a bucket's maximum from earlier on — a stale, high figure.
  const lastRaw = ctx.samples.length ? ctx.samples[ctx.samples.length - 1] : null;
  const doc: SessionDoc = {
    folder,
    id: basename(path, ".jsonl"),
    path,
    updatedAt: log.mtime,
    samples: log.samples,
    lastTok: lastRaw?.tok ?? null,
    lastAt: lastRaw?.t ?? null,
    events: log.events,
    models: sub.models,
    windowTok: win.tok,
    windowFrom: win.from,
    model: log.model,
    autoCompactTok: log.autoCompactTok,
    truncated: log.truncated,
    turns: log.turns,
    usageTok: log.usageTok,
    split: { ...log.split },
    cost: cost ? { ...cost } : null,
    unpricedTok: log.unpricedTok,
    compaction: log.compaction,
    coldStarts: log.coldStarts,
    agents: sub.agents,
    agentsUnread: sub.unread,
    turnCosts: projectTurns(turns),
    pricesAsOf: PRICES_AS_OF,
  };
  return { cursor: { ctx, turns, agents: sub.use }, doc };
}
