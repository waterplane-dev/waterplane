/**
 * A session's dollar figure as BOTH the status bar and the panel headline print it: the
 * conversation's own cost plus its subagents', one rule in one place so the two never disagree.
 *
 * Mirrors the host's `costFields` (ctxlog/ctxproject.ts): a figure that leaves the agents out is
 * worse than no figure, so when the session HAS agents that spent tokens and their cost cannot be
 * said (null, and not because their model is unpriced — that is reported as unpriced tokens), the
 * whole reading is withheld. A total of zero is "nothing could be priced", never "$0".
 * Pure: imported by the extension and the webview alike.
 */
import { tokenTotal } from "@waterplane/shared";
import type { CostBreakdown } from "@waterplane/shared";
import type { SessionDoc } from "../protocol.js";

export function addCosts(a: CostBreakdown, b: CostBreakdown | null | undefined): CostBreakdown {
  if (!b) return a;
  return {
    input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite, total: a.total + b.total,
  };
}

/** `cost.total === 0` is "nothing could be priced", not "free". */
export const pricedOrNull = (c: CostBreakdown | null | undefined): CostBreakdown | null => (c && c.total > 0 ? c : null);

export interface SessionTotal {
  /** Own + agents, priced parts only. Null = no dollar figure (withheld or nothing priced). */
  cost: CostBreakdown | null;
  /** The agents' share of `cost`; null when they priced nothing. */
  agentUsd: number | null;
  /** Tokens on a model with no published rate, own + agents — in no dollar figure. */
  unpricedTok: number;
  /** True when the agents' cost could not be said, so the total is withheld rather than partial. */
  withheld: boolean;
  /**
   * Why it is withheld, as a sentence: `agentsUnread` when the subagent logs could not be read
   * (the host publishes no total then), else the agents spent tokens nothing could price.
   * Null when nothing is withheld.
   */
  withheldWhy: string | null;
}

export const AGENTS_UNPRICED =
  "This session's subagents could not be priced, so there is no dollar figure — a total without them would read too low.";

export function sessionTotal(d: SessionDoc): SessionTotal {
  const a = d.agents;
  const unpricedTok = d.unpricedTok + (a?.unpricedTok ?? 0);
  // Unread agents: their spend is unknown, so ANY total would leave it out. Withheld, said.
  if (d.agentsUnread) return { cost: null, agentUsd: null, unpricedTok, withheld: true, withheldWhy: d.agentsUnread };
  const agentsSpent = a != null && tokenTotal(a.split) > 0;
  if (agentsSpent && !a.cost && a.unpricedTok === 0) return { cost: null, agentUsd: null, unpricedTok, withheld: true, withheldWhy: AGENTS_UNPRICED };
  const own = pricedOrNull(d.cost);
  const agent = pricedOrNull(a?.cost);
  const cost = own && agent ? addCosts(own, agent) : own ?? agent;
  return { cost, agentUsd: cost && agent ? agent.total : null, unpricedTok, withheld: false, withheldWhy: null };
}
