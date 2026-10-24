import { useState } from "react";
import { Copy, CornerUpLeft, ListTodo, MessageSquare, Pin, Slash } from "lucide-react";
import type { HistoryEntry } from "@waterplane/shared";
import { SheetHead } from "./Sheet";
import { ago } from "./format";
import { Empty } from "./Empty";
import { Button } from "./kit/Button";
import { RowSub } from "./kit/Row";
import { Hint } from "./kit/Hint";
import { Tag } from "./kit/Tag";

interface Props {
  title: string;
  entries: HistoryEntry[];
  /** Currently pinned entry id (shown in the overview's "last" slot), if any. */
  pinnedEntryId?: string;
  onClose: () => void;
  /** Drop a past prompt back into the compose box to send again. */
  onResend: (text: string) => void;
  /** Pin this entry as the overview label (or null to clear the pin). */
  onPin: (entryId: string | null) => void;
  /**
   * True while the socket is disconnected. Entries then come from the
   * offline cache (offlineCache.ts), which strips captured output to stay
   * within localStorage's shared quota — so an entry with no `output` here
   * doesn't mean "still capturing", it means "unavailable until reconnect".
   */
  offline?: boolean;
}

const KIND_META: Record<HistoryEntry["kind"], { label: string; Icon: typeof MessageSquare }> = {
  prompt: { label: "prompt", Icon: MessageSquare },
  command: { label: "command", Icon: Slash },
  backlog: { label: "backlog", Icon: ListTodo },
};

/**
 * Per-session History: every prompt / slash command / backlog item sent to the
 * session, each with the ANSI-stripped output captured for that turn. Oldest at
 * top so it reads like the conversation. Tap a prompt to re-send it.
 */
export function HistorySheet({ title, entries, pinnedEntryId, onClose, onResend, onPin, offline }: Props) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const toggle = (id: string) => setOpen((p) => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });

  return (
    <div className="sheet">
      <SheetHead title={<>History · {title}</>} onClose={onClose} />
      <Hint>
        Every command and backlog item sent to this session, with the output captured for that turn.
        Output is the terminal's text, stripped of formatting — not a perfect transcript.
        Pin an entry to show it as this session's overview label — handy when the last prompt is just a "yes".
        {offline && " You're offline — showing the last synced prompts; captured output isn't cached and comes back once the connection is."}
      </Hint>
      <div className="list hist">
        {entries.length === 0 && <Empty>Nothing sent yet.</Empty>}
        {entries.map((e) => {
          const meta = KIND_META[e.kind];
          const isOpen = open.has(e.id);
          const pinned = e.id === pinnedEntryId;
          return (
            <div key={e.id} className={`hist-item${pinned ? " pinned" : ""}`}>
              <div className="hist-head">
                <Tag className={`hist-${e.kind}`}><meta.Icon size={12} /> {meta.label}</Tag>
                {pinned && <Tag className="hist-pinned"><Pin size={12} /> overview</Tag>}
                <RowSub>{ago(e.sentAt)}</RowSub>
                <span className="hist-actions">
                  <Button className={pinned ? "active" : undefined} title={pinned ? "unpin from overview" : "pin as overview label"} onClick={() => onPin(pinned ? null : e.id)}><Pin size={14} fill={pinned ? "currentColor" : "none"} /></Button>
                  <Button title="copy prompt" onClick={() => void navigator.clipboard?.writeText(e.text)}><Copy size={14} /></Button>
                  <Button title="re-send" onClick={() => onResend(e.text)}><CornerUpLeft size={14} /></Button>
                </span>
              </div>
              <div className="hist-prompt">{e.text}</div>
              {e.output === undefined ? (
                <div className="hist-pending">{offline ? "output unavailable offline" : "capturing output…"}</div>
              ) : e.output === "" ? (
                <div className="hist-pending">(no text output)</div>
              ) : (
                <>
                  <pre className={`hist-out ${isOpen ? "open" : ""}`}>{e.output}</pre>
                  {e.output.length > 400 && (
                    <button className="hist-more" onClick={() => toggle(e.id)}>{isOpen ? "show less" : "show more"}</button>
                  )}
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
