import { useEffect, useRef } from "react";
import type { SessionInfo } from "@waterplane/shared";
import { agentLevel, agentWarnText, countAgents, levelRose, noteAgentCount, type AgentLevel } from "../../agentCount";
import { sessionStatus } from "../../sessionFacts";
import { tabLabel } from "../../sessionTabs";
import type { BackendList } from "../../backendCaps";
import { showToast } from "../../toast";
import { usePref } from "../prefs";

interface UseAgentCountBridgeCtx {
  sessions: SessionInfo[];
  backends: BackendList;
  sessionRepoName: (s: SessionInfo) => string;
}

/**
 * The parallel-agent count's seam to App (`agentCount.ts`): the sum and the
 * rows behind it, published for the desktop strip and its sheet, and one toast
 * when it rises past a mark.
 */
export function useAgentCountBridge(ctx: UseAgentCountBridgeCtx) {
  const { sessions, backends, sessionRepoName } = ctx;
  const cfg = usePref("agentWarn");
  const level = useRef<AgentLevel>("ok");
  useEffect(() => {
    // "Working" is the row badge's own call (`sessionStatus`), narrowed to a
    // main loop mid-turn: a session `coding` only because of agents under it
    // is counted through those agents, never twice.
    const rows = sessions.map((s) => {
      const repo = sessionRepoName(s);
      return {
        id: s.id, label: tabLabel(s, repo), repo,
        working: !s.idle && sessionStatus(s, backends) === "coding",
        agents: s.running ? (s.agents ?? []).map((a) => ({ what: a.what, model: a.model, startedAt: a.startedAt })) : [],
      };
    });
    const c = countAgents(rows.map((r) => ({ working: r.working, agents: r.agents.length })));
    const next = agentLevel(c.total, cfg);
    noteAgentCount(c, rows, next);
    if (levelRose(level.current, next)) showToast(agentWarnText(c, next, cfg));
    level.current = next;
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `sessionRepoName` is a per-render closure over the repos; sessions/backends/cfg drive it
  }, [sessions, backends, cfg]);
}
