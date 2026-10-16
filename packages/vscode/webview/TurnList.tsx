import { useState } from "react";
import { RefreshCw } from "lucide-react";
import { fmtCount, fmtUsd, tokenTotal, contextPct } from "@waterplane/shared";
import { KindBar } from "@waterplane/kit";
import type { PromptDef, ToExtension, TurnCost } from "../src/protocol";
import { PromptActions } from "./Actions";
import { Absent } from "./Absent";
import { ListPrice } from "./Money";
import { useNow } from "./HealthView";
import { isRunning, runningTurn, runningWords } from "../src/data/running";

const SHOWN = 40;

function ctxText(t: TurnCost, windowTok: number | null): string {
  if (t.ctxTok == null) return "context unknown";
  const pct = contextPct(t.ctxTok, windowTok);
  return pct == null ? `${fmtCount(t.ctxTok)} context · window unknown` : `${fmtCount(t.ctxTok)} context (${Math.round(pct)}%)`;
}

const costWords = (t: TurnCost): string => (t.costUsd != null && t.costUsd > 0 ? fmtUsd(t.costUsd) : "no price");

/**
 * Per-prompt cost, newest first. A row selects the prompt; the detail below it is where its
 * dollars meet their split. The list says how many it is hiding ("40 of 213") and has a button
 * to see all of them.
 */
export function TurnList({ turns, windowTok, updatedAt, selected, onSelect, prompts, terminal, post }: {
  turns: TurnCost[];
  windowTok: number | null;
  /** The log's last write: a turn is only "running" while it is recent. */
  updatedAt: number;
  selected: number | null;
  onSelect: (n: number | null) => void;
  prompts: PromptDef[];
  terminal: string | null;
  post: (m: ToExtension) => void;
}) {
  const [all, setAll] = useState(false);
  // One tick a second while the log ends mid-turn AND was written lately (a killed session stops ticking after RUNNING_FRESH_MS), so the clock and the staleness cut keep moving.
  const now = useNow(isRunning(turns[turns.length - 1]?.open === true, updatedAt, Date.now()));
  const running = runningTurn(turns, updatedAt, now);
  if (!turns.length) return <Absent>No prompts in this log yet.</Absent>;
  const newest = [...turns].reverse().filter((t) => t !== running);
  const pinned = running ? 1 : 0;
  const shown = all ? newest : newest.slice(0, SHOWN);
  const sel = turns.find((t) => t.n === selected) ?? null;
  const canExplain = prompts.some((p) => p.id === "explain-turn");
  return (
    <div className="turns">
      <div className="ctx-chart-title">What each prompt cost</div>
      <div className="ctx-summary" role="status">
        {shown.length === newest.length
          ? `All ${fmtCount(turns.length)} prompts, newest first.`
          : `${fmtCount(shown.length + pinned)} of ${fmtCount(turns.length)} prompts, newest first — the older ${fmtCount(newest.length - shown.length)} are hidden.`}
        {newest.length > SHOWN && (
          <> <button type="button" className="link-btn" onClick={() => setAll(!all)}>{all ? `Show newest ${SHOWN} only` : "Show all"}</button></>
        )}
      </div>
      <ul className="turn-list">
        {running && (
          <li>
            <button type="button" className={`turn-row running${running.n === selected ? " active" : ""}`}
              aria-pressed={running.n === selected} onClick={() => onSelect(running.n === selected ? null : running.n)}>
              <span className="turn-cost"><RefreshCw size={14} className="spin" aria-hidden /></span>
              <span className="turn-meta">{runningWords(running, now)}</span>
              <span className="turn-prompt">{running.prompt || "(empty prompt)"}</span>
            </button>
          </li>
        )}
        {shown.map((t) => (
          <li key={t.n}>
            <button type="button" className={`turn-row${t.n === selected ? " active" : ""}`}
              aria-pressed={t.n === selected} onClick={() => onSelect(t.n === selected ? null : t.n)}>
              <span className="turn-cost">{costWords(t)}</span>
              <span className="turn-meta">{ctxText(t, windowTok)} · {t.requests} {t.requests === 1 ? "request" : "requests"}</span>
              <span className="turn-prompt">{t.n === 0 ? "(before the first prompt)" : t.prompt || "(empty prompt)"}</span>
            </button>
          </li>
        ))}
      </ul>
      {sel ? (
        <div className="turn-detail">
          <div className="ctx-chart-title">{sel.n === 0 ? "Before the first prompt" : `Prompt ${sel.n}`}</div>
          <div className="cost-head">
            <span className="cost-total">{costWords(sel)}</span>
            <span className="cost-label">{new Date(sel.at).toLocaleString()}</span>
          </div>
          <KindBar bag={sel.kinds} whole={tokenTotal(sel.kinds)} />
          <div className="ctx-summary">
            {sel.cumCostUsd != null && sel.cumCostUsd > 0 ? `${fmtUsd(sel.cumCostUsd)} for the session through this prompt. ` : ""}
            {sel.unpricedTok > 0 ? `${fmtCount(sel.unpricedTok)} tokens ran on a model with no published rate and are in no dollar figure. ` : ""}
            The split above is tokens; the model’s rates differ by kind, so it is not the split of the dollars.
          </div>
          <ListPrice />
          {canExplain && sel.n > 0 && (
            <>
              <div className="ctx-chart-title">Why was this expensive?</div>
              <div className="ctx-summary">Builds a question about this prompt’s row for Claude Code. It changes no files.</div>
              <PromptActions id="explain-turn" turn={sel.n} terminal={terminal} post={post} />
            </>
          )}
        </div>
      ) : (
        <Absent>Pick a prompt above to see its split and ask why it was expensive.</Absent>
      )}
    </div>
  );
}
