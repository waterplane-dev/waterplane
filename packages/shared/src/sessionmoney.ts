// THE session money rule, one copy for the host's spark and VS Code's headline.

/**
 * THE session money rule, for the host's spark and VS Code's headline alike: own + agents, priced
 * parts only. A session whose agents are ONLY unpriced still has a figure (the own cost) beside
 * its unpriced count; but agents that spent tokens whose cost cannot be said at all (`usd` null
 * with nothing counted as unpriced), or agents nobody read (`agents` null), withhold the whole
 * figure — a total that leaves them out reads too low. A total of zero is no figure, never `$0`.
 */
export function sessionMoney(a: {
  /** The conversation's own priced dollars (0 or null: nothing priced). */
  own: number | null | undefined;
  ownUnpriced: number;
  /** null = the subagent logs were not read. `usd` null/absent = the cost cannot be said. */
  agents: { usd: number | null | undefined; unpriced: number; spent: boolean } | null;
}): { usd: number | null; agentUsd: number | null; unpricedTok: number; withheld: boolean } {
  const pos = (n: number | null | undefined): number => (typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0);
  const ag = a.agents;
  const unpricedTok = a.ownUnpriced + (ag?.unpriced ?? 0);
  if (!ag || (ag.spent && ag.usd == null && !(ag.unpriced > 0))) return { usd: null, agentUsd: null, unpricedTok, withheld: true };
  const agentUsd = pos(ag.usd);
  const total = pos(a.own) + agentUsd;
  return { usd: total > 0 ? total : null, agentUsd: total > 0 && agentUsd > 0 ? agentUsd : null, unpricedTok, withheld: false };
}
