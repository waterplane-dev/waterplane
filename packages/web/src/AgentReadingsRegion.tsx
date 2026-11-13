/**
 * Region 5 of the repo-readings sheet, **Agent readings**: what only this
 * desktop's claude conversation logs can say about a repo, one ISO week at a
 * time (host `agentreadings.ts`, `GET /api/repos/:id/agentreadings`).
 *
 * Readings, not the health score and not a checklist: no stripe, no status
 * colour, counted in nothing, and nothing here refuses or applies anything.
 * Each reading carries a `?` whose words are the HOST's rule (`doc.rules`), so
 * the explanation can never drift from the classification that produced the
 * number. A total never stands without its split: the rework share names all
 * three classes and draws the token kinds under it; exploration cost draws the
 * median session's own kinds. An absent reading prints the host's sentence.
 *
 * The week is picked by tapping a bar: every reading is a weekly bar chart
 * (`AgentWeekBars.tsx`) over the same columns, so the bars ARE the week picker
 * and a tap on any chart moves all of them. Each chart answers the picked week
 * in a text line under it; a week not taken is an outline, never a zero bar,
 * and the line quotes the host's sentence. The weeks table is the same figures
 * as text, every week at once.
 *
 * Start context, Before the first edit (tokens AND look calls, one set of
 * sessions) and Requests per committing session lead: they are the agent
 * series' weekly buckets (shared `seriesOf`), the same function the token-stats
 * over-time card reads, over the same sessions. The region POOLS every model (the
 * rules say so) while the card takes one model at a time, so on a repo that
 * changed model the two differ by design. Start figures are MEASURED
 * off the logs and never mixed with the skills screen's estimated weights.
 * Each is an absent FIELD on an older host, and then no card.
 *
 * Spend comes off the token ledger's per-repo rows (the token-stats screen's
 * By repo), activity off the same logs as rework: both absent FIELDS on an
 * older host, and then no card.
 */
import { useEffect, useState } from "react";
import { fmtCount, fmtUsdShort, isAgentAbsent, tokenTotal, type AgentReadingAbsent, type AgentReadingsResponse, type AgentReadingsWeek, type RepoTarget, type SeriesMedian } from "@waterplane/shared";
import { api } from "./api";
import { useRemoteResource } from "./useRemoteResource";
import { Empty } from "./Empty";
import { Explain } from "./Explain";
import { KindBar } from "./kit/chart/TokenComposition";
import { RefreshKey } from "./RepoHealthCards";
import { AgentWeekBars } from "./AgentWeekBars";
import {
  AGENT_REGION_WORDS, CARRIED_TITLE, PICK_HINT, START_PARTS_CAP, TABLE_NOTE, compactBeside, compactLine, escapedLines, exploreBeside, exploreLine,
  escapedFigure, figures, fmtMedian, looksLine, readout, requestsLine, reworkBeside, reworkLine, reworkWhole, spendBeside, startLine, startPartLines, startSubLine,
  weekCells, weekHeading,
} from "./agentReadingsWords";

type Bars = Omit<React.ComponentProps<typeof AgentWeekBars>, "weeks" | "picked" | "onPick" | "label"> & { line: string };

function Reading({ title, rule, bars, pick, children }: {
  title: string; rule: string; bars: Bars;
  pick: { weeks: string[]; i: number; set: (i: number) => void };
  children?: React.ReactNode;
}) {
  const { line, ...chart } = bars;
  return (
    <div className="rh-card">
      <div className="section-head">
        <span className="rh-chart-label">{title}</span>
        <Explain of={title}>{rule}</Explain>
      </div>
      <div className="rh-gutter">
        <AgentWeekBars {...chart} weeks={pick.weeks} picked={pick.i} onPick={pick.set} label={title} />
        <div className="rh-scrub">{line}</div>
        {children}
      </div>
    </div>
  );
}

/** One chart's column values and its text answer for the picked week. */
function series<R>(weeks: readonly AgentReadingsWeek[], at: number, newest: string | undefined,
  get: (w: AgentReadingsWeek) => R | AgentReadingAbsent | undefined, parts: (r: R) => number[], figure: (r: R) => string) {
  const values = weeks.map((w) => { const r = get(w); return r === undefined || isAgentAbsent(r) ? null : parts(r as R); });
  const w = weeks[at]!;
  const r = get(w);
  const line = r === undefined ? readout(w.week, w.week === newest, null, "not read by this desktop's host version")
    : isAgentAbsent(r) ? readout(w.week, w.week === newest, null, r.absent) : readout(w.week, w.week === newest, figure(r as R));
  return { values, line };
}

export function AgentReadingsRegion({ repo, carried }: {
  repo: RepoTarget | null;
  /** The always-on list (`AlwaysOnRows`, off the setup checklist's report): what every turn here
   *  carries before an agent spends anything. Its threshold stays on the set-up row. */
  carried?: React.ReactNode;
}) {
  const repoId = repo?.id ?? "";
  const res = useRemoteResource<AgentReadingsResponse>(`agentreadings:${repoId}`, () => api.agentReadings(repoId), { enabled: !!repoId });
  const doc = res.data?.ok ? res.data : null;
  const refused = res.data && !res.data.ok ? res.data : null;
  const weeks = doc?.weeks ?? [];
  const [pick, setPick] = useState<string | null>(null);
  // A new repo (or a new answer that no longer holds the picked week) lands on the newest week.
  useEffect(() => { setPick(null); }, [repoId]);
  const week = weeks.find((w) => w.week === pick) ?? weeks[weeks.length - 1] ?? null;
  const newest = weeks[weeks.length - 1]?.week;
  const at = week ? weeks.indexOf(week) : -1;
  const pk = { weeks: weeks.map((w) => w.week), i: at, set: (i: number) => setPick(weeks[i]?.week ?? null) };
  // An older host sends neither field: no card, rather than a chart of outlines.
  const hasSpend = weeks.some((w) => w.spend !== undefined);
  const hasActivity = weeks.some((w) => w.activity !== undefined);
  const hasStart = weeks.some((w) => w.start !== undefined);
  const hasLooks = weeks.some((w) => !isAgentAbsent(w.explore) && w.explore.looks !== undefined);
  const hasRequests = weeks.some((w) => w.requests !== undefined);
  const medTick = (v: number) => fmtMedian(Math.round(v * 10) / 10);

  return (
    <div className="rh-region">
      <div className="ts-filter" role="group" aria-label="agent readings">
        <span className="ctx-stackpick-lab">agents</span>
        <Explain of="what agent readings are">{AGENT_REGION_WORDS}</Explain>
        <RefreshKey busy={res.inflight} label={res.inflight ? "reading…" : "read again"} onClick={() => res.reload({ quiet: true })} />
      </div>
      {carried ? (
        <div className="rh-card">
          <div className="section-head"><span className="rh-chart-label">{CARRIED_TITLE}</span></div>
          <div className="rh-gutter">{carried}</div>
        </div>
      ) : null}
      <Empty res={res} empty={!doc} thing="this repo's agent readings" noun="reading">
        {refused ? <>{refused.error}</> : null}
      </Empty>
      {doc && week ? (<>
        <div className="rh-cap rh-gutter">{weekHeading(week.week, week.week === newest)} · {PICK_HINT}</div>

        {hasStart ? (
          <Reading title="Start context" rule={doc.rules.start ?? ""} pick={pk}
            bars={{ ...series<SeriesMedian>(weeks, at, newest,
              (w) => (w.start === undefined || isAgentAbsent(w.start) ? w.start : w.start.tok), (r) => [r.median], startLine), fmtTick: fmtCount }}>
            {week.start && !isAgentAbsent(week.start) ? (<>
              {week.start.parts.length ? (<>
                <div className="rh-cap">{START_PARTS_CAP}</div>
                {startPartLines(week.start).map((l) => <div key={l}>{l}</div>)}
              </>) : null}
              <div className="rh-cap">{startSubLine(week.start)}</div>
            </>) : null}
          </Reading>
        ) : null}

        <Reading title="Before the first edit" rule={doc.rules.explore} pick={pk}
          bars={{ ...series(weeks, at, newest, (w) => w.explore, (r) => [r.medianTok], (r) => exploreLine(r)), fmtTick: fmtCount }}>
          {isAgentAbsent(week.explore) ? null : <KindBar bag={week.explore.split} whole={tokenTotal(week.explore.split)} />}
          {hasLooks ? (() => {
            // Same sessions as the token bars; a week the token line already explained reads as
            // an outline here, and its line repeats nothing (the sentence is just above).
            const looks = series<SeriesMedian>(weeks, at, newest,
              (w) => (isAgentAbsent(w.explore) ? w.explore : w.explore.looks), (r) => [r.median], looksLine);
            return (<>
              <AgentWeekBars values={looks.values} weeks={pk.weeks} picked={pk.i} onPick={pk.set} label="look calls before the first edit" fmtTick={medTick} />
              {isAgentAbsent(week.explore) ? null : <div className="rh-scrub">{looks.line}</div>}
            </>);
          })() : null}
          {isAgentAbsent(week.explore) ? null : <div className="rh-cap">{exploreBeside(week.explore)}</div>}
        </Reading>

        {hasRequests ? (
          <Reading title="Requests per committing session" rule={doc.rules.requests ?? ""} pick={pk}
            bars={{ ...series<SeriesMedian>(weeks, at, newest, (w) => w.requests, (r) => [r.median], requestsLine), fmtTick: medTick }} />
        ) : null}

        {hasSpend ? (
          <Reading title="Spend" rule={doc.rules.spend ?? ""} pick={pk}
            bars={{ ...series(weeks, at, newest, (w) => w.spend, (r) => [r.usd], figures.spend), fmtTick: fmtUsdShort }}>
            {week.spend && !isAgentAbsent(week.spend) ? <div className="rh-cap">{spendBeside(week.spend)}</div> : null}
          </Reading>
        ) : null}

        {hasActivity ? (
          <Reading title="Who did the work" rule={doc.rules.activity ?? ""} pick={pk}
            bars={{ ...series(weeks, at, newest, (w) => w.activity, (r) => [r.mainTok, r.agentTok], figures.activity),
              fmtTick: fmtCount, parts: ["conversations' own", "subagents"] }}>
          </Reading>
        ) : null}

        <Reading title="Rework spend" rule={doc.rules.rework} pick={pk}
          bars={{ ...series(weeks, at, newest, (w) => w.rework,
            (r) => [tokenTotal(r.byClass.rework), tokenTotal(r.byClass.feature), tokenTotal(r.byClass.unknown)], (r) => reworkLine(r)),
            fmtTick: fmtCount, parts: ["rework", "feature", "unknown"] }}>
          {isAgentAbsent(week.rework) ? null : (<>
            <KindBar bag={reworkWhole(week.rework)} whole={week.rework.totalTok} />
            <div className="rh-cap">{reworkBeside(week.rework)}</div>
          </>)}
        </Reading>

        <Reading title="Compactions per committed session" rule={doc.rules.compact} pick={pk}
          bars={{ ...series(weeks, at, newest, (w) => w.compact, (r) => [r.compactions / r.committed], (r) => compactLine(r)),
            fmtTick: (v) => v.toFixed(v < 10 ? 1 : 0) }}>
          {isAgentAbsent(week.compact) ? null : <div className="rh-cap">{compactBeside(week.compact)}</div>}
        </Reading>

        <Reading title="Escaped defects" rule={doc.rules.escaped} pick={pk}
          bars={{ values: weeks.map((w) => {
              const c = isAgentAbsent(w.escaped.crashMarks) ? null : w.escaped.crashMarks;
              const b = isAgentAbsent(w.escaped.bugItems) ? null : w.escaped.bugItems;
              return c === null && b === null ? null : [c ?? 0, b ?? 0];
            }), line: readout(week.week, week.week === newest, escapedFigure(week.escaped)),
            fmtTick: (v) => String(Math.round(v)), parts: ["crash marks", "bugs on the backlog"] }}>
          {(() => { const e = escapedLines(week.escaped); return (<><div>{e.crash}</div><div>{e.bugs}</div></>); })()}
        </Reading>

        <div className="rh-card">
          <div className="section-head"><span className="rh-chart-label">every week, as numbers</span></div>
          <div className="rh-table-wrap rh-fade">
            <table className="rh-table">
              <thead>
                <tr>
                  <th scope="col">week of</th>
                  {hasSpend ? <th scope="col" className="num">spend</th> : null}
                  {hasActivity ? <th scope="col" className="num">convs</th> : null}
                  {hasStart ? <th scope="col" className="num">start</th> : null}
                  <th scope="col" className="num">before edit</th>
                  {hasLooks ? <th scope="col" className="num">looks</th> : null}
                  {hasRequests ? <th scope="col" className="num">requests</th> : null}
                  <th scope="col" className="num">rework</th>
                  <th scope="col" className="num">compact</th>
                  <th scope="col" className="num">crash</th>
                  <th scope="col" className="num">bugs</th>
                </tr>
              </thead>
              <tbody>
                {weeks.map((w) => {
                  const c = weekCells(w);
                  return (
                    <tr key={w.week}>
                      <th scope="row">{w.week}</th>
                      {hasSpend ? <td className="num">{c.spend}</td> : null}
                      {hasActivity ? <td className="num">{c.sessions}</td> : null}
                      {hasStart ? <td className="num">{c.start}</td> : null}
                      <td className="num">{c.explore}</td>
                      {hasLooks ? <td className="num">{c.looks}</td> : null}
                      {hasRequests ? <td className="num">{c.requests}</td> : null}
                      <td className="num">{c.rework}</td>
                      <td className="num">{c.compact}</td>
                      <td className="num">{c.crash}</td>
                      <td className="num">{c.bugs}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="rh-cap rh-gutter">{TABLE_NOTE}</div>
        </div>
      </>) : null}
    </div>
  );
}
