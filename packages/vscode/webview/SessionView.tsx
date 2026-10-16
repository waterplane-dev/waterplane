import { useState } from "react";
import {
  addTotals, coldStartText, compactionReading, costText, fmtCount, sessionCostOfSeries, tokenTotal, zeroTotals,
} from "@waterplane/shared";
import { KindBar, CacheVerdict, SCRUB_HINT, useBoxWidth } from "@waterplane/kit";
import {
  agentReadout, agentSummary, agentUndatedText, axisNote, fmtAxisTime, fmtReading, kindSeries, makePlot, modelSlots,
  seriesSummary, spendFacts, spendNote, spendSummary,
} from "../../web/src/contextPlot";
import {
  AgentLanesChart, ContextChart, ContextLegend, ModelLegend, SpendChart, SpendLegend, StackLegend,
} from "../../web/src/ContextGraph";
import { CompactionPanel } from "../../web/src/CompactionPanel";
import { NextTurnCost } from "../../web/src/NextTurnCost";
import type { AgentRun, ContextSample } from "@waterplane/shared";
import type { PromptDef, SessionDoc, ToExtension } from "../src/protocol";
import { Absent } from "./Absent";
import { CostBlock, ListPrice } from "./Money";
import { sessionTotal } from "../src/data/sessiontotal";
import { TurnList } from "./TurnList";

const CHART_H = 200;
const SPEND_H = 96;
const PAD = { top: 10, right: 10, bottom: 20, left: 40 };

export function SessionView({ doc, why, prompts, terminal, selectedTurn, onSelectTurn, post }: {
  doc: SessionDoc | null;
  why?: string;
  prompts: PromptDef[];
  terminal: string | null;
  selectedTurn: number | null;
  onSelectTurn: (n: number | null) => void;
  post: (m: ToExtension) => void;
}) {
  const [width, boxRef] = useBoxWidth();
  const [hover, setHover] = useState<ContextSample | null>(null);
  // By id, not by object: the roster is rebuilt on every poll, and a pick should read the agent's
  // CURRENT figures (and let go when it is no longer on the roster).
  const [pickedId, setPickedId] = useState<string | null>(null);

  if (!doc) return <Absent>{why ?? "No Claude Code session has been read for this folder yet."}</Absent>;

  const samples = doc.samples;
  const events = doc.events;
  const windowTok = doc.windowTok;
  const span = samples.length ? samples[samples.length - 1].t - samples[0].t : 0;

  // Money: the conversation plus its subagents — the status bar's rule, from the same function.
  const total = sessionTotal(doc);
  const cost = total.cost;
  const agentUsd = total.agentUsd;
  const unpriced = total.unpricedTok;
  const agentTok = doc.agents ? doc.agents.tok : 0;
  const split = doc.agents ? addTotals(addTotals(zeroTotals(), doc.split), doc.agents.split) : doc.split;

  const spend = spendFacts(samples, doc.usageTok + agentTok, agentTok > 0 ? agentTok : null, cost
    ? { total: cost.total, agents: agentUsd, unpricedTok: unpriced }
    : null);
  // The subagents, as the phone's context sheet wires them: one model→slot map for the whole screen,
  // the runs on the context chart's axis, their running total as the spend chart's grey band.
  const agents: AgentRun[] = doc.agents?.runs ?? [];
  const agentCum = doc.agents?.cum ?? null;
  const slots = modelSlots(doc.models, samples.some((s) => s.model == null) || agents.some((a) => a.model == null));
  const pickedAgent = pickedId ? agents.find((a) => a.id === pickedId) ?? null : null;
  const undated = agentUndatedText(agents, doc.agents?.tok);
  const ctxBands = kindSeries(samples, "kinds", (id) => id !== "output");
  const spendBands = kindSeries(samples, "cum");
  const spendNotes = spend ? spendNote(spend, doc.truncated, !!agentCum?.length) : null;
  const summary = seriesSummary(samples, events, windowTok, undefined);

  // The phone's context-sheet reading off the same inputs; no doors (nothing here can start a session or send).
  const nextTurn = sessionCostOfSeries(samples, doc.truncated, doc.turns,
    { usageTok: doc.usageTok, agentTok },
    samples.length ? { lastTurnAt: samples[samples.length - 1].t, now: Date.now() } : null);
  const coldNote = coldStartText(doc.coldStarts, "session");
  const cr = compactionReading(doc.compaction);
  const anyHappened = cr.count > 0 || cr.unmeasured > 0 || !!coldNote;
  // The latest RAW reading — `samples` is downsampled, its last point can be an earlier bucket's max.
  const lastTok = doc.lastTok;

  return (
    <>
      {/* ── what this session cost, with its split ── */}
      <div className="ctx-chart-title">Cost</div>
      {cost ? (
        <CostBlock cost={cost} label={`list price · ${fmtCount(doc.turns)} ${doc.turns === 1 ? "turn" : "turns"}`}>
          <div className="ctx-summary">
            {costText(cost.total, agentUsd, unpriced)}
          </div>
        </CostBlock>
      ) : (
        <div className="cost-block">
          <div className="cost-head">
            <span className="cost-total">{fmtCount(doc.usageTok + agentTok)}</span>
            <span className="cost-label">tokens · no dollar figure</span>
          </div>
          <KindBar bag={split} whole={tokenTotal(split)} />
          <Absent>
            {total.withheld
              ? `${total.withheldWhy ?? "There is no dollar figure."} Tokens only.`
              : unpriced > 0
              ? `${fmtCount(unpriced)} tokens ran on a model with no published rate, so there is no dollar figure — tokens only.`
              : "Nothing in this log could be priced, so there is no dollar figure — tokens only."}
          </Absent>
        </div>
      )}
      {cost && (
        <>
          <div className="ctx-summary">What the tokens were:</div>
          <KindBar bag={split} whole={tokenTotal(split)} />
        </>
      )}
      <CacheVerdict totals={split} scope="session" />
      {doc.agents && (
        <div className="ctx-summary">
          Subagents: {fmtCount(doc.agents.logs)} {doc.agents.logs === 1 ? "log" : "logs"}, {fmtCount(agentTok)} tokens
          {agentUsd != null ? <>, counted in the total above</> : <>, no dollar figure for them</>}.
        </div>
      )}

      {/* ── context window over time ── */}
      <div className="ctx-chart-title">Context window</div>
      <div className="ctx-summary">
        {lastTok != null ? fmtReading(lastTok, windowTok) : "no requests yet"}
        {windowTok == null ? " · window unknown" : ""}
        {summary ? <> — {summary}</> : null}
      </div>
      <div className="ctx-box" ref={boxRef}>
        {width > 0 && samples.length > 0 && (
          <ContextChart samples={samples} events={events} width={width} height={CHART_H}
            windowTok={windowTok} autoCompactTok={doc.autoCompactTok} onHover={setHover} bands={ctxBands} agents={agents} />
        )}
      </div>
      <div className="ctx-readout" aria-live="polite">
        {hover ? `${fmtAxisTime(hover.t, span)} · ${fmtReading(hover.tok, windowTok)}` : SCRUB_HINT}
      </div>
      <ContextLegend events={events} agents={agents.filter((a) => a.ctx?.length).length} />
      {ctxBands && width > 0 && (
        <StackLegend p={makePlot({ width, height: CHART_H, pad: PAD, samples, events, refs: [], windowTok, agents })}
          samples={samples} series={ctxBands} />
      )}
      {nextTurn && <NextTurnCost cost={nextTurn} noDoors />}
      {samples.length === 0 && <Absent>No requests with a context reading in this log yet.</Absent>}
      <div className="empty ctx-note">{axisNote(doc.windowFrom, windowTok, doc.model ?? undefined)}</div>
      {doc.truncated && <Absent>This log is longer than is read in one go, so the curve starts part-way in.</Absent>}

      {/* ── spend over time ── */}
      {spend ? (
        <>
          <div className="ctx-chart-title">{spend.costUsd != null ? "Total cost over time" : "Tokens spent over time"}</div>
          <div className="ctx-summary">{spendSummary(spend, doc.truncated)}</div>
          <div className="ctx-box">
            {width > 0 && (
              <SpendChart samples={samples} events={events} facts={spend} width={width} height={SPEND_H}
                bands={spendBands} agents={agents} agentCum={agentCum} />
            )}
          </div>
          <SpendLegend agents={spend.agents != null && !!agentCum?.length}
            dashed={spend.total != null && spend.agents != null} stacked={!!spendBands} />
          {spendNotes?.lead && <div className="empty ctx-note">{spendNotes.lead}</div>}
          {spend.costUsd != null && <ListPrice />}
        </>
      ) : (
        <Absent>This log does not record output per request, so there is no spend-over-time curve.</Absent>
      )}

      {/* ── every subagent as a bar over its own span, on the same x axis ── */}
      {agents.length > 0 && (
        <>
          <div className="ctx-chart-title">Subagents</div>
          <div className="ctx-summary">{agentSummary(agents, doc.models)}</div>
          <div className="ctx-box">
            {width > 0 && (
              <AgentLanesChart samples={samples} events={events} agents={agents} slots={slots} width={width}
                picked={pickedAgent} onPick={(a) => setPickedId(a?.id ?? null)} />
            )}
          </div>
          <div className="ctx-readout" aria-live="polite">
            {pickedAgent ? agentReadout(pickedAgent, doc.models, span) : "click a bar to read that agent"}
          </div>
          <ModelLegend slots={slots} only={new Set(agents.map((a) => slots?.slotOf(a.model) ?? 0))} />
        </>
      )}
      {undated && <div className="empty ctx-note">{undated}</div>}

      {anyHappened && (
        <>
          <div className="ctx-chart-title">What happened to the window</div>
          <CompactionPanel l={doc.compaction} windowTok={windowTok} tok={lastTok} />
          {coldNote && <div className="empty ctx-note">{coldNote}</div>}
        </>
      )}

      <TurnList turns={doc.turnCosts} windowTok={windowTok} updatedAt={doc.updatedAt} selected={selectedTurn} onSelect={onSelectTurn}
        prompts={prompts} terminal={terminal} post={post} />
    </>
  );
}
