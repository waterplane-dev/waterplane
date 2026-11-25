import { Bot, ChevronsDown, Plug } from "lucide-react";
import { isMcpTask } from "@waterplane/shared";
import { Hint } from "../kit/Hint";
import { LS } from "../storage";
import { useDragCap } from "../core/session/useDragCap";
import { since } from "./tvRows";
import type { TvModel } from "./useTranscriptView";

/**
 * The rows under the reader's status strip, running agents then the outline's
 * count line, in a frame a person can shorten (the owner's asks, 2026-11-05 and
 * 2026-11-25). A shortened frame SCROLLS, so no agent is out of reach, and the
 * strip above still says how many there are. The last row goes first. One row has
 * nothing to shorten: no grip, and an old drag never cuts it to a sliver.
 *
 * One row per agent, because the COUNT is not the progress: "2 agents running"
 * answers how many and nothing about what, and the terminal's own agent panel is
 * two taps and a keystroke away on a phone. Rendered whenever agents are running,
 * including through a busy turn (a foreground Task call is the same fact), but
 * never as a claim of freshness: with the link down the strip above says "last
 * known", and these rows are part of that same snapshot.
 */
export function TvTop({ m }: { m: TvModel }) {
  const { agents, outline } = m;
  if (!agents.length && !outline) return null;
  return <TopFrame m={m} />;
}

function TopFrame({ m }: { m: TvModel }) {
  const { agents, now, outline, outlineTurns, q } = m;
  const rows = agents.length + (outline ? 1 : 0);
  const { frame, cap, capped, cut, grip } = useDragCap({
    key: LS.agentListH, off: rows < 2, showAllEvent: "action:agentList.showAll", capEvent: "action:agentList.cap",
  });
  const what = outline ? "agent list and turn count" : "agent list";
  const words = cut
    ? `${what} shortened — tap to show all of it, or drag down for more`
    : `drag up to shorten the ${what}`;
  return (
    <>
      <div ref={frame} className={`tr-top${capped ? " capped" : ""}`}
        style={capped ? { maxHeight: `${cap}px` } : undefined}>
        {agents.map((a) => (
          <div className="tr-status tr-agent" key={a.id} title={a.type ? `${a.type}${a.model ? ` · ${a.model}` : ""}` : undefined}>
            {isMcpTask(a) ? <Plug size={13} /> : <Bot size={13} />}
            <span className="tr-live-what">{a.what}</span>
            {a.doing && <span className="tr-live-line">{a.doing}</span>}
            <span className="tr-live-ago">{since(a.startedAt, now)}</span>
          </div>
        ))}
        {outline && (
          <Hint>
            {outlineTurns.length} turn{outlineTurns.length === 1 ? "" : "s"}
            {q ? ` matching “${q}”` : ""} · tap to jump
          </Hint>
        )}
      </div>
      {rows > 1 && (
        <div className={`sess-chrome-grip${cut ? " capped" : ""}`}
          role="separator" aria-orientation="horizontal" tabIndex={0}
          aria-label={words} title={words} {...grip}>
          {cut && <ChevronsDown size={12} aria-hidden="true" />}
        </div>
      )}
    </>
  );
}
