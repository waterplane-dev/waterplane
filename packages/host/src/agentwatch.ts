/**
 * The large-subagent push: one `agent` notification the first time a RUNNING
 * subagent's window passes the person's line (`agentWindowWarnSetting`).
 *
 * Subagent windows do not follow the session's `autoCompactWindow`, so one
 * agent can re-read 500-750k on every step for an hour with nothing said. The
 * spark already names the largest live agent (`liveAgentTok`/`liveAgentId`,
 * `ctxproject.ts`); this only watches it.
 *
 *  - **Once per (session, agent id).** Memory only: a restart may say it again
 *    for an agent that is still over the line, which is a reminder, not a lie.
 *  - **Words only.** Nothing is held, stopped or interrupted; the phone's context
 *    sheet is where a person acts (nothing applies itself).
 *  - **Pruned when the session ends**, so the map holds live sessions only.
 *  - Pure decision (`shouldPushAgent`) apart from the plumbing, like
 *    `healthwatch.ts`: `notify` and the setting are injected and read at call time.
 */
import type { SessionInfo } from "@waterplane/shared";
import { agentPushText, agentWindowWarnSetting } from "@waterplane/shared";
import type { Notify } from "./notifytypes.js";

/** Agent ids already pushed, per session id. */
export type AgentSeen = Map<string, Set<string>>;

/**
 * Whether this reading earns the push: an agent id is named, its window is at
 * or over the line, and it has not been pushed for this session before.
 */
export function shouldPushAgent(
  seen: AgentSeen, sid: string, agentId: string | null | undefined, tok: number | null | undefined, threshold: number,
): boolean {
  if (!agentId || tok == null || !(tok >= threshold)) return false;
  return !seen.get(sid)?.has(agentId);
}

export interface AgentWatchDeps {
  notify: Notify;
  /** The raw synced `agentWindowWarn` string, or undefined; asked on every reading. */
  setting(): string | undefined;
}

export interface AgentWatch {
  /** A session's info changed: push if its live agent crossed the line. */
  onUpdated(info: SessionInfo): void;
  /** A session ended: forget what was pushed for it. */
  forget(sid: string): void;
}

export function createAgentWatch(deps: AgentWatchDeps): AgentWatch {
  const seen: AgentSeen = new Map();
  return {
    onUpdated(info) {
      const sp = info.contextSpark;
      if (!sp) return;
      const threshold = agentWindowWarnSetting(deps.setting());
      if (!shouldPushAgent(seen, info.id, sp.liveAgentId, sp.liveAgentTok, threshold)) return;
      const agentId = sp.liveAgentId as string;
      let ids = seen.get(info.id);
      if (!ids) seen.set(info.id, (ids = new Set()));
      // Remembered BEFORE the push: lose one, never repeat one.
      ids.add(agentId);
      deps.notify("agent", {
        ...agentPushText({ tok: sp.liveAgentTok as number, type: sp.liveAgentType, title: info.title }),
        sessionId: info.id, tag: `agent-${info.id}`,
      });
    },
    forget(sid) { seen.delete(sid); },
  };
}
