import { useMemo, useState } from "react";
import { AlertTriangle, Bot, ChevronRight, Check, CircleSlash, Hourglass, Layers, MessageSquare, PencilLine, Puzzle, RefreshCw, Send, SquareTerminal, TextCursorInput, Trash2, User } from "lucide-react";
import type { SentCommand, SentSource } from "@waterplane/shared";
import { SheetHead } from "./Sheet";
import { ConfirmButton } from "./Confirm";
import { Empty } from "./Empty";
import { Explain } from "./Explain";
import { FilterBar } from "./kit/FilterBar";
import { FilterChip } from "./kit/FilterChip";
import { ago } from "./format";
import { Button } from "./kit/Button";
import { Hint } from "./kit/Hint";
import { Tag } from "./kit/Tag";

interface Props {
  entries: SentCommand[];
  /** When set, only this session's entries are shown (the per-session entry point). */
  filterSessionId?: string | null;
  sessionTitle?: string;
  onClose: () => void;
  onRefresh: () => void;
  onClear: () => void;
  /** Open the session an entry was sent to — the "go look at it yourself" link. */
  onOpenSession: (sessionId: string) => void;
}

/** Per-source label + icon. The wording says WHO decided, not just what fired. */
const SOURCE: Record<SentSource, { label: string; Icon: typeof Bot }> = {
  compose: { label: "you typed it", Icon: PencilLine },
  backlog: { label: "backlog item", Icon: Layers },
  fanout: { label: "fan-out", Icon: Send },
  "fanout-followup": { label: "fan-out follow-up", Icon: Send },
  create: { label: "new session's first prompt", Icon: SquareTerminal },
  plugin: { label: "plugin auto-answer", Icon: Puzzle },
  phone: { label: "your typed answer to the CLI's question", Icon: TextCursorInput },
  // Rows written before the oracle became a plugin keep their own word.
  oracle: { label: "oracle auto-answer (legacy)", Icon: Bot },
  limit: { label: "usage-limit auto-continue", Icon: Hourglass },
};

/**
 * Per-result badge. The four delivery verdicts are kept apart on purpose:
 * `unsubmitted` (text is sitting in the composer, un-run) and `ok` are opposite
 * facts about the session, and the whole point of the log is to state which.
 */
const RESULT: Record<SentCommand["result"], { label: string; Icon: typeof Bot; cls: string }> = {
  ok: { label: "delivered · turn started", Icon: Check, cls: "sug" },
  written: { label: "written (not confirmed)", Icon: Send, cls: "fire" },
  retry: { label: "nothing typed", Icon: CircleSlash, cls: "muted" },
  unconfirmed: { label: "typed, never seen on screen", Icon: AlertTriangle, cls: "defer" },
  unsubmitted: { label: "in the composer, not submitted", Icon: AlertTriangle, cls: "defer" },
  failed: { label: "failed", Icon: AlertTriangle, cls: "err" },
};

/**
 * …and what the host later PROVED, for the two verdicts it could not answer at
 * the time.
 *
 * Shown BESIDE `result`, never instead of it. `result` is what a four-second
 * echo window could see; this is what the CLI's own conversation log said
 * minutes later. Collapsing the pair would hide the gap between them, and that
 * gap is the signal — two thirds of the gravestones in the measurement that
 * started this rework were prompts that had run.
 */
const SETTLED: Record<NonNullable<SentCommand["settled"]>, { label: string; cls: string }> = {
  landed: { label: "settled: it ran", cls: "sug" },
  composer: { label: "settled: sitting in the composer", cls: "defer" },
  absent: { label: "settled: it never ran", cls: "err" },
  unknown: { label: "settled: still unreadable", cls: "muted" },
};

type Who = "all" | "auto" | "user";
const WHO_LABEL: Record<Who, string> = { all: "all", auto: "automatic", user: "yours" };
/** ONE bucketing function feeds both the number on a chip and the cut it opens (a count on a
 *  control is a filter), so the two can never disagree about an edge. */
const inCut = (e: SentCommand, v: Who) => (v === "all" ? true : e.actor === v);

function clock(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/**
 * **What was sent into my sessions, and when.**
 *
 * The terminal cannot answer this: automation types through the same PTY a
 * person does, so a backlog item, a fan-out prompt, a plugin auto-answer and a
 * usage-limit `continue` all land in the scrollback looking exactly like
 * something the user wrote — and the moment you are asking the question, the
 * scrollback is the evidence under suspicion. Each row names the source, who
 * decided (auto vs you), the exact text, the delivery verdict, and links
 * straight into the session so the claim can be checked against the real thing
 * rather than believed.
 */
export function SentLogSheet({ entries, filterSessionId, sessionTitle, onClose, onRefresh, onClear, onOpenSession }: Props) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [pick, setWho] = useState<Who>("all");
  const toggle = (id: string) => setOpen((p) => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const inSession = useMemo(
    () => entries.filter((e) => (filterSessionId ? e.sessionId === filterSessionId : true)),
    [entries, filterSessionId],
  );
  const count = (v: Who) => inSession.filter((e) => inCut(e, v)).length;
  const autoCount = count("auto");
  // Chips exist only where there is something to tell apart: a log of only yours, or only the
  // app's, has no second answer to a chip's question. A cut picked earlier and no longer offered
  // (the log changed under it) is not applied, rather than left hiding rows with no way out.
  const mixed = autoCount > 0 && autoCount < inSession.length;
  const who: Who = mixed ? pick : "all";
  const shown = useMemo(
    () => inSession.filter((e) => inCut(e, who)).slice().sort((a, b) => b.ts - a.ts),
    [inSession, who],
  );

  return (
    <div className="sheet">
      <SheetHead title={<><MessageSquare size={16} style={{ verticalAlign: "-3px", marginRight: 4 }} />Sent commands{sessionTitle ? ` · ${sessionTitle}` : ""}</>} onClose={onClose}>
        {/* The title has to be allowed to shrink: `.brand` is flex:0 0 auto, so
            a long session name pushed refresh and clear straight off the right
            edge of the phone. */}
        <span className="head-acts tight">
          <Button onClick={onRefresh} title="refresh"><RefreshCw size={16} /></Button>
          {/* Absent, not dimmed, on an empty log: there is nothing for it to clear, and the
              header carries no count either (a "0" over "Nothing sent yet." says it twice). */}
          {entries.length > 0 && (
            <ConfirmButton className="key" title="clear the log"
              confirmTitle="tap again to clear the sent-command log"
              confirm={<><Trash2 size={16} /> sure?</>}
              onConfirm={onClear}><Trash2 size={16} /></ConfirmButton>
          )}
        </span>
      </SheetHead>

      {/* One line says what this is; the rest of what it means is behind the `?`. The words are
          the sheet's own, unchanged but for the last clause: it said a tap on the row opens the
          session, when the row's text expands and "open the session" is the button that opens it. */}
      <Hint>
        Every command this app typed into a session.
        <Explain of="the sent log">
          Including the ones it decided on by itself (backlog, fan-out, plugin auto-answers,
          usage-limit auto-continue). One row per command, stamped with how the delivery ended; tap a
          row&apos;s text to read all of it, or &ldquo;open the session&rdquo; to check it against the terminal.
        </Explain>
      </Hint>

      {/* One chip is always lit (a choice, not a cut), so none carries an x. */}
      {mixed && (
        <div className="fchips wrap olog-kinds">
          {(["all", "auto", "user"] as const).map((v) => (
            <FilterChip key={v} on={who === v} clears={false} onClick={() => setWho(v)}>
              {WHO_LABEL[v]} · {count(v)}
            </FilterChip>
          ))}
        </div>
      )}
      {who !== "all" && (
        <FilterBar onClear={() => setWho("all")} clearLabel="show all">
          Showing {WHO_LABEL[who]} only: {shown.length} of {inSession.length}
        </FilterBar>
      )}

      <div className="list hist">
        <Empty empty={shown.length === 0}>Nothing sent yet.</Empty>
        {shown.map((e) => {
          const src = SOURCE[e.source] ?? { label: e.source, Icon: Send };
          const res = RESULT[e.result] ?? RESULT.written;
          const set = e.settled ? SETTLED[e.settled] : null;
          const expanded = open.has(e.id);
          const oneLine = e.text.replace(/\s+/g, " ").trim();
          return (
            <div key={e.id} className="olog-row">
              <div className="olog-head">
                <Tag className={`oracle-${res.cls}`}><res.Icon size={12} /> {res.label}</Tag>
                {set && (
                  <Tag
                    className={`oracle-${set.cls}`}
                    title={e.settledDetail ?? (e.settledAt ? `settled ${ago(e.settledAt)}` : undefined)}
                  >
                    <Check size={12} /> {set.label}
                  </Tag>
                )}
                <Tag title={e.actor === "auto" ? "the app decided on this one" : "you sent this"}>
                  {e.actor === "auto" ? <Bot size={12} /> : <User size={12} />} {src.label}
                </Tag>
                <span className="olog-when" title={new Date(e.ts).toLocaleString()}>{clock(e.ts)} · {ago(e.ts)}</span>
              </div>

              <button className="olog-body" onClick={() => toggle(e.id)} title={expanded ? "collapse" : "show the full text"}>
                <code className={expanded ? "sent-text open" : "sent-text"}>{expanded ? e.text : oneLine}</code>
                {e.truncated && expanded && <Hint as="span"> …(truncated for the log)</Hint>}
              </button>

              {e.detail && <div className="olog-why">{e.detail}</div>}
              {e.settledDetail && <div className="olog-why">{e.settledDetail}</div>}

              <div className="olog-foot">
                {!filterSessionId && <span className="olog-sess">{e.sessionTitle}</span>}
                <button className="link-btn" onClick={() => onOpenSession(e.sessionId)}>
                  open the session <ChevronRight size={12} style={{ verticalAlign: "-2px" }} />
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
