import { Bot, ChevronsDown, Plug } from "lucide-react";
import { isMcpTask } from "@waterplane/shared";
import { LS } from "../storage";
import { useDragCap } from "../core/session/useDragCap";
import { since } from "./tvRows";
import type { TvModel } from "./useTranscriptView";

/** The rows, in a frame a person can shorten: six agents took a quarter of a
 *  phone's height from the reader (the owner's ask, 2026-11-05). A shortened
 *  list SCROLLS, so no agent is out of reach, and the strip above still says how
 *  many there are. One agent has nothing to shorten, so no grip, unless an old
 *  drag is cutting that one row and the grip is the way back. */
export function TvAgents({ agents, now }: { agents: TvModel["agents"]; now: number }) {
  const { frame, cap, capped, cut, grip } = useDragCap({
    key: LS.agentListH, showAllEvent: "action:agentList.showAll", capEvent: "action:agentList.cap",
  });
  const words = cut
    ? "agent list shortened — tap to show all of it, or drag down for more"
    : "drag up to shorten the agent list";
  return (
    <>
      <div ref={frame} className={`tr-agent-list${capped ? " capped" : ""}`}
        style={capped ? { maxHeight: `${cap}px` } : undefined}>
        {agents.map((a) => (
          <div className="tr-status tr-agent" key={a.id} title={a.type ? `${a.type}${a.model ? ` · ${a.model}` : ""}` : undefined}>
            {isMcpTask(a) ? <Plug size={13} /> : <Bot size={13} />}
            <span className="tr-live-what">{a.what}</span>
            {a.doing && <span className="tr-live-line">{a.doing}</span>}
            <span className="tr-live-ago">{since(a.startedAt, now)}</span>
          </div>
        ))}
      </div>
      {(agents.length > 1 || cut) && (
        <div className={`sess-chrome-grip${cut ? " capped" : ""}`}
          role="separator" aria-orientation="horizontal" tabIndex={0}
          aria-label={words} title={words} {...grip}>
          {cut && <ChevronsDown size={12} aria-hidden="true" />}
        </div>
      )}
    </>
  );
}
