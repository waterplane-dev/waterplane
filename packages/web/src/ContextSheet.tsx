/**
 * The context window, as a shape — with the walls and the compactions on it.
 *
 * ── The question this answers ───────────────────────────────────────────────
 *
 * "Context 43% free" is a badge, and a badge can only say where you are. The
 * three questions a person actually has are about the SHAPE: is this
 * conversation climbing fast enough that it will compact before the task is
 * done, did the last compaction happen where the previous ones did, and was
 * that four-hour gap a usage wall or just me not typing. None of those is
 * answerable from a number that is overwritten in place.
 *
 * ── Where the data comes from, and why it is not the screen ─────────────────
 *
 * The CLI's own conversation log, which is DATED — the same argument
 * `limitlog.ts` makes. A series accumulated from the scraped meter would start
 * empty on every host restart, hold only what one daemon lifetime saw, and be
 * full of holes wherever the indicator was not on screen; and it could not
 * place a compaction in time at all. The log carries every reading, every
 * compaction (with both sides of the drop) and every rejection, each with its
 * own timestamp. Host `ctxlog.ts` parses it; nothing here re-derives anything.
 *
 * ── Two rules it holds to ───────────────────────────────────────────────────
 *
 *  - **A cached curve says how old it is.** Read through `useRemoteResource`
 *    with the IndexedDB copy seeded FIRST, because this is read at exactly the
 *    moment the link is the thing misbehaving, and a spinner is a worse answer
 *    than a curve labelled "from 20 min ago".
 *  - **Nothing is gated behind the crosshair.** Every headline is a sentence
 *    above its chart, and the drag readout is a text line under it.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { BarChart3, Bot, Coins, ListChecks, Loader, RefreshCw, RotateCcw, Scissors, SearchCheck, Wallet } from "lucide-react";
import type { AgentRun, ContextSample, ContextSeriesDoc } from "@waterplane/shared";
import {
  coldStartText, sessionCostOfSeries, tokenTotal as tokenTot,
} from "@waterplane/shared";
import { SheetHead } from "./Sheet";
import { Empty } from "./Empty";
import { Unavailable } from "./Unavailable";
import { CompactionPanel } from "./CompactionPanel";
import { NextTurnCost } from "./NextTurnCost";
import { api } from "./api";
import { useRemoteResource } from "./useRemoteResource";
import { getContextSeriesAt, putContextSeries } from "./offlineCache";
import { AgentLanesChart, ContextChart, ContextLegend, ModelLegend, SpendChart, SpendLegend, StackLegend } from "./ContextGraph";
import { CacheVerdict, KindBar } from "./kit/chart/TokenComposition";
import { ScrubHint } from "./kit/chart/ScrubHint";
import {
  agentReadout, agentSummary, agentUndatedText, autoCompactSetText, axisNote, fmtAxisTime, fmtGap, fmtReading, kindSeries,
  makePlot, modelSlots, seriesSummary, spendFacts,
  spendNote, spendSplit, spendSummary, splitNote, splitSummary,
} from "./contextPlot";
import { GAP_BREAK_MS } from "./contextPlot";
import { AgentTopList, AgentWarnLine } from "./AgentTopList";
import { DollarsWhy } from "./TurnCostCard";
import { SkillSection } from "./SkillLanes";
import { CarriedSection } from "./CarriedSection";
import { Button } from "./kit/Button";
import { Hint } from "./kit/Hint";

/** Chart height. Sized to include the x-axis band — a fixed height that only
 *  fits the plot is what gives a chart card its own tiny nested scrollbar. */
const CHART_H = 220;
/** The spend chart under it. Shorter on purpose: it carries one monotone curve
 *  and one reference line, and giving it equal height would say the two charts
 *  are equally hard to read rather than that one is the answer to the other. */
const SPEND_H = 110;

export function ContextSheet({ sessionId, title, online, liveAgentNote, onReplan, replanCant, replanNote, agentWarn, budget, onFresh, onCompact, compactCant, onExplainCost, unmeasured, backendLabel, onOpenSetup, setupCant, onOpenAllSessions, onClose }: {
  sessionId: string;
  /** The session's own name, so the sheet says WHICH conversation this is. */
  title: string;
  /**
   * The backend's own label, or absent for claude.
   *
   * Used by exactly one sentence: the axis caption for `windowFrom: "config"`,
   * which must ATTRIBUTE the window to whoever's configuration stated it
   * (`contextPlot.ts`'s `axisNote`). Absent falls back to a neutral noun, so a
   * host that never described a backend reads correctly and a third backend
   * needs no edit here.
   */
  backendLabel?: string;
  /** The socket's verdict, not `navigator.onLine` — see `useRemoteResource`. */
  online: boolean;
  /**
   * `liveAgentText` for the subject, when a subagent under it is running on a
   * huge window right now — the row chip's sentence in full. Off the session's
   * SPARK, not this sheet's document, which has no notion of "now running".
   * Absent/null ⇒ nothing drawn.
   */
  liveAgentNote?: string | null;
  /**
   * "Interrupt and re-plan" on the large-agent card: Esc, then a queued prompt
   * (the caller owns both sends, aimed at the SUBJECT). Absent means this
   * backend cannot take it, and `replanCant` is the sentence drawn instead.
   */
  onReplan?: () => void;
  replanCant?: string;
  /** The line under the button: what Esc does and what is lost. */
  replanNote?: string;
  /**
   * The large-agent line (tokens) and how to change it. Drawn on the budget
   * card whether or not a budget is set; the caller persists it (synced, so the
   * desktop's push uses the same number). Absent means no control.
   */
  agentWarn?: { value: number; onChange: (tok: number) => void };
  /**
   * The session's own budget, already worded (`features/sessionBudget`'s
   * `budgetStateLine` over shared's sentences — this file words nothing about
   * it): spend against the cap with the subagent split, where it stands, and a
   * door to the sheet that sets it. `label` null is "no budget"; the door is
   * drawn either way, because setting one is the point of the panel. `line`
   * null is nothing to add to the title (no budget, spend unknown): the card is
   * then its title and its door, never the title said again as a body.
   */
  budget?: { label: string | null; line: string | null; onOpen: () => void };
  /**
   * Open a new session in the same repo, if the caller can.
   *
   * The cost panel's whole argument is "this would be cheaper somewhere new",
   * and an argument with no door next to it is a lecture. Optional because the
   * sheet is reachable for a session whose repo the caller cannot resolve —
   * and then the panel simply makes its point without the button, rather than
   * offering one that would do nothing.
   */
  onFresh?: () => void;
  /**
   * Type `/compact` into THIS conversation — the other door, and the one the
   * ledger under the panel can already put a figure on.
   *
   * It is not the same offer as `onFresh` and is deliberately drawn first —
   * once, on the Context window chart's name, above the cost panel: a
   * compaction keeps the thread and re-reads a summary of it, so it answers the
   * common case (this work still needs what is here) that a fresh session
   * cannot. `costDoorsText` is the sentence that says so.
   *
   * The caller owns the send, because the subject of this sheet is not
   * necessarily the attached session (`ctxSid` — a launcher row's cost tile
   * opens the graph without attaching), and a command typed into the wrong
   * conversation is the one failure this would have.
   */
  onCompact?: () => void;
  /**
   * Why `/compact` is not offered — passed when this session's backend takes no
   * slash commands (`backendCaps.ts`'s `slash`).
   *
   * Exactly the `headerCmds.ts` bug, which was a `/compact` chip two rows above
   * three sentences saying this backend has no slash commands: tapped, it asked
   * the binary in English to compact itself. So the button is ABSENT and the
   * reason is a line of text — never a dimmed control, and never silence.
   */
  compactCant?: string;
  /**
   * Start a NEW session whose prompt explains what made this one expensive and
   * outlines how it could be cheaper — a reading that implements nothing until
   * the person picks an idea. Absent when there is no conversation id for the
   * prompt to name, and then the sheet says so in text.
   */
  onExplainCost?: () => void;
  /**
   * Why there is nothing to plot — passed only when this session's backend has
   * no context SERIES to draw (`backendCaps.ts`'s derived `contextSeries`, not
   * the live gauge). The two came apart the moment a backend turned up that
   * prints no gauge on its screen and still keeps a record history can be read
   * out of: gating this on `contextMeter` would have refused the graph to a
   * session that has one.
   *
   * It is a claim of NON-MEASUREMENT and it replaces the whole sheet: no
   * read, no axis, no 0%. The empty state below would otherwise say "this
   * conversation has not completed a turn", which is a statement about the
   * conversation — and for a backend that never writes a readable log it is
   * simply false. `docs/notes/web.md`: a heuristic degrades to absent, never
   * to a wrong number.
   */
  unmeasured?: string;
  /**
   * The repo readings sheet (Setup region) of this session's repo: what the repo and this desktop
   * WILL put in every turn, beside what this one's first request DID carry. Navigation, not a
   * body-changing choice, so a door row and not a `.ts-filter`. Absent ⇒ `setupCant` in text.
   */
  onOpenSetup?: () => void;
  setupCant?: string;
  /** The all-sessions token screen. */
  onOpenAllSessions?: () => void;
  onClose: () => void;
}) {
  const res = useRemoteResource<ContextSeriesDoc>(
    `ctx:${sessionId}`,
    // No `since`: the hook has no previous document to compare against, and a
    // 204 here would resolve `null` and blank a curve that was on screen.
    async () => {
      const doc = await api.contextSeries(sessionId);
      if (!doc) throw new Error("no context series");
      return doc;
    },
    {
      // Not asked for at all when there is no gauge behind it: a refusal from
      // the host would render as "error", which is a different sentence.
      enabled: !unmeasured,
      offline: !online,
      fromCache: () => getContextSeriesAt(sessionId),
      toCache: putContextSeries,
    },
  );

  const doc = res.data;
  const [hover, setHover] = useState<ContextSample | null>(null);
  /** The agent tapped on the lane strip — its line under the strip. */
  const [pickedAgent, setPickedAgent] = useState<AgentRun | null>(null);

  // The SVG is drawn at a MEASURED width rather than stretched to fit: a
  // viewBox scaled to a box distorts the stroke and the tick text along with
  // the curve, and a phone rotating is the common case here.
  //
  // Measured through a CALLBACK REF, never `useRef` + a mount effect. The box
  // being measured lives inside `samples.length > 0`, and the series is read
  // asynchronously (the IndexedDB seed included), so on the sheet's FIRST
  // commit — which is every single open — there is no node to observe. An
  // effect with `[]` deps then never looks again: `width` stayed 0 for the life
  // of the sheet and BOTH charts rendered nothing, leaving a summary, a legend,
  // a readout line and a caption arranged around a blank strip. A callback ref
  // fires when the node ARRIVES, which is the event this needs.
  const roRef = useRef<ResizeObserver | null>(null);
  const [width, setWidth] = useState(0);
  const boxRef = useCallback((el: HTMLDivElement | null) => {
    roRef.current?.disconnect();
    roRef.current = null;
    // Detached: the values view replaced the chart. The last width is KEPT —
    // toggling back re-measures anyway, and zeroing it would blank the chart
    // for one frame on the way back.
    if (!el) return;
    // `clientWidth` is the PADDING box, not the content box — `.ctx-box`
    // carries its own left/right padding for the gutter every other row in
    // this list has. Drawing the SVG at the padded width pushed it that much
    // too wide for the space actually left after the padding, so a
    // right-anchored label (the axis's last tick, a ref line's "with
    // subagents") rendered past the visible edge instead of inside the
    // gutter that was supposed to hold it clear of it.
    const contentWidth = (el: HTMLDivElement) => {
      const cs = getComputedStyle(el);
      return el.clientWidth - parseFloat(cs.paddingLeft || "0") - parseFloat(cs.paddingRight || "0");
    };
    setWidth(contentWidth(el));
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setWidth(contentWidth(el)));
    ro.observe(el);
    roRef.current = ro;
  }, []);
  useEffect(() => () => roRef.current?.disconnect(), []);

  const onHover = useCallback((s: ContextSample | null) => setHover(s), []);

  const samples = doc?.samples ?? [];
  const events = doc?.events ?? [];
  const span = samples.length ? samples[samples.length - 1].t - samples[0].t : 0;
  const windowTok = doc?.windowTok ?? null;
  const summary = seriesSummary(samples, events, windowTok, doc?.agents);
  // The same rule the chip on the row reads, off the FULL series rather than
  // the sixteen-point spark — same function, better input.
  // The last argument is the HOST's measurement of what was spent: the output
  // side and the subagent logs are not in `samples` and cannot be derived from
  // them, so an older host simply leaves the sentence off.
  // The last sample's own timestamp is when the newest REQUEST in this
  // conversation was recorded, which is what the cache's clock runs from — a
  // better input than the row's `lastTurnAt` and one this sheet already holds,
  // so no prop and no wire field is added for it. `now` is read here, on the
  // phone, for the reason `sessionCostPill` states.
  // What the expired-cache re-writes in THIS conversation came to — the one
  // wording, shared with the launcher row's title and the all-sessions screen.
  const coldNote = coldStartText(doc?.coldStarts, "session");
  const cost = sessionCostOfSeries(samples, doc?.truncated ?? false, doc?.turns ?? null,
    doc ? { usageTok: doc.usageTok, agentTok: doc.agentTok } : null,
    samples.length ? { lastTurnAt: samples[samples.length - 1].t, now: Date.now() } : null);
  // Long dead stretches are compressed, and the note says how much. Derived
  // the same way the chart derives them so the two cannot disagree.
  // What it has SPENT, which the curve above cannot say: that one is a level
  // and falls at every compaction. Null — and the chart absent, never a flat
  // line at zero — on a host or a backend that records no running total.
  // The money rides with it: the host priced every record on its own model and
  // day (`pricing.ts`), and this screen adds the conversation's cost to its
  // agents' the same way it adds their tokens. Never re-derived here from a
  // total and one rate — that is the arithmetic the launcher row and the
  // all-sessions screen would then each do differently.
  const spend = spendFacts(samples, doc?.usageTok, doc?.agentTok, doc?.cost
    ? {
      total: doc.cost.total + (doc.agentCost?.total ?? 0),
      agents: doc.agentCost?.total ?? null,
      unpricedTok: doc.unpricedTok ?? null,
    }
    : null);
  // What those tokens WERE. A separate fact from the curve and from the total,
  // and the one this screen was missing: "16M spent" with no split beside it
  // is the number `shared/tokens.ts` opens by calling the app's most
  // misleading. Null on a host that sends no split, and then this section is
  // absent — never a bar of zeros. Held independently of `spend` on purpose:
  // the two arrive from different fields, and a split with no curve is still
  // worth drawing.
  const split = spendSplit(doc?.split, doc?.agentSplit);

  // ── stacked by token kind ──────────────────────────────────────────────
  //
  // The model→slot map is decided ONCE, off the document, and handed to both
  // the areas and the subagent bars: they read two different arrays, and a
  // model that took slot 2 on one and fell into "other" on the one directly
  // below it would be the same entity in two colours on one screen.
  const agents = doc?.agents ?? [];
  const slots = modelSlots(doc?.models, samples.some((sm) => sm.model == null) || agents.some((a) => a.model == null));
  // The CONTEXT chart stacks the three kinds that ARE context. Output is not in
  // the window until the turn after, so a stack containing it would not add up
  // to the line it is drawn inside — a chart disagreeing with itself in the one
  // way nobody checks.
  const ctxKinds = kindSeries(samples, "kinds", (id) => id !== "output");
  // The SPEND chart stacks all four, off the CUMULATIVE tuple: its line is a
  // running total, and a stack of per-request values under it would end
  // somewhere far below it.
  const spendKinds = kindSeries(samples, "cum");
  // Always stacked by token kind (the picker is gone); flat where no kinds.
  const ctxBands = ctxKinds;
  const spendBands = spendKinds;
  const gaps = samples.slice(0, -1)
    .map((s, i) => samples[i + 1].t - s.t)
    .filter((d) => d > GAP_BREAK_MS);

  const doorsRow = (onOpenSetup || onOpenAllSessions) && <div className="sheet-actions ctx-doors">
        {onOpenSetup && (
          <Button onClick={onOpenSetup} title="What this repo and this desktop put in every turn, file by file">
            <ListChecks size={12} /> repo readings
          </Button>
        )}
        {onOpenAllSessions && (
          <Button onClick={onOpenAllSessions} title="Every conversation on this desktop, with its token split">
            <Coins size={12} /> all sessions
          </Button>
        )}
      </div>;

  if (unmeasured) {
    return (
      <div className="sheet">
        <SheetHead title={<><BarChart3 size={16} style={{ verticalAlign: "-3px", marginRight: 4 }} />Context window &amp; cost</>} onClose={onClose} />
        {doorsRow}
        <Unavailable cants={[{ label: "context graph", reason: unmeasured }]} />
        <Hint>
          {title} — nothing on this screen is a measurement of it. The terminal is still the whole story.
        </Hint>
      </div>
    );
  }

  /**
   * ── The grammar this screen is arranged by ─────────────────────────────────
   *
   * Four rules, and every one of them was a bug here before it was a rule.
   *
   *  1. **`.sheet-head` holds chrome only** — the way back, and verbs about the
   *     DOCUMENT (re-read it). Nothing in the head changes what the body SHOWS.
   *  2. **A choice that changes the body is a `.ts-filter` row of labelled
   *     `.key` chips**, lit with `.key.active`, placed DIRECTLY ABOVE the first
   *     thing it changes — the same vocabulary as the all-sessions screen.
   *  3. **A verb that cannot run is not drawn**; its reason is a sentence
   *     (`Unavailable.tsx`). A verb that is RUNNING says so in its own glyph.
   *  4. **`.key.on` is never written on this screen** (no CSS rule outside
   *     `.bl-modal-seg`); `.key.active` is the accent fill.
   *
   * And the ORDER: **the charts sit together, then the panels, then the
   * captions.** Summary → spend · context · spend · agents (one width, one
   * x axis, adjacent, so a step in one lines up with a bar in the next) → the
   * composition strip → the cost panel and its door → expired cache →
   * compactions → captions. The panels used to be interleaved under the chart
   * each was "about", which put three blocks of prose between charts that share
   * an axis and are read together. Each panel leads with a sentence or two;
   * method prose folds into `details.hint-more`, and an ABSENCE never folds.
   */
  const spendNotes = spend ? spendNote(spend, doc?.truncated ?? false, !!doc?.agentCum?.length) : null;
  const splitNotes = split ? splitNote(split, doc?.truncated ?? false) : null;
  const undated = agentUndatedText(agents, doc?.agentTok);
  return (
    <div className="sheet">
      <SheetHead title={<><BarChart3 size={16} style={{ verticalAlign: "-3px", marginRight: 4 }} />Context window &amp; cost</>} onClose={onClose}>
        {/* Chrome: re-reads the DOCUMENT. While a read is in flight the glyph
            SAYS so and the handler returns early — never `disabled`. Keyed on
            `inflight`, never `state === "loading"`, which a quiet reload never
            enters. */}
        <Button onClick={() => { if (res.inflight) return; res.reload({ quiet: true }); }}
          title="re-read — this is a point-in-time answer, not a live feed">
          {res.inflight ? <Loader size={14} className="spin" /> : <RefreshCw size={14} />}
        </Button>
      </SheetHead>

      {/* WHICH conversation, and nothing else — the method caption is at the foot. */}
      <Hint>{title}</Hint>
      {doorsRow}
      {!onOpenSetup && setupCant && <Unavailable cants={[{ label: "repo readings", reason: setupCant }]} />}

      <Empty res={res} empty={!samples.length} thing="the context history" noun="graph"
        note={res.state === "error" ? "A session that has not run a turn yet has no log to read." : undefined}>
        Nothing to plot yet — this conversation has not completed a turn.
      </Empty>

      {/* Attachments are written before the first answer: measured without a single sample. */}
      {!samples.length && doc && <CarriedSection carried={doc.carried} />}

      {samples.length > 0 && (
        <div className="list">
          {/* ── THE CHARTS, together ─────────────────────────────────────────
              Same width, same `makePlot` x axis, nothing between them but
              their own headline and legend. */}
          <>
            {/* What it has SPENT leads: the total cost is the question most
                opens ask. The agents' spend is the grey band on top. */}
            {spend && <>
              <div className="ctx-chart-title">{spend.costUsd != null ? "Total cost" : "Tokens spent"}</div>
              <div className="ctx-summary">{spendSummary(spend, doc?.truncated ?? false)}</div>
              <div className="ctx-box">
                {width > 0 && (
                  <SpendChart samples={samples} events={events} facts={spend}
                    width={width} height={SPEND_H} bands={spendBands} agents={agents} agentCum={doc?.agentCum} />
                )}
              </div>
              <SpendLegend agents={spend.agents != null && !!doc?.agentCum?.length}
                dashed={spend.total != null && spend.agents != null} stacked={!!spendBands} />
              {spendNotes?.lead && <div className="empty ctx-note">{spendNotes.lead}</div>}
              {spend.costUsd != null && <DollarsWhy className="ctx-method" />}
            </>}

            {/* The window held, on the same x axis: the spend above is its integral.
                `/compact` sits at the END of this chart's name — the window is what
                it changes — and this is the sheet's ONE `/compact`. The cost panel
                below carried a second (`/compact this one`, same send, same
                subject) several screens down and only once there was advice; two
                doors to one send read as two different things. Absent with its
                reason in TEXT, said here once. */}
            <div className="ctx-chart-title ctx-chart-title-row">
              <span>Context window</span>
              {onCompact && (
                <Button onClick={onCompact}>
                  <Scissors size={14} /> /compact
                </Button>
              )}
            </div>
            {!onCompact && compactCant && (
              <Unavailable cants={[{ label: "/compact from here", reason: compactCant }]} />
            )}
            {summary && <div className="ctx-summary">{summary}</div>}
            <div className="ctx-box" ref={boxRef}>
              {width > 0 && (
                <ContextChart samples={samples} events={events} width={width} height={CHART_H}
                  windowTok={windowTok} autoCompactTok={doc?.autoCompactTok ?? null}
                  autoCompactSetTok={doc?.autoCompactSet?.tokens ?? null}
                  onHover={onHover} bands={ctxBands} agents={agents} />
              )}
            </div>
            {/* Holds its height whether or not a finger is down. */}
            <div className="ctx-readout">
              {hover
                ? `${fmtAxisTime(hover.t, span)} · ${fmtReading(hover.tok, windowTok)}`
                : <ScrubHint />}
            </div>
            <ContextLegend events={events} agents={agents.filter((a) => a.ctx?.length).length} />
            {ctxBands && width > 0 && (
              <StackLegend p={makePlot({
                width, height: CHART_H, pad: { top: 10, right: 10, bottom: 20, left: 40 },
                samples, events, refs: [], windowTok, agents,
              })} samples={samples} series={ctxBands} />
            )}

            {/* Every subagent as a bar over its own span, on the same axis. */}
            {agents.length > 0 && <>
              <div className="ctx-chart-title">Subagents</div>
              <div className="ctx-summary">{agentSummary(agents, doc?.models)}</div>
              <div className="ctx-box">
                {width > 0 && (
                  <AgentLanesChart samples={samples} events={events} agents={agents}
                    slots={slots} width={width} picked={pickedAgent} onPick={setPickedAgent} />
                )}
              </div>
              <div className="ctx-readout">
                {pickedAgent ? agentReadout(pickedAgent, doc?.models, span) : "tap a bar to read that agent"}
              </div>
              <ModelLegend slots={slots} only={new Set(agents.map((a) => slots?.slotOf(a.model) ?? 0))} />
              <AgentTopList agents={agents} models={doc?.models} picked={pickedAgent} onPick={setPickedAgent} />
            </>}
            {undated && <div className="empty ctx-note">{undated}</div>}

            {/* Which skills entered a window, and when — one row per skill. */}
            <SkillSection samples={samples} events={events} own={doc?.skills} agents={agents}
              width={width} span={span} />

            {/* What the FIRST request carried, part by part (after the skills, owner D). */}
            {doc && <CarriedSection carried={doc.carried} />}

            {/* HOW the two lower charts are counted — method, so folded. */}
            {(spendNotes || agents.length > 0) && (
              <details className="hint-more ctx-method">
                <summary>how the spend and agent charts are counted</summary>
                {spendNotes && <p>{spendNotes.more}</p>}
                {agents.length > 0 && (
                  <p>
                    Each bar runs from an agent's first dated record to its last, coloured by the model
                    that ran it, and packed into as few rows as fit without two bars overlapping — a row
                    is not an identity, only the first one that had room. The outlined bar spent the
                    most. A floor, like every reading here: an agent log this desktop never saw is one
                    nothing can place.
                  </p>
                )}
              </details>
            )}
          </>

          {/* ── What those tokens WERE ───────────────────────────────────────
              Same hues and words as the all-sessions screen. */}
          {split && <>
            {splitSummary(split) && <div className="ctx-summary">{splitSummary(split)}</div>}
            <KindBar bag={split.all} whole={tokenTot(split.all)} />
            {splitNotes?.lead && <div className="empty ctx-note">{splitNotes.lead}</div>}
            {/* Scoped to the session: the corpus wording points at this screen,
                and its advice would repeat the cost panel below. */}
            <CacheVerdict totals={split.all} scope="session" />
            {splitNotes && (
              <details className="hint-more ctx-method">
                <summary>how these kinds are counted</summary>
                <p>{splitNotes.more}</p>
              </details>
            )}
          </>}

          {/* ── What the next turn costs, and the fresh-session door ─────────
              A reading, never a gate. The lead is the note and the advice; the
              doors' difference and the mechanism fold. */}
          {liveAgentNote && (
            <div className="ctx-cost ctx-cost-heavy">
              <div className="ctx-cost-head">
                <Bot size={14} />
                <span>a subagent is running on a large window</span>
              </div>
              <div className="ctx-cost-note">{liveAgentNote}</div>
              {onReplan ? <>
                <div className="sheet-actions">
                  <Button onClick={onReplan}>
                    <RotateCcw size={14} /> interrupt and re-plan
                  </Button>
                </div>
                {replanNote && <Hint>{replanNote}</Hint>}
              </> : replanCant ? (
                <Unavailable cants={[{ label: "interrupt and re-plan", reason: replanCant }]} />
              ) : null}
            </div>
          )}
          {cost && <NextTurnCost cost={cost} onFresh={onFresh} onCompact={onCompact} />}

          {/* The session's own budget: spend against the cap with the agent split,
              where it stands, and the door to the sheet. A readout and a door —
              nothing here sets or clears. Unknown says why and holds nothing.
              "No budget" is the TITLE's to say: the line under it is only what
              was spent, and absent when there is nothing to add. */}
          {(budget || agentWarn) && (
            <div className="ctx-cost">
              {budget && <>
                <div className="ctx-cost-head">
                  <Wallet size={14} />
                  <span>{budget.label ? `budget ${budget.label}` : "no budget on this session"}</span>
                </div>
                {budget.line ? <div className="ctx-cost-note">{budget.line}</div> : null}
                <div className="sheet-actions">
                  <Button onClick={budget.onOpen}>
                    <Wallet size={14} /> {budget.label ? "change or clear the budget" : "set a budget"}
                  </Button>
                </div>
              </>}
              {/* The second row: the line that calls a running agent large. Its
                  own card heading only when no budget row stands above it. */}
              {agentWarn && <>
                {!budget && <div className="ctx-cost-head"><Bot size={14} /><span>large subagents</span></div>}
                <AgentWarnLine value={agentWarn.value} onChange={agentWarn.onChange} />
              </>}
            </div>
          )}

          {/* The third door, a question rather than a move: a new session reads
              this transcript and says what made it dear — then stops and asks. */}
          <div className="ctx-cost">
            <div className="ctx-cost-head">
              <SearchCheck size={14} />
              <span>why it cost this much</span>
            </div>
            {onExplainCost ? <>
              <div className="ctx-cost-note">
                A new session in this directory measures this conversation's
                transcript, names what made it expensive and lists ideas to
                make it cheaper — it changes nothing until you pick one.
              </div>
              <div className="sheet-actions">
                <Button onClick={onExplainCost}>
                  <SearchCheck size={14} /> explain the cost of this session
                </Button>
              </div>
            </> : (
              <Unavailable cants={[{
                label: "explain the cost of this session",
                reason: "this session has no conversation id yet, so there is no transcript to point a new session at",
              }]} />
            )}
          </div>

          {/* What the GAPS cost — money no prompt asked for, drawn only when it
              happened. On no chart: the window does not move when a cache
              expires, which the fold says for a reader looking for the event. */}
          {coldNote && (
            <div className="ctx-panel">
              <div className="ctx-summary">Expired cache</div>
              <Hint>{coldNote}</Hint>
              <details className="hint-more ctx-method">
                <summary>why a cold cache costs more</summary>
                <p>
                  A conversation resumed inside the hour re-reads its window out of the cache at a
                  tenth of the write rate. After that the window has to be written again before it can
                  answer anything — the same tokens, up to twenty times the price, and the chart
                  does not move when it happens.
                </p>
              </details>
            </div>
          )}

          {/* What the compactions on the context chart DID. Outside the switch:
              words and numbers in both halves. */}
          {doc?.compaction && (
            <CompactionPanel l={doc.compaction} windowTok={windowTok}
              tok={samples.length ? samples[samples.length - 1].tok : null} />
          )}

          {/* ── Captions ─────────────────────────────────────────────────────
              A truncated log is an absence and stays open; `axisNote` changes
              with the document and names the scale every reading is on; the
              method claim folds. A caption never names a MARK the other half
              does not draw. */}
          {/* Said once: the spend and split leads already carry it when drawn. */}
          {doc?.truncated && !spendNotes && !splitNotes && (
            <div className="empty ctx-note">
              This conversation’s log is longer than the host reads in one go, so the
              curve starts part-way through it.
            </div>
          )}
          <div className="empty ctx-note">
            {axisNote(doc?.windowFrom, windowTok, doc?.model, backendLabel)}
            {doc?.autoCompactTok != null && " The dashed line is where a compaction was last observed to fire — a measurement, not a setting."}
            {doc?.autoCompactSet && ` ${autoCompactSetText(doc.autoCompactSet)}`}
          </div>
          {gaps.length > 0 && (
            <div className="empty ctx-note">
              {gaps.length === 1
                ? `One stretch of ${fmtGap(gaps[0])} with no activity is compressed on the time axis (the ⁄⁄ mark).`
                : `${gaps.length} stretches with no activity — the longest ${fmtGap(Math.max(...gaps))} — are compressed on the time axis (the ⁄⁄ marks).`}
            </div>
          )}
          <details className="hint-more ctx-method">
            <summary>where these numbers come from</summary>
            <p>
              How many tokens each request carried, read off the CLI’s own
              conversation log and each subagent’s own log. Both are dated, which
              is what lets a compaction, a usage wall and every agent sit on the
              same time axis as the curve.
            </p>
          </details>
        </div>
      )}
    </div>
  );
}
