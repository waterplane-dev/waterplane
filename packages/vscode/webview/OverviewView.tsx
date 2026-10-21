/**
 * All sessions: the phone's token-usage sheet, composed from its own leaf cards (imported from
 * source, `packages/extensions/token-stats/web/`) over the `CorpusDoc` the scan worker folds — the
 * same `TokenStatsDoc` shape, so every card reads it unchanged.
 *
 * Laid out as the phone's is since 2026-10-15 (`TokenStatsBody.tsx`, `span.ts`, R-usage-025): a
 * compact NOW block that no switch reaches, then ONE sticky span filter that scopes every box under
 * it — Totals, the costliest conversations and Over time. The spans here are the calendar ones only.
 *
 * What is NOT here, and why: the live five-hour and weekly limit bars, their spans and the
 * past-window grids (the desktop scrapes `/usage` for those — there is no local source, so nothing
 * is drawn in their place), the backend tabs and the session budget. "Where the week went" is the
 * last seven days, rolling, and says so: no reset instant is read on this side.
 *
 * The state and derivations are `TokenStatsBody.tsx`'s, kept to what these cards read.
 */
import { useMemo, useState } from "react";
import {
  coldStartText, cumulative, dayToMs, fmtCount, hourToMs, rankRepos, repoRowAsGroup, tokenTotal,
  type CostBreakdown, type TokenConvo, type TokenTotals, zeroCost, zeroTotals,
} from "@waterplane/shared";
import {
  type DayPoint, fillMix, fillSeries, HOUR_MS, hourPoints, modelBands, rollingMean, useBoxWidth,
} from "@waterplane/kit";
import { Headline } from "../../extensions/token-stats/web/Headline.tsx";
import { InsightsPanel } from "../../extensions/token-stats/web/TokenInsights";
import { statsInsights } from "../../extensions/token-stats/web/statsInsights";
import { OverTimeCard } from "../../extensions/token-stats/web/OverTimeCard";
import { TotalsCard } from "../../extensions/token-stats/web/TotalsCard";
import { WeekCard } from "../../extensions/token-stats/web/WeekCard";
import { docFor } from "../../extensions/token-stats/web/weekBands";
import {
  clockOf, daysCut, dayKeyOf, hoursCover, isLiveSpan, spanDayCount, spanDays, spanHours, spanRange, SPANS, type SpanId,
} from "../../extensions/token-stats/web/span";
import { TREND_DAYS } from "../../extensions/token-stats/web/constants";
import type { CorpusDoc } from "../src/protocol";
import { Absent } from "./Absent";
import { pricedOrNull } from "./Money";

/** The span filter's chips here: the calendar spans only — no limit window is read on this side. */
const CAL_SPANS = SPANS.filter((x) => !isLiveSpan(x.id));
/** No past limit windows here: `TotalsCard` draws no grid, and no heading over one. */
const NO_GRIDS = new Map();

export function OverviewView({ doc, why, scanning }: {
  doc: CorpusDoc | null;
  why?: string;
  scanning?: { done: number; total: number };
}) {
  const progress = scanning
    ? <div className="empty ctx-note" role="status">Reading logs: {fmtCount(scanning.done)} of {fmtCount(scanning.total)}…</div>
    : null;
  if (!doc) return <>{progress}<Absent>{why ?? "No Claude Code logs have been read on this machine yet."}</Absent></>;
  return <>{progress}<OverviewBody doc={doc} /></>;
}

function OverviewBody({ doc }: { doc: CorpusDoc }) {
  const [width, boxRef] = useBoxWidth();
  // Money is offered only when something was priced: a "$0" hero reads as free.
  const canMoney = pricedOrNull(doc.cost) != null;
  const [metric, setMetric] = useState<"tokens" | "cost">("tokens");
  const money = canMoney && metric === "cost";
  const [table, setTable] = useState(false);
  /** The ONE span every box under the sticky bar follows; not persisted, like the phone's. */
  const [spanId, setSpanId] = useState<SpanId>("30");
  const [dayView, setDayView] = useState<"total" | "mix" | "share">("total");
  const [mixBy, setMixBy] = useState<"kind" | "model">("kind");
  const [dayShape, setDayShape] = useState<"bars" | "area">("bars");
  const [hourShape, setHourShape] = useState<"bars" | "area">("bars");

  const valueOf = useMemo(
    () => (t: TokenTotals & { cost?: CostBreakdown }) => (money ? (t.cost?.total ?? 0) : tokenTotal(t)),
    [money],
  );
  // The span is cut against the SCAN's instant, the one the corpus folded `spans` at, so the
  // calendar edges here and the fold's `from` are one midnight.
  const now = doc.scannedAt;
  const range = useMemo(() => spanRange({ id: spanId, back: 0 }, null, now), [spanId, now]);
  const calDays = spanDayCount(spanId);
  const days = useMemo(() => spanDays(doc.days, range), [doc.days, range]);
  const dcut = useMemo(() => (calDays != null ? daysCut(days, doc.models) : null), [calDays, days, doc.models]);

  const daily: DayPoint[] = useMemo(() => days.map((d) => ({ day: d.day, t: dayToMs(d.day), v: valueOf(d) })), [days, valueOf]);
  // The running total starts at the span's own zero.
  const running: DayPoint[] = useMemo(
    () => cumulative(daily.map((d) => ({ day: d.day, total: d.v }))).map((d) => ({ day: d.day, t: dayToMs(d.day), v: d.sum })),
    [daily],
  );
  // The mean over the WHOLE series, clipped afterwards.
  const trend = useMemo(() => {
    if (!daily.length) return [];
    const mean = rollingMean(doc.days.map((d) => ({ day: d.day, t: dayToMs(d.day), v: valueOf(d) })), TREND_DAYS);
    const lo = daily[0].t, hi = daily[daily.length - 1].t;
    return mean.filter((m) => m.t >= lo && m.t <= hi);
  }, [doc.days, valueOf, daily]);
  const mixRows = useMemo(() => days.map((d) => ({ t: dayToMs(d.day), day: d.day, totals: d as TokenTotals, src: d })), [days]);
  const bands = useMemo(() => modelBands(doc.models), [doc.models]);
  const canModel = bands.bands.length + (bands.restSlot != null ? 1 : 0) > 1 && days.some((d) => (d.byModel?.length ?? 0) > 0);
  const agentDays = useMemo(() => days.reduce((n, d) => n + (d.agents ?? []).reduce((m, a) => m + a.count, 0), 0), [days]);
  const hourRows = useMemo(() => spanHours(doc.hours, range, hourToMs), [doc.hours, range]);
  const hoursWhole = hoursCover(doc.hoursFrom, range);
  const hoursFromWords = doc.hoursFrom != null
    ? new Date(doc.hoursFrom).toLocaleDateString(undefined, { day: "numeric", month: "short" })
    : null;
  const hourly: DayPoint[] = useMemo(() => hourPoints(hourRows, (h) => valueOf(h), hourToMs), [hourRows, valueOf]);
  const dailyFilled = useMemo(() => fillSeries(daily), [daily]);
  const mixFilled = useMemo(() => fillMix(mixRows, (t, day) => ({
    t, day, totals: zeroTotals(), src: { day, ...zeroTotals(), cost: zeroCost(), byModel: [], agents: [] },
  })), [mixRows]);
  const hourlyFilled = useMemo(() => fillSeries(hourly, HOUR_MS), [hourly]);
  const dayAreaOk = dayView === "total" ? !!dailyFilled : !!mixFilled;
  const dayArea = dayShape === "area" && dayAreaOk;
  const hourArea = hourShape === "area" && !!hourlyFilled;
  const insights = useMemo(() => statsInsights(doc, Date.now()), [doc]);
  const clockSlots = useMemo(() => (range && hoursWhole ? clockOf(hourRows) : null), [range, hoursWhole, hourRows]);

  // The span's repos and conversations: the corpus's own fold of it (`spans`), cost INSIDE the span.
  const spanDoc = calDays != null && range ? docFor(doc.spans?.[calDays], range.from) : null;
  const spanRepos = useMemo(() => (spanDoc ? rankRepos(spanDoc.convos, spanDoc.rest).map(repoRowAsGroup) : null), [spanDoc]);

  const grand = tokenTotal(doc.totals);
  if (!grand) return <Absent>No tokens in this machine’s Claude Code logs yet — nothing to count.</Absent>;

  const fmtDay = (d?: string) => d ? new Date(dayToMs(d)).toLocaleDateString(undefined, { day: "numeric", month: "short" }) : "";
  const scopeWords = calDays != null ? `the last ${calDays} days` : "all time";
  const dayEdges = days.length ? `${fmtDay(days[0]?.day)} – ${fmtDay(days[days.length - 1]?.day)}` : "";
  const rangeCaption = !days.length
    ? "No days in this span."
    : calDays != null && range
      ? `The last ${calDays} calendar days, ${new Date(range.from).toLocaleDateString(undefined, { day: "numeric", month: "short" })} – today.`
      : `Every day on record, ${dayEdges}.`;
  const hourNote = range && !hoursWhole && hoursFromWords
    ? `Hourly detail is kept from ${hoursFromWords} on, so the hours here start there rather than at the start of the span.`
    : !range && hoursFromWords
      ? `Hourly detail is kept from ${hoursFromWords} on; everything before that is in the day charts only.`
      : null;
  const hourWords = hourNote && hoursFromWords ? `${scopeWords}, from ${hoursFromWords}` : scopeWords;
  const clock = clockSlots
    ? { slots: clockSlots, tag: scopeWords }
    : {
      slots: doc.hourOfDay, tag: "all time",
      note: range ? `The hour record starts ${hoursFromWords ?? "later than this span"}, so this clock counts every hour on record rather than ${scopeWords}.` : undefined,
    };
  // An unpriced conversation has no dollar figure; the list prints money, so it is left out.
  const priced = (rows: readonly TokenConvo[]) => rows.filter((c) => c.cost.total > 0);
  const top: { rows: TokenConvo[]; total: number; tag: string; note?: string } = !range
    ? { rows: priced(doc.top), total: doc.cost.total, tag: "all time · in money" }
    : spanDoc
      ? { rows: priced([...spanDoc.convos].sort((x, y) => y.cost.total - x.cost.total)), total: spanDoc.cost.total, tag: `${scopeWords} · in money · cost inside the span` }
      : { rows: [], total: 0, tag: `${scopeWords} · in money`, note: "This span was not folded by the last scan — re-read the logs." };
  const unpricedTok = tokenTotal(doc.unpriced);
  const weekFrom = new Date(doc.week.fromHour).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
  const weekCaption = `The headline’s seven days, ${weekFrom} 00:00 to the last scan — calendar days, not your weekly limit’s window: this panel reads no reset instant.`;

  return (
    <div className="ts-list">
      <div className="ctx-chart-title">All sessions</div>
      {/* ── NOW: no switch below reaches these — the phone's limit bars and week chart. */}
      <Headline doc={doc} now={doc.scannedAt} />
      {/* Absent when nothing ran: the headline above already says so, in the same span. */}
      {tokenTotal(doc.week.totals) > 0 && (
        <WeekCard doc={doc.week} res={{ state: "fresh" }} openedAt={doc.week.fromHour} samples={[]} everyMs={0} cal={null} compact
          span={{ caption: weekCaption, tag: "last 7 days" }} />
      )}

      {/* ── The span filter, pinned: it reaches EVERYTHING below. */}
      <div className="ts-global">
        <div className="ts-filter" role="group" aria-label="span">
          {CAL_SPANS.map((x) => (
            <button key={x.id} type="button" className={`key${spanId === x.id ? " active" : ""}`} aria-pressed={spanId === x.id}
              onClick={() => setSpanId(x.id)}>{x.label}</button>
          ))}
        </div>
        <div className="ts-filter" role="group" aria-label="count in">
          {canMoney && <>
            <span className="ctx-stackpick-lab">count in</span>
            <button type="button" className={`key${!money ? " active" : ""}`} aria-pressed={!money} onClick={() => setMetric("tokens")}>tokens</button>
            <button type="button" className={`key${money ? " active" : ""}`} aria-pressed={money} onClick={() => setMetric("cost")}>cost</button>
            <span className="ts-seg-sep" aria-hidden="true" />
          </>}
          <span className="ctx-stackpick-lab">show as</span>
          <button type="button" className={`key${!table ? " active" : ""}`} aria-pressed={!table} onClick={() => setTable(false)}>chart</button>
          <button type="button" className={`key${table ? " active" : ""}`} aria-pressed={table} onClick={() => setTable(true)}>values</button>
        </div>
      </div>
      {!canMoney && (
        <div className="empty ts-caveat">
          {unpricedTok > 0
            ? `${fmtCount(unpricedTok)} tokens ran on models with no published rate and nothing else could be priced, so every figure here is in tokens.`
            : "Nothing could be priced, so every figure here is in tokens."}
        </div>
      )}

      <InsightsPanel items={insights} />

      <TotalsCard doc={doc} money={money} table={table} active={null}
        dcut={dcut && calDays != null ? { cut: dcut, calendarDays: calDays, caption: rangeCaption } : null}
        scope={null} setScope={() => {}} grids={NO_GRIDS} hist={{ state: "fresh" }}
        shownTotals={dcut ? dcut.totals : doc.totals} shownCost={dcut ? dcut.cost : doc.cost}
        shownTok={tokenTotal(dcut ? dcut.totals : doc.totals)} coldNote={coldStartText(doc.coldStarts, "corpus")}
        scopeWords={scopeWords} bands={bands} canModel={canModel} days={days}
        scopeRepos={spanRepos} scopeRes={{ state: spanDoc ? "fresh" : "error", error: "not folded by the last scan" }}
        top={top} />

      <OverTimeCard doc={doc} money={money} table={table} dayCharts narrow={days.length <= 14}
        rangeCaption={rangeCaption} rangeWords={scopeWords} clock={clock} hourNote={hourNote}
        reqSpan={range ? { from: dayKeyOf(range.from), to: dayKeyOf(Math.max(range.from, range.to - 1)) } : null}
        boxRef={boxRef} width={width}
        running={running} dayView={dayView} setDayView={setDayView} canModel={canModel} mixBy={mixBy}
        setMixBy={setMixBy} dayArea={dayArea} setDayShape={setDayShape} dayAreaOk={dayAreaOk}
        dailyFilled={dailyFilled} daily={daily} trend={trend} mixFilled={mixFilled} mixRows={mixRows}
        bands={bands} days={days} agentDays={agentDays} hourWords={hourWords} hourRows={hourRows}
        hourArea={hourArea} setHourShape={setHourShape} hourlyFilled={hourlyFilled} hourly={hourly} />

      <div className="empty ts-foot">
        Scanned {doc.logs.toLocaleString()} conversation logs{doc.reread ? `, ${doc.reread.toLocaleString()} re-read` : ""} at {new Date(doc.scannedAt).toLocaleTimeString()}.
        {" "}Counts every log currently on this machine, including {doc.subagentLogs.toLocaleString()} subagent transcripts — a conversation deleted from the archive stops counting.
      </div>
    </div>
  );
}
