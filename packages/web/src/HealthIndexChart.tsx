/**
 * The Score card: the health score as a ring and a hero number, ONE weekly
 * number out of 100 against fixed good values (`shared/healthindex.ts`, the
 * one layer that takes a side), what holds it down — always in the open, never
 * behind a tap — its trend, its line over weeks or over commits (`axis`), and
 * the picked week's five entry scores with what each added. Geometry and
 * sentences are `healthIndexWords.ts` / `healthSpendWords.ts` /
 * `healthRingWords.ts` / `healthIndexChartWords.ts`; this file only paints a
 * `HealthIndexResponse` it is handed — the phone fetches it
 * (`HealthIndexSection.tsx`), the VS Code panel derives it from the series file
 * in the folder — so it reaches no socket.
 * Ink curve with a faint area under it, accent end dot ringed in the panel
 * colour (the series charts' convention, never `--ctx-series`), a fixed 0–100
 * axis labelled on every rule. The alerts keep `--dead`/`--warn`, each with its
 * icon and its level in words; the contribution bars are the region's ONE hue
 * exception (`--hix-up` / `--hix-down`) with a two-swatch legend.
 * Beside the score, where the host sends `spend`, a dotted second line on its
 * own right axis: tokens per Claude request that week — a per-week STEP in
 * commits mode, because the ledger is per week, never per commit.
 * The x-axis choice itself is the region's row; this card draws the mode it is
 * given and, like every chart there, leaves the drag instruction to the region.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { HeartPulse, OctagonAlert, Send, TriangleAlert } from "lucide-react";
import {
  BRAND, HEALTH_INDEX_VS_WEEKS, healthCapWords, healthCommitsAvailability, healthIndexVs, isoWeekOf, type HealthIndexResponse,
} from "@waterplane/shared";
import { Explain } from "./Explain";
import { CantInline } from "./Unavailable";
import type { IndexNow, IndexTrendWeek, IndexVsSubject, IndexWeekSubject } from "./setupRemedy";
import {
  HEALTH_ENTRY_NAME, HEALTH_ENTRY_ORDER, INDEX_TREND_ASK_LABEL, areaD, barsCaptionWords, barsWeeksOnlyWords, carriedWords, commitsAbsentWords,
  contributionBars, gapWords, indexAskLabel, indexCommitGeom, indexExplainWords, indexLineGeom, indexReadoutWords, indexVsWords, linkSpanWords,
  olderHostSeries, olderHostWords, signedTenths, thinnedWords, treeGrowthWords, trendWords, type HealthAxisMode, type IndexLineGeom,
} from "./healthIndexWords";
import {
  SPEND_METHOD_WORDS, SPEND_STEP_WORDS, spendCoverageWords, spendLeadWords, spendLineGeom, spendReadoutWords, spendStepGeom, spendTick,
} from "./healthSpendWords";
import { ringGeom } from "./healthRingWords";
import {
  BAR_DOWN_WORDS, BAR_UP_WORDS, COMMIT_GAP_NOTE, FIRST_SCORED_WEEK_WORDS, HOW_SCORED_SUMMARY, OUT_OF_100, carriedNoMovesWords,
  commitGapWords, commitSpendClause, heldDownWords, scoreChartAria, spendStepNote,
} from "./healthIndexChartWords";

const LINE_H = 112;
const GUTTER = 30;
/** The spend line's own axis labels, right of the plot — only when it is drawn. */
const RGUTTER = 34;
/** Room under the plot for the commit mode's three day ticks. */
const TICK_H = 14;
const RING_R = 52;
const RING_STROKE = 6;

/**
 * `onAsk` is a slot for the week's subject rather than a send path, as
 * `SeriesTile`'s `actions` is: this file paints a chart and words it, and the
 * sheet decides what a prompt is and where it goes. Absent = no button at all.
 */
export function HealthIndexChart({ view, empty, onAsk, onAskTrend, axis = "weeks" }: {
  view: HealthIndexResponse | null | undefined;
  /** The caller's state line under the head — loading, offline, or why there is no series. */
  empty: ReactNode;
  onAsk?: (w: IndexWeekSubject, vs: IndexVsSubject | null) => void;
  onAskTrend?: (weeks: IndexTrendWeek[], baselineWeek: string, vs: IndexVsSubject | null, now?: IndexNow) => void;
  /** Which x the region draws. Commits falls back to weeks — saying so — where the host sends no commit series. */
  axis?: HealthAxisMode;
}) {
  const series = view?.series ?? null;

  const roRef = useRef<ResizeObserver | null>(null);
  const [width, setWidth] = useState(0);
  const boxRef = useCallback((el: HTMLDivElement | null) => {
    roRef.current?.disconnect();
    roRef.current = null;
    if (!el) return;
    const measure = () => {
      const cs = getComputedStyle(el);
      setWidth(Math.max(0, el.clientWidth - parseFloat(cs.paddingLeft || "0") - parseFloat(cs.paddingRight || "0")));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    roRef.current = ro;
  }, []);
  useEffect(() => () => roRef.current?.disconnect(), []);

  // The crosshair INDEX is state, held per mode: an index into the weeks is a
  // different reading in the commits, so a mode change drops it.
  const commitsAvail = healthCommitsAvailability(view);
  const commitPts = commitsAvail === "present" ? view!.commits!.points : null;
  const mode: HealthAxisMode = axis === "commits" && commitPts ? "commits" : "weeks";
  const [pick, setPick] = useState<{ mode: HealthAxisMode; i: number } | null>(null);
  const picked = pick && pick.mode === mode ? pick.i : null;
  const svgRef = useRef<SVGSVGElement | null>(null);

  const points = series?.points ?? [];
  const last = points[points.length - 1] ?? null;
  const prev = points[points.length - 2] ?? null;
  const spend = view?.spend;
  // What the x runs over in this mode: the weeks, or every drawn commit.
  const xs: readonly { week: string }[] = mode === "commits" ? commitPts! : points;
  const n = xs.length;
  // Width-free probe: whether the line exists, and where it starts, do not depend on pixels.
  const spendProbe = mode === "commits" ? spendStepGeom(xs, spend, 1, 1) : spendLineGeom(xs, spend, 1, 1);
  const hasSpend = !!spendProbe;
  const plotW = Math.max(1, width - GUTTER - (hasSpend ? RGUTTER : 0));
  const cg = mode === "commits" && width > 0 ? indexCommitGeom(commitPts!, plotW, LINE_H) : null;
  const g: IndexLineGeom | null = series && width > 0 ? (mode === "commits" ? cg : indexLineGeom(points, plotW, LINE_H)) : null;
  const sg = g ? (mode === "commits" ? spendStepGeom(xs, spend, plotW, LINE_H) : spendLineGeom(xs, spend, plotW, LINE_H)) : null;
  const spendAbsence = series ? spendCoverageWords(spendProbe, xs, spend) : null;
  const atIdx = picked != null && picked < n ? picked : n - 1;
  // The week the bars and the ask follow: the picked week, or the picked commit's week.
  const atCommit = mode === "commits" ? commitPts![atIdx] ?? null : null;
  const weekIdx = atCommit ? points.findIndex((p) => p.week === atCommit.week) : atIdx;
  const at = weekIdx >= 0 ? points[weekIdx] ?? null : null;
  const atPrev = weekIdx > 0 ? points[weekIdx - 1] : null;
  const delta = last && prev && last.lnLink !== null ? last.index - prev.index : null;
  const older = olderHostSeries(points);
  const capOf = (p: { index: number; mean: number; cappedBy: Parameters<typeof healthCapWords>[0]["cappedBy"] }) =>
    healthCapWords({ value: p.index, mean: p.mean, cappedBy: p.cappedBy });
  const capNow = last ? capOf(last) : null;
  const heldNow = last ? heldDownWords({ value: last.index, mean: last.mean, cappedBy: last.cappedBy }) : null;
  // The phone's own clock decides "this week": the latest MEASURED week can be
  // months old (a week with no commits has no point), and is then named.
  const currentWeek = isoWeekOf(new Date().toISOString().slice(0, 10));
  // "Vs 12 weeks ago" against the latest measured week at least that far back,
  // named — absent (not drawn) where no week is that old.
  const vsOf = (i: number): IndexVsSubject | null => {
    const v = healthIndexVs(points, HEALTH_INDEX_VS_WEEKS, i);
    return v ? { delta: v.delta, thenWeek: v.then.week, weeks: v.weeks } : null;
  };
  const vsLast = last ? healthIndexVs(points) : null;
  // The bars and the ask follow the week the line is on: a bar chart captioned
  // with one week under a crosshair on another is two answers to one question.
  const bars = at ? contributionBars(at.contributions ?? {}, 100) : null;
  const ask = onAsk && at && atPrev && at.lnLink !== null && bars?.bars.length
    ? () => onAsk({
      week: at.week,
      prevWeek: atPrev.week,
      index: at.index,
      delta: at.index - atPrev.index,
      alerts: (at.alerts ?? []).map((a) => a.text),
      cap: capOf(at),
      movers: bars.bars.map((b) => ({ key: b.key, name: b.name, points: b.value })),
    }, vsOf(weekIdx))
    : null;
  // A trend needs at least one linked week; a lone baseline is a point, not a line.
  const askTrend = onAskTrend && series && points.some((p) => p.lnLink !== null)
    ? () => onAskTrend(points.map((p) => ({
      week: p.week, index: p.index, gap: p.gap, lnLink: p.lnLink, contributions: p.contributions,
      ...(p.gapReason ? { gapReason: p.gapReason } : {}),
    })), series.baselineWeek, vsOf(points.length - 1), { alerts: (last!.alerts ?? []).map((a) => a.text), cap: capNow })
    : null;
  const tree = series && last ? treeGrowthWords(points[0]?.tree, last.tree, series.baselineWeek) : null;
  const ring = last ? ringGeom(last.index, RING_R, RING_STROKE) : null;
  const thinned = mode === "commits" && view?.commits?.thinned ? thinnedWords(view.commits.points.length, view.commits.total) : null;

  const readout = (() => {
    if (mode === "commits") {
      const c = atCommit;
      if (!c) return "";
      const v = sg ? sg.vals[atIdx] ?? null : null;
      return `${indexReadoutWords("commits", c)}${c.gap ? ` (${COMMIT_GAP_NOTE})` : ""}${sg ? ` · ${commitSpendClause(spendReadoutWords(v), v !== null)}` : ""}`;
    }
    const p = points[atIdx];
    if (!p) return "";
    const span = !p.gap ? linkSpanWords(p.spanDays) : null;
    return `${indexReadoutWords("weeks", p)}${p.gap ? ` (${carriedWords(p.gapReason)})` : ""}${span ? ` — ${span}` : ""}`
      + (sg ? ` · ${spendReadoutWords(sg.vals[atIdx] ?? null)}` : "");
  })();

  const pickAt = (e: { clientX: number }) => {
    const svg = svgRef.current;
    if (!svg || !g || n < 2) return;
    const r = svg.getBoundingClientRect();
    const x = e.clientX - r.left - GUTTER;
    const i = Math.round((x / plotW) * (n - 1));
    setPick({ mode, i: Math.max(0, Math.min(n - 1, i)) });
  };
  const svgH = LINE_H + 2 + (cg ? TICK_H : 0);

  return (
    <section id="rh-score" className="hix rh-card" aria-label="Health index">
      <div className="section-head">
        <h3 className="rh-h"><HeartPulse size={16} aria-hidden /> Health index</h3>
        <Explain of="the health index">
          {/* With a series, the scoring sentence is in the card's fold. */}
          {series ? null : <p>One score out of 100 per repo, against fixed good values for {BRAND.displayName}'s five readings; it starts at the first week all five exist.</p>}
          <p>It is built from {BRAND.displayName}'s readings only — the same five in every repo, against the same good values. Each counts against the repo as it grows — longer files, more escape hatches — so the score falls when they grow past their good value and rises when they shrink back. It is the one place the app takes a side; the readings below only report.</p>
        </Explain>
      </div>

      {empty}

      {series && last && older ? (
        <div className="hix-box"><div className="rh-cap">{olderHostWords(BRAND.displayName)}</div></div>
      ) : null}

      {series && last && !older ? (
        <div className="hix-box" ref={boxRef}>
          <div className="hix-hero">
            <div className="hix-ring" style={ring ? { width: ring.w, height: ring.h } : undefined}>
              {ring ? (
                <svg width={ring.w} height={ring.h} viewBox={`0 0 ${ring.w} ${ring.h}`} aria-hidden>
                  <path d={ring.track} fill="none" stroke="currentColor" strokeOpacity={0.14} strokeWidth={RING_STROKE} strokeLinecap="round" />
                  {ring.arc ? <path d={ring.arc} fill="none" stroke="var(--accent)" strokeWidth={RING_STROKE} strokeLinecap="round" /> : null}
                </svg>
              ) : null}
              <span className="hix-hero-n" style={ring ? { top: ring.cy } : undefined}>{Math.round(last.index)}</span>
            </div>
            <div className="hix-hero-side">
              <div className="hix-of">{OUT_OF_100}</div>
              {(() => {
                const t = trendWords(last.index, points[0], points.length < 2, delta, last.week, currentWeek);
                const vs = indexVsWords(vsLast);
                return t || vs ? <div className="hix-vs">{t}{t && vs ? " · " : null}{vs}</div> : null;
              })()}
              {heldNow ? <div className="hix-cap">{heldNow}</div> : null}
            </div>
          </div>
          {/* What holds the score down, in the open: every entry under a line, worst first, each naming its offender. */}
          {(last.alerts ?? []).length ? (
            <ul className="hix-alerts" aria-label="What is holding the score down">
              {(last.alerts ?? []).map((a) => (
                <li key={a.subject} className={`hix-alert ${a.level}`}>
                  {a.level === "severe" ? <OctagonAlert size={14} aria-hidden /> : <TriangleAlert size={14} aria-hidden />}
                  <span>{a.text}</span>
                </li>
              ))}
            </ul>
          ) : null}
          {view?.words ? <div className="rh-tile-mean">{view.words.body}</div> : null}

          {axis === "commits" && commitsAvail === "absent" ? <div className="rh-cap">{commitsAbsentWords(BRAND.displayName)}</div> : null}

          {sg ? (
            <div className="hix-legend" aria-hidden>
              <span><svg width={18} height={6}><line x1={1} x2={17} y1={3} y2={3} stroke="currentColor" strokeOpacity={0.55} strokeWidth={2} strokeLinecap="round" /></svg> score, left axis</span>
              <span><svg width={18} height={6}><line x1={1} x2={17} y1={3} y2={3} stroke="var(--chart-2)" strokeWidth={1.5} strokeDasharray="0.1 4" strokeLinecap="round" /></svg> tokens per request, right axis</span>
            </div>
          ) : null}
          {g ? (
            <svg ref={svgRef} className="rh-spark hix-chart" width={width} height={svgH} viewBox={`0 0 ${width} ${svgH}`}
              role="img"
              aria-label={scoreChartAria(mode, n, g.lo, g.hi)}
              onPointerDown={(e) => pickAt(e)} onPointerMove={pickAt}
              onPointerLeave={(e) => { if (e.pointerType === "mouse") setPick(null); }}>
              {g.rules.map((r) => (
                <text key={r.v} className="rh-tick" x={GUTTER - 5} y={Math.min(LINE_H, Math.max(8, r.y + 3.5))} textAnchor="end">{r.v}</text>
              ))}
              <g transform={`translate(${GUTTER},0)`}>
                {g.rules.map((r) => (
                  <line key={r.v} x1={0} x2={plotW} y1={r.y} y2={r.y} stroke="currentColor" strokeOpacity={0.14} strokeWidth={1} strokeDasharray="2 3" />
                ))}
                {/* Commits mode: a faint rule where each new week starts, and the days at three reading positions. */}
                {cg ? cg.weekRules.map((w) => (
                  <line key={w.week} x1={w.x} x2={w.x} y1={0} y2={LINE_H} stroke="currentColor" strokeOpacity={0.08} strokeWidth={1} />
                )) : null}
                {cg ? cg.ticks.map((t) => (
                  <text key={`${t.x}-${t.day}`} className="rh-tick" x={t.x} y={LINE_H + TICK_H} textAnchor={t.anchor}>{t.day}</text>
                )) : null}
                {(() => {
                  const area = areaD(g);
                  return area ? <path d={area} fill="currentColor" fillOpacity={0.07} stroke="none" /> : null;
                })()}
                {sg ? (
                  <g className="hix-spend">
                    {sg.d ? <path d={sg.d} fill="none" stroke="var(--chart-2)" strokeWidth={1.5} strokeDasharray="0.1 4" strokeLinecap="round" strokeLinejoin="round" /> : null}
                    {sg.dots.map((p, i) => <circle key={i} cx={p.x} cy={p.y} r={1.6} fill="var(--chart-2)" />)}
                    {(() => {
                      const y = sg.ys[atIdx];
                      return y == null ? null : <circle cx={g.pts[atIdx]?.x ?? g.endX} cy={y} r={2.4} fill="var(--chart-2)" stroke="var(--panel)" strokeWidth={1.2} />;
                    })()}
                  </g>
                ) : null}
                {/* The score is the STRONGER line, drawn over the tokens line. */}
                {g.d ? <path d={g.d} fill="none" stroke="currentColor" strokeOpacity={0.55} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" /> : null}
                {/* A link over weeks with no row: dashed, so it never reads as one week's move. */}
                {g.dashed ? <path d={g.dashed} fill="none" stroke="currentColor" strokeOpacity={0.55} strokeWidth={1.5} strokeDasharray="3 3" strokeLinecap="round" /> : null}
                {g.dots.map((p, i) => <circle key={i} cx={p.x} cy={p.y} r={1.8} fill="currentColor" fillOpacity={0.55} />)}
                {(() => {
                  const p = picked == null ? null : g.pts[picked];
                  const e = p ?? { x: g.endX, y: g.endY };
                  return <circle cx={e.x} cy={e.y} r={2.5} fill="var(--accent)" stroke="var(--panel)" strokeWidth={1.5} />;
                })()}
              </g>
              {/* The spend axis is FITTED, so both bounds are printed on the lines they name. */}
              {sg ? (sg.flat ? [{ v: sg.hi, y: sg.hiY }] : [{ v: sg.hi, y: sg.hiY }, { v: sg.lo, y: sg.loY }]).map((t) => (
                <text key={t.v} className="rh-tick" x={GUTTER + plotW + 5} y={Math.min(LINE_H, Math.max(8, t.y + 3.5))} textAnchor="start" fill="var(--chart-2)">{spendTick(t.v)}</text>
              )) : null}
            </svg>
          ) : null}
          <div className="rh-tile-read hix-readout">{readout}</div>
          {thinned ? <div className="rh-cap">{thinned}</div> : null}
          {g && g.gaps > 0 ? <div className="rh-cap">{mode === "weeks" ? gapWords(g.gaps) : commitGapWords(g.gaps)}</div> : null}
          {spendAbsence ? <div className="rh-cap">{spendAbsence}</div> : null}

          {at && at.scores ? (
            <div className="hix-bars">
              {mode === "commits" ? <div className="rh-cap">{barsWeeksOnlyWords(at.week)}</div> : null}
              {/* Four columns — name, track, score, move — so no word ever sits on a bar or
                  runs off the edge. Bar geometry is in percent of the track. */}
              <div className="hix-bar-rows" role="img" aria-label={HEALTH_ENTRY_ORDER.filter((k) => at.scores?.[k] !== undefined)
                .map((k) => `${HEALTH_ENTRY_NAME[k]} ${Math.round(at.scores[k] as number)}`).join(", ")}>
                {HEALTH_ENTRY_ORDER.filter((k) => at.scores?.[k] !== undefined).map((k) => {
                  const b = bars?.bars.find((x) => x.key === k) ?? null;
                  return (
                    <div key={k} className="hix-bar-row" aria-hidden>
                      <span className="hix-barname">{HEALTH_ENTRY_NAME[k]}</span>
                      <span className="hix-track">
                        {b && b.side !== "none" ? <span className={`hix-bar ${b.side}`} style={{ left: `${b.x}%`, width: `${b.w}%` }} /> : null}
                      </span>
                      <span className="hix-barscore">{Math.round(at.scores[k] as number)}</span>
                      <span className="hix-barval">{b ? signedTenths(b.value) : ""}</span>
                    </div>
                  );
                })}
                {bars && bars.bars.length ? (
                  <div className="hix-bar-row hix-bar-axis" aria-hidden>
                    <span />
                    <span className="hix-axis-words"><span>← pulled down</span><span>pushed up →</span></span>
                    <span /><span />
                  </div>
                ) : null}
              </div>
              {bars && bars.bars.some((b) => b.side !== "none") ? (
                <div className="hix-legend hix-bar-legend" aria-hidden>
                  <span><i className="hix-swatch up" /> {BAR_UP_WORDS}</span>
                  <span><i className="hix-swatch down" /> {BAR_DOWN_WORDS}</span>
                </div>
              ) : null}
              {bars && !bars.bars.length ? (
                <div className="rh-cap"><CantInline>{at.gap ? carriedNoMovesWords(carriedWords(at.gapReason)) : FIRST_SCORED_WEEK_WORDS}</CantInline></div>
              ) : null}
            </div>
          ) : null}
          {(ask && at) || askTrend ? (
            <div className="rh-tile-acts">
              {ask && at ? (
                <button className="key rh-verb" onClick={ask}>
                  <Send size={12} /> {indexAskLabel(at.week, weekIdx === points.length - 1 && at.week === currentWeek)}…
                </button>
              ) : null}
              {askTrend ? (
                <button className="key rh-verb" onClick={askTrend}>
                  <Send size={12} /> {INDEX_TREND_ASK_LABEL}…
                </button>
              ) : null}
            </div>
          ) : null}
          {sg ? <div className="rh-cap">{spendLeadWords(last.values?.context).lead}</div> : null}
          <details className="hint-more rh-more">
            <summary>{HOW_SCORED_SUMMARY}</summary>
            <p>{indexExplainWords(series.baselineWeek, BRAND.displayName, { disabled: last.disabled, overridden: last.overridden })}</p>
            {capNow ? <p>{capNow}</p> : null}
            {at && at.scores && bars?.bars.length ? <p>{barsCaptionWords(at.week)}</p> : null}
            {tree ? <p>{tree}</p> : null}
            {sg ? <p>{spendLeadWords(last.values?.context).more}{mode === "commits" ? ` ${spendStepNote(SPEND_STEP_WORDS)}` : ""}</p> : null}
            {sg ? <p>{SPEND_METHOD_WORDS}</p> : null}
            {view?.lastRefresh ? <p>Last weekly refresh {view.lastRefresh.slice(0, 10)}.</p> : null}
          </details>
        </div>
      ) : null}
    </section>
  );
}
