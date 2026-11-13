/**
 * What runs UNDER a session, worded ONCE for the host's push and every phone
 * pill. `SessionInfo.agents` carries two kinds of row: the Task tool's
 * background agents and MCP calls the CLI moved to the background (host
 * `agents.ts`'s `readMcpTasks`, `type: MCP_TASK_TYPE`). They are different
 * things — an MCP task is one tool call, not a model working — so they are
 * counted and named apart: "2 agents + 1 MCP task", never "3 agents".
 */
import type { SessionAgent } from "./wire/session.js";

/** The `type` the host stamps on a backgrounded MCP call's row. */
export const MCP_TASK_TYPE = "MCP task";

export function isMcpTask(a: Pick<SessionAgent, "type">): boolean {
  return a.type === MCP_TASK_TYPE;
}

export interface RunningCounts { agents: number; mcp: number }

export function runningCounts(rows: readonly Pick<SessionAgent, "type">[] | undefined): RunningCounts {
  let mcp = 0;
  for (const r of rows ?? []) if (isMcpTask(r)) mcp++;
  return { agents: (rows?.length ?? 0) - mcp, mcp };
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** "2 agents + 1 MCP task" (+ " + shells" when asked); "" when nothing runs. */
export function runningWords(rows: readonly Pick<SessionAgent, "type">[] | undefined, shells?: boolean): string {
  const c = runningCounts(rows);
  return [c.agents ? plural(c.agents, "agent") : "", c.mcp ? plural(c.mcp, "MCP task") : "", shells ? "shells" : ""]
    .filter(Boolean).join(" + ");
}
