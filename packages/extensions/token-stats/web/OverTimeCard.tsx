/** The Over time box and the clock face under it, hook-free: every value is a render value of TokenStatsBody. */
import { type ComponentProps, type ReactNode } from "react";
import { fmtCount, type TokenStatsDoc } from "@waterplane/shared";
import { ScopeCard, ScopeTag } from "./TokenInsights.tsx";
import { PerRequestSection } from "./PerRequestSection.tsx";
import { type DayPoint, HOUR_MS, modelBands, weekBounds, type WeekDay, weekTotals } from "@waterplane/kit";
import { type RangeId, RANGES, TREND_DAYS } from "./constants.ts";
import { ClockChart, ModelLegend } from "./charts/Bars.tsx";
import { AgentDayChart, DayChart } from "./charts/DayChart.tsx";
import { MixChart } from "./charts/MixChart.tsx";
import { WeekNav } from "./Readouts.tsx";
import { TableView } from "./TableView.tsx";

/**
 * The Over time box: the calendar chips, the week stepper, the day, hour and
 * subagent charts, the table twin of them, and the clock face under it. Hook-free
 * for the same reason as `TotalsCard`; `boxRef` is the body's one width probe and
 * goes onto the same element it always did.
 */
export function OverTimeCard({ doc, money, table, range, setRange, rangeCaption, rangeWords, week, bounds, setWeekAt, wTotals, prevTotals, weekRows, boxRef, width, running, dayView, setDayView, canModel, mixBy, setMixBy, dayArea, setDayShape, dayAreaOk, dailyFilled, daily, trend, mixFilled, mixRows, bands, days, agentDays, hourWords, hourRows, hourArea, setHourShape, hourlyFilled, hourly }: {
  doc: TokenStatsDoc;
  money: boolean;
  table: boolean;
  range: RangeId;
  setRange: (r: RangeId) => void;
  rangeCaption: ReactNode;
  rangeWords: string;
  week: number;
  bounds: ReturnType<typeof weekBounds>;
  setWeekAt: (w: number | null) => void;
  wTotals: ReturnType<typeof weekTotals>;
  prevTotals: TokenStatsDoc["totals"];
  weekRows: WeekDay[];
  boxRef: (el: HTMLDivElement | null) => void;
  width: number;
  running: DayPoint[];
  dayView: "total" | "mix" | "share";
  setDayView: (v: "total" | "mix" | "share") => void;
  canModel: boolean;
  mixBy: "kind" | "model";
  setMixBy: (v: "kind" | "model") => void;
  dayArea: boolean;
  setDayShape: (v: "bars" | "area") => void;
  dayAreaOk: boolean;
  dailyFilled: DayPoint[] | null;
  daily: DayPoint[];
  trend: NonNullable<ComponentProps<typeof DayChart>["trend"]>;
  mixFilled: ComponentProps<typeof MixChart>["rows"] | null;
  mixRows: ComponentProps<typeof MixChart>["rows"];
  bands: ReturnType<typeof modelBands>;
  days: TokenStatsDoc["days"];
  agentDays: number;
  hourWords: string;
  hourRows: TokenStatsDoc["hours"];
  hourArea: boolean;
  setHourShape: (v: "bars" | "area") => void;
  hourlyFilled: DayPoint[] | null;
  hourly: DayPoint[];
}) {
  return (
    <>

      {/* ── OVER TIME: one box, its calendar window in its own head ──── */}
      <ScopeCard title="Over time"
        chips={RANGES.map((r) => (
          <button key={r.id} className={`key${range === r.id ? " active" : ""}`}
            onClick={() => setRange(r.id)}>{r.label}</button>
        ))}
        caption={<>{rangeCaption} Everything in this box follows these chips.</>}>
        {range === "week" && (
          <WeekNav week={week} bounds={bounds} onGo={setWeekAt}
            totals={wTotals} prev={prevTotals} rows={weekRows} />
        )}
        {!table ? <>
        <div className="section section-head">
          <span>Cumulative <ScopeTag>{rangeWords}</ScopeTag></span>
        </div>
        <div className="ctx-box" ref={boxRef}>
          {width > 0 && <DayChart pts={running} width={width} kind="area" slots={range === "week"} money={money} />}
        </div>

        <div className="section section-head">
          <span>Per day <ScopeTag>{rangeWords}</ScopeTag></span>
          {/* Three questions of the same days. The chips sit ON the section
              they scope, not in the filter row above, which scopes the
              WINDOW — two different decisions must not share a control. */}
          <span className="ts-seg-chips">
            {([["total", "total"], ["mix", "mix"], ["share", "share"]] as const).map(([id, label]) => (
              <button key={id} className={`key${dayView === id ? " active" : ""}`}
                onClick={() => setDayView(id)}>{label}</button>
            ))}
            {/* The FORM, separated from the question. The area chip is
                absent, not dimmed, when the window is too wide to fill —
                the rule `Unavailable.tsx` states, and the sentence under
                the chart carries the reason. */}
            {/* WHAT the stack is split by, beside the question it
                belongs to and absent from the one it does not: in
                `total` there is no stack. Absent, never dimmed, when
                the corpus holds one model — a stack of one band is the
                flat fill wearing a legend. */}
            {dayView !== "total" && canModel && <>
              <span className="ts-seg-sep" aria-hidden="true" />
              <button className={`key${mixBy === "kind" ? " active" : ""}`}
                onClick={() => setMixBy("kind")}
                title="what the traffic was made of — input, output, cache read, cache write">kind</button>
              <button className={`key${mixBy === "model" ? " active" : ""}`}
                onClick={() => setMixBy("model")}
                title="which model carried it — the one split a migration is visible in">model</button>
            </>}
            <span className="ts-seg-sep" aria-hidden="true" />
            <button className={`key${!dayArea ? " active" : ""}`}
              onClick={() => setDayShape("bars")}
              title="one mark per bucket — exact, and right while a column still has a width">bars</button>
            {dayAreaOk && (
              <button className={`key${dayArea ? " active" : ""}`}
                onClick={() => setDayShape("area")}
                title="the same numbers as a filled band — readable at a width where a column is a hairline">area</button>
            )}
          </span>
        </div>
        <div className="ctx-box">
          {width > 0 && (dayView === "total"
            ? <DayChart pts={dayArea && dailyFilled ? dailyFilled : daily} width={width}
                kind={dayArea ? "area" : "columns"} money={money} trend={trend}
                label={money ? "spend per day" : "tokens per day"}
                slots={range === "week"} maxColW={range === "week" ? 30 : undefined} />
            : <MixChart rows={dayArea && mixFilled ? mixFilled : mixRows} width={width}
                normalize={dayView === "share"} shape={dayArea ? "area" : "bars"}
                by={canModel ? mixBy : "kind"} bands={bands}
                slots={range === "week"} maxColW={range === "week" ? 30 : undefined} />)}
        </div>
        {/* Three things stay on the page. One is a LEGEND for a mark on
            the chart; the other two explain something that is NOT there
            — a mean that is absent and a form chip that is not offered —
            which is the `Unavailable.tsx` rule and never folds. The
            reading guides under them are method. */}
        {dayView === "total" && (trend.length > 0
          ? <div className="empty ts-caveat">Dashed line: {TREND_DAYS}-day mean over calendar days.</div>
          : <div className="empty ts-caveat">There is not yet {TREND_DAYS} days of record in this window, so the {TREND_DAYS}-day mean is absent rather than approximated.</div>)}
        {!dayArea && !dayAreaOk && (
          <div className="empty ts-caveat">
            This window is too wide to fill in its quiet days one by one, so it is drawn as
            columns only — an area over an unfilled series slopes smoothly across a fortnight
            off, as if the work had merely tapered.
          </div>
        )}
        <details className="hint-more ctx-method">
          <summary>how to read this chart</summary>
          <p>
          {dayView === "total" ? <>
            The <b>{TREND_DAYS}-day mean</b> is over calendar days — a quiet day
            counts as a zero, which is what makes two stretches comparable across a holiday. It
            starts {TREND_DAYS} days into the record, because a partial window divided by a full
            one draws a ramp that is an artefact of the left edge and not a trend.
          </> : dayView === "share" ? (mixBy === "model" && canModel ? <>
            Every column rescaled to 100%: this says which MODEL carried the work, not how much
            of it there was. It is the one chart a migration is visible in — moving from one
            model to another is a band crossing over, and in a total it is nothing at all. Read
            it beside the <b>cost</b> chips: the same crossing is worth 2.5× per token between
            opus and sonnet, and 5× against haiku.
          </> : <>
            Every column rescaled to 100%: this says what the MIX was, not how much. It is the
            one reading that can move while the total does not — cache writes climbing from 3% to
            12% is a week the session shape changed, and in the <b>cost</b> view that is the
            biggest lever there is (3% of the tokens, 38% of the money).
          </>) : (mixBy === "model" && canModel ? <>
            The same columns as <b>total</b>, split by the model that ran. At this scale one
            model is usually most of every column, which is the honest shape — switch to
            <b> share</b> to read the proportions, and nothing here is floor-inflated to make a
            band visible.
          </> : <>
            The same columns as <b>total</b>, split by kind. At this scale the three small kinds
            are slivers, which is the honest shape of a 96/3/0.2 split rather than a fault in the
            chart — switch to <b>share</b> to read the proportions, and nothing here is
            floor-inflated to make a band visible.
          </>)}
          {" "}
          {dayArea ? (dayView === "share" ? <>
            Drawn as <b>stacked areas</b>. A day with nothing in it has no mix to rescale, so it
            is <b>cut out of the band</b> rather than filled — the holes are days off, and the
            proportions either side of one are not joined across it.
          </> : <>
            Drawn as an <b>area</b>, over the days filled in: the scan reads every conversation
            log on this desktop, so a day missing from the record is a day with no turns in it —
            a measured zero, which the band sits on. That is what makes the shape safe to read
            as a slope rather than as a line between two marks.
          </>) : null}
          </p>
        </details>

        {/* ── what one request costs ──────────────────────────────────── */}
        {days.length > 0 && width > 0 && <>
          <div className="section section-head">
            <span>Cost per request <ScopeTag>{rangeWords}</ScopeTag></span>
          </div>
          <PerRequestSection doc={doc} from={days[0].day} to={days[days.length - 1].day} width={width} table={false} />
        </>}

        {/* ── how often the work fans out ─────────────────────────────── */}
        {agentDays > 0 && <>
          <div className="section section-head">
            <span>Subagents started <ScopeTag>{rangeWords}</ScopeTag></span>
          </div>
          <div className="ctx-box">
            {width > 0 && (
              <AgentDayChart rows={dayArea && mixFilled ? mixFilled : mixRows} width={width}
                bands={bands} slots={range === "week"}
                maxColW={range === "week" ? 30 : undefined} />
            )}
          </div>
          <ModelLegend bands={bands} />
          <div className="empty ts-caveat">
            {fmtCount(doc.subagentLogs)} subagent transcripts on disk; this counts those
            started in the window.
          </div>
          <details className="hint-more ctx-method">
            <summary>how these are counted</summary>
            <p>
              A count of <b>launches</b>, not of tokens — the spend is already in every chart
              above, and it cannot answer this one: a day that ran one agent for an hour and a
              day that ran twenty for three minutes each carry the same subagent total and were
              nothing alike. A log is dated by its <b>earliest</b> record and attributed to the
              model that ran in it, so a long agent is one bar on the day it began rather than
              smeared across the days it worked.
            </p>
          </details>
        </>}

        {/* ── intraday ────────────────────────────────────────────────── */}
        <div className="section section-head">
          <span>Per hour <ScopeTag>{hourWords}</ScopeTag></span>
          {hourRows.length > 1 && (
            <span className="ts-seg-chips">
              <button className={`key${!hourArea ? " active" : ""}`}
                onClick={() => setHourShape("bars")}>bars</button>
              {!!hourlyFilled && (
                <button className={`key${hourArea ? " active" : ""}`}
                  onClick={() => setHourShape("area")}>area</button>
              )}
            </span>
          )}
        </div>
        {hourRows.length > 1 ? <>
          <div className="ctx-box">
            {width > 0 && <DayChart pts={hourArea && hourlyFilled ? hourlyFilled : hourly} width={width}
              kind={hourArea ? "area" : "columns"} money={money}
              label={money ? "spend per hour" : "tokens per hour"}
              stepMs={HOUR_MS} maxColW={10} />}
          </div>
          {/* Both of these are facts about what is NOT on the chart —
              how far back it reaches at all, and that the window chips
              do not move it. The bucketing under them is method. */}
          <div className="empty ts-caveat">
            {doc.hoursFrom != null && <>Hourly detail is kept from {new Date(doc.hoursFrom).toLocaleDateString(undefined, { day: "numeric", month: "short" })} onward; everything before that is in the day charts only. </>}
          </div>
          <details className="hint-more ctx-method">
            <summary>how the hours are bucketed</summary>
            <p>
              {hourArea
                ? <>Every hour in the window, in this desktop’s local time — the same buckets the
                  days are a fold of, so the two can never disagree. An hour with no turn in it is
                  drawn as the zero it was, so a night off is a floor under the band rather than a
                  line joined across it.</>
                : <>One column per hour that had a turn in it, in this desktop’s local time — the
                  same buckets the days are a fold of, so the two can never disagree. The empty
                  hours between the columns are axis, which is what the <b>area</b> form has to
                  fill in before it may join anything.</>}
            </p>
          </details>
        </> : (
          <div className="empty">
            {(doc.hours?.length ?? 0) === 0
              ? "No hourly detail yet — the host records it from the next scan of the conversation logs onward."
              : "Nothing in this week at hourly resolution."}
          </div>
        )}

        </> : <>
          <TableView doc={doc} days={days} part="days" />
          {days.length > 0 && <>
            <div className="section section-head">
              <span>Cost per request <ScopeTag>{rangeWords}</ScopeTag></span>
            </div>
            <PerRequestSection doc={doc} from={days[0].day} to={days[days.length - 1].day} width={width} table />
          </>}
        </>}
      </ScopeCard>

        <div className="section section-head">
          <span>Time of day <ScopeTag muted>all time · no filter</ScopeTag></span>
        </div>
        <div className="ctx-box">
          {width > 0 && <ClockChart slots={doc.hourOfDay} width={width} money={money} />}
        </div>
        <details className="hint-more ctx-method">
          <summary>how to read the clock</summary>
          <p>
            Every hour on record folded onto one clock face, so this is a position rather than a
            date — hour 23 sits beside hour 0 of the next day in the chart above, and beside hour
            22 here. The empty slots are drawn: an hour nobody has ever worked is a reading.
          </p>
        </details>
    </>
  );
}
