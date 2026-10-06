/**
 * The `decisions` overlay: the DECISION LOG — every automatic thing done or
 * proposed on a session's behalf. A usage-limit auto-continue (`source:
 * "limit"`, traced blocked → attempts → resumed / gave up) or a plugin's
 * suggestion or answer (`source: "plugin"`, with its full input and output as
 * the plugin recorded them). It was the oracle's log; the rows are core's now
 * and the sheet is generic over who wrote them.
 *
 * A source chip is a FILTER, and the cut says what it hides: "n of N" with a
 * clear button, never a shorter list that does not say why.
 */
import { useState, type ReactNode } from "react";
import {
  AlertTriangle, Archive, Bot, Check, CircleSlash, Hand, Hourglass, Puzzle, RefreshCw, ScrollText, Send, ShieldAlert, ThumbsUp, Trash2, X,
} from "lucide-react";
import type { DecisionLogEntry, PluginView } from "@waterplane/shared";
import { useCore, useStore } from "../../sdk";
import { SheetHead } from "../../Sheet";
import { ConfirmButton } from "../../Confirm";
import { Empty } from "../../Empty";
import { ago } from "../../format";
import { cleanTerm, cutDecisions, decisionSource, decisionSources, sourceLabel } from "./logic";
import { decisions, decisionScope, plugins } from "./store";

type Meta = { label: string; Icon: typeof Bot; cls: string };

/** Outcome words the log knows how to colour. A plugin's outcome is its own
 *  word; one not listed here is shown as itself, uncoloured — never dropped. */
const OUTCOME: Record<string, Meta> = {
  suggested: { label: "suggested", Icon: ThumbsUp, cls: "sug" },
  answered: { label: "answered", Icon: Send, cls: "fire" },
  autofired: { label: "answered", Icon: Send, cls: "fire" },
  abstained: { label: "no suggestion", Icon: CircleSlash, cls: "muted" },
  blocked: { label: "left for you · high-stakes", Icon: ShieldAlert, cls: "defer" },
  capped: { label: "capped", Icon: Hand, cls: "muted" },
  error: { label: "error", Icon: AlertTriangle, cls: "err" },
};

const LIMIT_PHASE: Record<NonNullable<DecisionLogEntry["phase"]>, Meta> = {
  blocked: { label: "usage limit", Icon: Hourglass, cls: "defer" },
  attempt: { label: "auto-continue", Icon: Send, cls: "fire" },
  resumed: { label: "resumed", Icon: Check, cls: "sug" },
  gaveup: { label: "gave up", Icon: AlertTriangle, cls: "err" },
};

export function DecisionLogSheet() {
  const c = useCore();
  const entries = useStore(decisions);
  const sid = useStore(decisionScope);
  const list = useStore(plugins);
  const [source, setSource] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const session = sid ? c.world.sessions.find((x) => x.id === sid) : undefined;
  const { inScope, shown, archived } = cutDecisions(entries, { sessionId: sid, source, showArchived });
  const sources = decisionSources(inScope);
  const toggle = (id: string) => setOpen((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const live = c.conn;
  const archive = (id: string, a: boolean) => live.liveSend({ t: "decisions.archive", id, archived: a }, a ? "archived" : "unarchived");
  const del = (id: string) => live.liveSend({ t: "decisions.delete", id }, "deleted");
  const acts = (e: DecisionLogEntry) => (
    <span className="hist-acts">
      <button className="row-act" title={e.archived ? "un-archive" : "archive (hide)"} onClick={() => archive(e.id, !e.archived)}><Archive size={12} /></button>
      <ConfirmButton className="row-act" title="delete permanently"
        confirmTitle="tap again to delete this log entry for good"
        confirm={<><Trash2 size={12} /> sure?</>}
        onConfirm={() => del(e.id)}><Trash2 size={12} /></ConfirmButton>
    </span>
  );

  return (
    <div className="sheet">
      <SheetHead title={<><ScrollText size={16} style={{ verticalAlign: "-3px", marginRight: 4 }} />Decision log{session ? ` · ${session.title}` : ""}</>}
        onClose={() => { decisionScope.set(null); c.nav.close("decisions"); }}>
        <ConfirmButton className="key" title="archive every entry in the log — every session and source, not just this cut"
          confirmTitle="tap again to archive every unarchived entry, in every session"
          confirm={<><Archive size={14} /> all?</>}
          onConfirm={() => live.liveSend({ t: "decisions.archiveAll" }, "all archived")}><Archive size={14} /></ConfirmButton>
        <button className="key" title="refresh" onClick={() => live.liveAsk(sid ? { t: "decisions.get", sessionId: sid } : { t: "decisions.get" })}><RefreshCw size={14} /></button>
      </SheetHead>

      {sources.length > 1 && (
        <div className="annot-tools tri olog-kinds">
          <button className={`key ${source === null ? "active" : ""}`} onClick={() => setSource(null)}>all · {inScope.length}</button>
          {sources.map((s) => (
            <button key={s.key} className={`key ${source === s.key ? "active" : ""}`} onClick={() => setSource(s.key)}>
              {s.key === "limit" ? <Hourglass size={12} /> : <Puzzle size={12} />} {sourceLabel(s.key, list)} · {s.n}
            </button>
          ))}
        </div>
      )}

      <div className="form-hint">
        Each row is something done or proposed for a session without a tap: a usage-limit auto-continue, or
        a plugin&apos;s suggestion or answer with what it was shown and why it chose.
        {source && (
          <div>
            Showing {sourceLabel(source, list)} only: {shown.length} of {inScope.length}{" "}
            <button className="link-btn" onClick={() => setSource(null)}><X size={11} /> clear</button>
          </div>
        )}
        {archived > 0 && (
          <> · <button className="link-btn" onClick={() => setShowArchived((v) => !v)}>{showArchived ? "hide" : "show"} {archived} archived</button></>
        )}
      </div>

      <div className="list hist">
        <Empty empty={shown.length === 0}>{inScope.length ? "Nothing in this cut." : "No decisions yet."}</Empty>
        {shown.map((e) => e.source === "limit"
          ? <LimitRow key={e.id} e={e} showSession={!sid} acts={acts(e)} />
          : <PluginRow key={e.id} e={e} showSession={!sid} acts={acts(e)} list={list}
              open={open.has(e.id)} onToggle={() => toggle(e.id)} />)}
      </div>
    </div>
  );
}

function LimitRow({ e, showSession, acts }: { e: DecisionLogEntry; showSession: boolean; acts: ReactNode }) {
  const meta = LIMIT_PHASE[e.phase ?? "blocked"] ?? LIMIT_PHASE.blocked;
  return (
    <div className={`olog-card outcome-${meta.cls} ${e.archived ? "archived" : ""}`}>
      <div className="olog-head">
        <span className={`tag oracle-${meta.cls}`}><meta.Icon size={12} /> {meta.label}</span>
        {showSession && <span className="olog-sess">{e.sessionTitle}</span>}
        <span className="row-sub olog-time">{ago(e.ts)}</span>
        {acts}
      </div>
      <div className="olog-q open">{e.question}</div>
      {e.rationale && <div className="olog-rationale">{e.rationale}</div>}
    </div>
  );
}

function PluginRow({ e, showSession, acts, list, open, onToggle }: {
  e: DecisionLogEntry; showSession: boolean; acts: ReactNode; list: PluginView[] | null; open: boolean; onToggle(): void;
}) {
  const meta = OUTCOME[e.outcome] ?? { label: e.outcome, Icon: Puzzle, cls: "muted" };
  const who = sourceLabel(decisionSource(e), list);
  const question = cleanTerm(e.question);
  const isReply = e.options.length === 0;
  const sure = e.confidence ? <span className="olog-conf"> · {Math.round(e.confidence * 100)}% sure</span> : null;
  const tok = (e.inTok ?? 0) + (e.outTok ?? 0);
  const facts = [e.model, e.images != null ? `${e.images} image${e.images === 1 ? "" : "s"}` : "", tok ? `${tok} tok` : ""].filter(Boolean);
  return (
    <div className={`olog-card outcome-${meta.cls} ${e.archived ? "archived" : ""}`}>
      <div className="olog-head">
        <span className={`tag oracle-${meta.cls}`}><meta.Icon size={12} /> {meta.label}</span>
        <span className="tag"><Puzzle size={12} /> {who}</span>
        {e.choice != null && <span className="tag oracle-choice">chose {e.choice}</span>}
        {showSession && <span className="olog-sess">{e.sessionTitle}</span>}
        <span className="row-sub olog-time">{ago(e.ts)}</span>
        {acts}
      </div>
      <div className="olog-section">
        <div className="olog-label">{isReply ? "Agent asked" : "Decision"}</div>
        <div className={`olog-q ${open ? "open" : ""}`}>{question || <span className="row-sub">(no text captured)</span>}</div>
      </div>
      {e.error && <div className="oracle-warn"><AlertTriangle size={12} /> {e.error}</div>}
      {(e.answer || e.rationale) && (
        <div className="olog-section">
          <div className="olog-label"><Bot size={12} /> {who}{e.answer ? " answered" : ""}{sure}</div>
          {e.answer && <div className="olog-answer">{isReply ? `“${e.answer}”` : e.answer}</div>}
          {e.rationale && <div className="olog-rationale">{e.rationale}</div>}
        </div>
      )}
      <button className="hist-more" onClick={onToggle}>{open ? "hide detail" : "show detail"}</button>
      {open && (
        <div className="oracle-detail">
          {e.options.length > 0 && (
            <div className="olog-section">
              <div className="olog-label">Options</div>
              <div className="oracle-opts">
                {e.options.map((o) => <span key={o.index} className={`oracle-opt ${o.index === e.choice ? "chosen" : ""}`}>{o.index}. {o.label}</span>)}
              </div>
            </div>
          )}
          {facts.length > 0 && <div className="olog-meta">{facts.join(" · ")}</div>}
          {e.contextSent && (
            <div className="olog-section">
              <div className="olog-label">What {who} was shown</div>
              <pre className="hist-out open">{cleanTerm(e.contextSent)}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
