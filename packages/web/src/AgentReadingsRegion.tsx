/**
 * Region 5 of the repo-readings sheet, **Agent readings**: what only this
 * desktop's claude conversation logs can say about a repo, one ISO week at a
 * time (host `agentreadings.ts`, `GET /api/repos/:id/agentreadings`).
 *
 * Under the headline, `ProbeCard.tsx` (R-metrics-074): start a lookup probe and read its newest
 * result; then `SetupShareCard.tsx` (R-metrics-073): this desktop's setup block to export (its probe
 * slot filled from the newest non-void result), and a colleague's imported one side by side. The
 * probe's view and results are read here, so the headline's "last probe" line, the probe card and
 * the export block read one fetch and "read again" re-reads them too.
 *
 * It opens on the headline (`Headline`, R-metrics-070): the setup cost per median session at
 * list price with its tokens and its split by whose it is, the last probe, and one neutral pattern
 * sentence around the newest change (shared `setupCostOf` / `setupPatternOf`, over the same points
 * and markers the token-stats card reads). Under it, ONCE for the region, where every reading here
 * comes from (`agentSourceText`, R-metrics-069); each card repeats it only in its `?`.
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
import { useEffect, useMemo, useState } from "react";
import {
  BY_MODEL_DEFAULT_DAYS, SETUP_COST_DAYS, agentSourceText, compareByModelAll, fmtCount, fmtUsdShort, isAgentAbsent, priceListSource, priceSourceText, setupCostOf, setupPatternOf, setupPatternText, tokenTotal,
  type AgentMarkersResponse, type AgentPointsResponse, type ProbeResultsView, type ProbeView, type AgentReadingAbsent, type AgentReadingsResponse, type AgentReadingsWeek, type RepoTarget, type SeriesLoads, type SeriesMedian,
} from "@waterplane/shared";
import { api } from "./api";
import { useRemoteResource, type RemoteResource } from "./useRemoteResource";
import { Empty } from "./Empty";
import { Explain } from "./Explain";
import { KindBar } from "./kit/chart/TokenComposition";
import { RefreshKey } from "./RepoHealthCards";
import { AgentWeekBars } from "./AgentWeekBars";
import { SetupShareCard } from "./SetupShareCard";
import { ProbeCard } from "./ProbeCard";
import { FilterChip } from "./kit/FilterChip";
import { Button } from "./kit/Button";
import { Hint } from "./kit";
import { CalendarRange, FlaskConical, Gauge, Plug } from "lucide-react";
import { probeLastLine, probeResultsUnreadLine, probeShareOf } from "./probeWords";
import {
  AGENT_REGION_WORDS, AGENT_VIEW_HELP, AGENT_VIEW_LABEL, byModelRow, CARRIED_TITLE, HEADLINE_TITLE, PROBE_NONE, headlineHelp, setupCostBeside, setupCostFigure, setupCostLine, setupSplitLine, PICK_HINT, START_PARTS_CAP, TABLE_NOTE, compactBeside, compactLine, escapedLines, exploreBeside, exploreLine,
  escapedFigure, figures, fmtMedian, looksLine, readout, requestsLine, skillsLine, reworkBeside, reworkLine, reworkWhole, spendBeside, startLine, startPartGroups, startSubLine, fmtMean,
  weekCells, weekHeading,
} from "./agentReadingsWords";

type Bars = Omit<React.ComponentProps<typeof AgentWeekBars>, "weeks" | "picked" | "onPick" | "label"> & { line: string };

function Reading({ title, rule, bars, pick, children, chartTitle }: {
  title: string; rule: string; bars: Bars;
  /** A headline over the chart, for a card that draws more than one. */
  chartTitle?: string;
  pick: { weeks: string[]; i: number; set: (i: number) => void };
  children?: React.ReactNode;
}) {
  const { line, ...chart } = bars;
  return (
    <div className="rh-card">
      <div className="section-head">
        <span className="rh-chart-label">{title}</span>
        <Explain of={title}>{rule} {agentSourceText()}</Explain>
      </div>
      <div className="rh-gutter">
        {chartTitle ? <div className="ar-chart-title">{chartTitle}</div> : null}
        <AgentWeekBars {...chart} weeks={pick.weeks} picked={pick.i} onPick={pick.set} label={title} />
        <div className="rh-scrub">{line}</div>
        {children}
      </div>
    </div>
  );
}

/**
 * The region's headline (R-metrics-070): what the setup costs a median session, in dollars at list
 * price with the tokens beside it and its split by whose it is; the last probe (none yet); one
 * pattern sentence around the newest change. Then, ONCE for the whole region, where every reading
 * here comes from (R-metrics-069) — each card says it again only in its `?`.
 */
function Headline({ pts, mk, probes }: { pts: RemoteResource<AgentPointsResponse>; mk: RemoteResource<AgentMarkersResponse>; probes: RemoteResource<ProbeResultsView> }) {
  const points = pts.data?.ok ? pts.data.points : null;
  const markers = mk.data?.ok ? mk.data.markers : null;
  const cost = useMemo(() => (points ? setupCostOf(points, { now: Date.now() }) : null), [points]);
  const pattern = useMemo(() => (points && markers ? setupPatternOf(points, markers) : null), [points, markers]);
  // Compare by model (R-metrics-072): one compact row, only when two models have enough sessions.
  const byModel = useMemo(() => (points ? byModelRow(compareByModelAll(points, { now: Date.now() }), BY_MODEL_DEFAULT_DAYS) : null), [points]);
  const source = agentSourceText();
  const lastProbe = probes.data?.ok ? probes.data.results[0] ?? null : null;
  // A rerun's two sides are its baseline (before) and itself (now): the line names them, so it needs the baseline.
  const lastBase = lastProbe?.result.against && probes.data?.ok ? probes.data.results.find((x) => x.result.id === lastProbe.result.against)?.result ?? null : null;
  return (
    <div className="rh-card">
      <div className="section-head">
        <span className="rh-chart-label">{HEADLINE_TITLE}</span>
        <Explain of={HEADLINE_TITLE}>{headlineHelp(cost && !isAgentAbsent(cost) ? cost : null)}</Explain>
      </div>
      <div className="rh-gutter">
        {cost === null ? (
          <div className="rh-cap">{pts.data && !pts.data.ok ? `Sessions could not be read: ${pts.data.error}`
            : !pts.data && pts.state === "offline" ? "Sessions could not be read: the desktop is not reachable right now."
              : !pts.data && pts.state === "error" ? `Sessions could not be read${pts.error ? `: ${pts.error}` : "."}`
                : "Reading this repo's sessions…"}</div>
        ) : isAgentAbsent(cost) ? <div className="rh-cap">{cost.absent}</div> : (<>
          <div className="ar-headline">{setupCostFigure(cost)}</div>
          <div>{setupCostLine(cost)}</div>
          <div>{setupSplitLine(cost)}</div>
          <div className="rh-cap">{setupCostBeside(cost, SETUP_COST_DAYS, priceSourceText(priceListSource()))}</div>
        </>)}
        {lastProbe ? <div>{probeLastLine(lastProbe.result, lastProbe.analysis, lastBase)}</div>
          : cost === null ? null
            : probes.data?.ok ? <div className="rh-cap">{PROBE_NONE}</div>
              : <div className="rh-cap">Last probe: {probeResultsUnreadLine(probes.state === "loading" && !probes.data, probes.error)}</div>}
        {pattern ? <div>{isAgentAbsent(pattern) ? pattern.absent : setupPatternText(pattern)}</div>
          : mk.data && !mk.data.ok ? <div className="rh-cap">Changes could not be read: {mk.data.error}</div> : null}
        {byModel ? (<>
          <div>{byModel.line}</div>
          {byModel.notes.map((n) => <div key={n} className="rh-cap">{n}</div>)}
        </>) : null}
        {/* Once for the whole region, the same words everywhere (R-metrics-069). */}
        <div className="rh-cap">{source}</div>
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

/** The region's three views: what a session carries now, the weekly readings, and the
 *  costed tests (search test + compare setups). One chip row, `ContextSheet`'s grammar. */
export type AgentView = "now" | "weeks" | "tests";

export function AgentReadingsRegion({ repo, carried, onSkills, skillsCant }: {
  repo: RepoTarget | null;
  /** The always-on list (`AlwaysOnRows`, off the setup checklist's report): what every turn here
   *  carries before an agent spends anything. Its threshold stays on the set-up row. */
  carried?: React.ReactNode;
  /** The skills & plugins switch for this repo, at the top of the region whatever view is open. */
  onSkills?: () => void;
  skillsCant?: string;
}) {
  const [view, setView] = useState<AgentView>("now");
  const repoId = repo?.id ?? "";
  const res = useRemoteResource<AgentReadingsResponse>(`agentreadings:${repoId}`, () => api.agentReadings(repoId), { enabled: !!repoId });
  // The headline's points and markers: the same keys and fetchers as the token-stats Agent readings
  // over time card (one fetch serves both), held here so "read again" re-reads them too.
  const pts = useRemoteResource<AgentPointsResponse>(`agentpoints:${repoId}`, () => api.agentPoints(repoId), { enabled: !!repoId });
  const mk = useRemoteResource<AgentMarkersResponse>(`agentmarkers:${repoId}`, () => api.agentMarkers(repoId), { enabled: !!repoId });
  // The lookup probe (R-metrics-074): the status is never served from the cache (a stale "running" would mislead).
  const probeView = useRemoteResource<ProbeView>(`probe:${repoId}`, () => api.probeView(repoId), { enabled: !!repoId, cache: false });
  const probes = useRemoteResource<ProbeResultsView>(`proberesults:${repoId}`, () => api.probeResults(repoId), { enabled: !!repoId });
  const shareProbe = useMemo(() => (probes.data?.ok ? probeShareOf(probes.data.results) : null), [probes.data]);
  const busy = res.inflight || pts.inflight || mk.inflight || probeView.inflight || probes.inflight;
  const readAgain = () => { res.reload({ quiet: true }); pts.reload({ quiet: true }); mk.reload({ quiet: true }); probeView.reload({ quiet: true }); probes.reload({ quiet: true }); };
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
  const hasSkills = weeks.some((w) => w.skillLoads !== undefined);
  const medTick = (v: number) => fmtMedian(Math.round(v * 10) / 10);

  return (
    <div className="rh-region">
      <div className="ts-filter" role="group" aria-label="agent readings">
        <span className="ctx-stackpick-lab">agents</span>
        <Explain of="what agent readings are">{AGENT_REGION_WORDS}</Explain>
        <RefreshKey busy={busy} label={busy ? "reading…" : "read again"} onClick={readAgain} />
        {/* The switch is the action this region most often leads to, so it sits at the top of every
            view, as well as on the always-on list's "In this repo" heading. */}
        {onSkills ? <Button onClick={onSkills} title="Turn skills and plugins off or down for this repo or every repo; new sessions only">
          <Plug size={12} /> skills &amp; plugins →
        </Button> : null}
      </div>
      {!onSkills && skillsCant ? <Hint>{skillsCant}</Hint> : null}
      <div className="ts-filter" role="group" aria-label="agent readings view">
        <FilterChip on={view === "now"} clears={false} onClick={() => setView("now")}><Gauge size={14} /> {AGENT_VIEW_LABEL.now}</FilterChip>
        <FilterChip on={view === "weeks"} clears={false} onClick={() => setView("weeks")}><CalendarRange size={14} /> {AGENT_VIEW_LABEL.weeks}</FilterChip>
        <FilterChip on={view === "tests"} clears={false} onClick={() => setView("tests")}><FlaskConical size={14} /> {AGENT_VIEW_LABEL.tests}</FilterChip>
      </div>
      <div className="rh-cap rh-gutter">{AGENT_VIEW_HELP[view]}</div>
      {view === "now" ? (<>
        {repoId ? <Headline pts={pts} mk={mk} probes={probes} /> : null}
        {carried ? (
          <div className="rh-card">
            <div className="section-head"><span className="rh-chart-label">{CARRIED_TITLE}</span></div>
            <div className="rh-gutter">{carried}</div>
          </div>
        ) : null}
      </>) : null}
      {view === "tests" ? (<>
        {/* The search test (R-metrics-074): start one against its estimate, read the newest result. */}
        {repoId ? <ProbeCard repoId={repoId} view={probeView} results={probes} pts={pts} /> : null}
        {/* Compare setups (R-metrics-073): export this desktop's setup block, import a colleague's. */}
        {repoId ? <SetupShareCard repoId={repoId} pts={pts} probe={shareProbe} /> : null}
      </>) : null}
      {view === "weeks" ? (<>
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
                {startPartGroups(week.start).map((g) => (
                  <div key={g.id} className="ar-part-group">
                    <div className="ar-chart-title">{g.heading}</div>
                    <div className="rh-cap">{g.note}</div>
                    {g.lines.map((l) => <div key={l}>{l}</div>)}
                  </div>
                ))}
              </>) : null}
              <div className="rh-cap">{startSubLine(week.start)}</div>
            </>) : null}
          </Reading>
        ) : null}

        <Reading title="Before the first edit" rule={doc.rules.explore} pick={pk} chartTitle="Tokens sent before the first edit"
          bars={{ ...series(weeks, at, newest, (w) => w.explore, (r) => [r.medianTok], (r) => exploreLine(r)), fmtTick: fmtCount }}>
          {isAgentAbsent(week.explore) ? null : <KindBar bag={week.explore.split} whole={tokenTotal(week.explore.split)} />}
          {hasLooks ? (() => {
            // Same sessions as the token bars; a week the token line already explained reads as
            // an outline here, and its line repeats nothing (the sentence is just above).
            const looks = series<SeriesMedian>(weeks, at, newest,
              (w) => (isAgentAbsent(w.explore) ? w.explore : w.explore.looks), (r) => [r.median], looksLine);
            return (<>
              <div className="ar-chart-title">Look calls before the first edit</div>
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

        {hasSkills ? (
          <Reading title="Skill loads per session" rule={doc.rules.skills ?? ""} pick={pk}
            bars={{ ...series<SeriesLoads>(weeks, at, newest, (w) => w.skillLoads, (r) => [r.mean], skillsLine), fmtTick: fmtMean }} />
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
              fmtTick: fmtCount, parts: ["conversations' own", "subagents"], share: true }}>
          </Reading>
        ) : null}

        <Reading title="Rework spend" rule={doc.rules.rework} pick={pk}
          bars={{ ...series(weeks, at, newest, (w) => w.rework,
            (r) => [tokenTotal(r.byClass.rework), tokenTotal(r.byClass.feature), tokenTotal(r.byClass.unknown)], (r) => reworkLine(r)),
            fmtTick: fmtCount, parts: ["rework", "feature", "unknown"], share: true }}>
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
      </>) : null}
    </div>
  );
}
