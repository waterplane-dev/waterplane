/**
 * The health score as a chart: ONE weekly number out of 100 against fixed good
 * values (`shared/healthindex.ts`, the one layer that takes a side), the cap
 * and the alerts naming what holds it down — always in the open, never behind
 * a tap — its trend, its line over weeks, and the picked week's five entry
 * scores with what each added. Geometry and sentences are
 * `healthIndexWords.ts`; this file only paints a `HealthIndexResponse` it is
 * handed — the phone fetches it (`HealthIndexSection.tsx`), the VS Code panel
 * derives it from the series file in the folder — so it reaches no socket.
 * Ink curve, accent end dot ringed in the panel colour (the series charts'
 * convention, never `--ctx-series`), a fixed 0–100 axis labelled on every rule.
 * The one colour here is the alerts': `--dead` for severe, `--warn` for warn,
 * each with its icon and its level in words, so colour is never the only sign.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { HeartPulse, OctagonAlert, Send, TriangleAlert } from "lucide-react";
import { BRAND, HEALTH_INDEX_VS_WEEKS, healthCapWords, healthIndexVs, isoWeekOf, type HealthIndexResponse } from "@waterplane/shared";
import { Explain } from "./Explain";
import { CantInline } from "./Unavailable";
import type { IndexNow, IndexTrendWeek, IndexVsSubject, IndexWeekSubject } from "./setupRemedy";
import {
  HEALTH_ENTRY_NAME, HEALTH_ENTRY_ORDER, INDEX_TREND_ASK_LABEL, barsCaptionWords, carriedWords, contributionBars, gapWords, indexAskLabel,
  indexExplainWords, indexLineGeom, indexVsWords, linkSpanWords, olderHostSeries, olderHostWords, signedTenths, treeGrowthWords, trendWords,
} from "./healthIndexWords";

const LINE_H = 112;
const GUTTER = 30;

/**
 * `onAsk` is a slot for the week's subject rather than a send path, as
 * `SeriesTile`'s `actions` is: this file paints a chart and words it, and the
 * sheet decides what a prompt is and where it goes. Absent = no button at all.
 */
export function HealthIndexChart({ view, empty, onAsk, onAskTrend }: {
  view: HealthIndexResponse | null | undefined;
  /** The caller's state line under the head — loading, offline, or why there is no series. */
  empty: ReactNode;
  onAsk?: (w: IndexWeekSubject, vs: IndexVsSubject | null) => void;
  onAskTrend?: (weeks: IndexTrendWeek[], baselineWeek: string, vs: IndexVsSubject | null, now?: IndexNow) => void;
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

  const [picked, setPicked] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);

  const points = series?.points ?? [];
  const last = points[points.length - 1] ?? null;
  const prev = points[points.length - 2] ?? null;
  const plotW = Math.max(1, width - GUTTER);
  const g = series && width > 0 ? indexLineGeom(points, plotW, LINE_H) : null;
  const atIdx = picked != null && points[picked] ? picked : points.length - 1;
  const at = points[atIdx] ?? null;
  const atPrev = atIdx > 0 ? points[atIdx - 1] : null;
  const delta = last && prev && last.lnLink !== null ? last.index - prev.index : null;
  const older = olderHostSeries(points);
  const capOf = (p: { index: number; mean: number; cappedBy: Parameters<typeof healthCapWords>[0]["cappedBy"] }) =>
    healthCapWords({ value: p.index, mean: p.mean, cappedBy: p.cappedBy });
  const capNow = last ? capOf(last) : null;
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
    }, vsOf(atIdx))
    : null;
  // A trend needs at least one linked week; a lone baseline is a point, not a line.
  const askTrend = onAskTrend && series && points.some((p) => p.lnLink !== null)
    ? () => onAskTrend(points.map((p) => ({
      week: p.week, index: p.index, gap: p.gap, lnLink: p.lnLink, contributions: p.contributions,
      ...(p.gapReason ? { gapReason: p.gapReason } : {}),
    })), series.baselineWeek, vsOf(points.length - 1), { alerts: (last!.alerts ?? []).map((a) => a.text), cap: capNow })
    : null;
  const atSpan = at && !at.gap ? linkSpanWords(at.spanDays) : null;
  const tree = series && last ? treeGrowthWords(points[0]?.tree, last.tree, series.baselineWeek) : null;

  const pick = (e: { clientX: number }) => {
    const svg = svgRef.current;
    if (!svg || !g || points.length < 2) return;
    const r = svg.getBoundingClientRect();
    const x = e.clientX - r.left - GUTTER;
    const i = Math.round((x / plotW) * (points.length - 1));
    setPicked(Math.max(0, Math.min(points.length - 1, i)));
  };

  return (
    <section className="hix" aria-label="Health index">
      <div className="section-head">
        <span className="section hix-name"><HeartPulse size={14} /> Health index</span>
        <Explain of="the health index">
          {/* With a series, the scoring sentence is already the box's last caption. */}
          {series ? null : <p>One score out of 100 per repo, against fixed good values for {BRAND.displayName}'s five readings; it starts at the first week all five exist.</p>}
          <p>It is built from {BRAND.displayName}'s readings only — the same five in every repo, against the same good values. Each counts against the repo as it grows — longer files, more escape hatches — so the score falls when they grow past their good value and rises when they shrink back. It is the one place the app takes a side; the readings below only report.</p>
        </Explain>
      </div>

      {empty}

      {series && last && older ? (
        <div className="rh-box hix-box"><div className="rh-cap">{olderHostWords(BRAND.displayName)}</div></div>
      ) : null}

      {series && last && !older ? (
        <div className="rh-box hix-box" ref={boxRef}>
          <div className="rh-tile-valrow">
            <span className="rh-tile-val">{Math.round(last.index)}</span>
            <span className="hix-delta">out of 100</span>
          </div>
          {/* What holds the score down comes first, in the open: the cap, then every
              entry under a line, worst first, each naming its offender. */}
          {capNow ? <div className="hix-cap">{capNow}</div> : null}
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
          {(() => {
            const t = trendWords(last.index, points[0], points.length < 2, delta, last.week, currentWeek);
            const vs = indexVsWords(vsLast);
            return t || vs ? <div className="hix-vs">{t}{t && vs ? " · " : null}{vs}</div> : null;
          })()}
          {view?.words ? <div className="rh-tile-mean">{view.words.body}</div> : null}

          {g ? (
            <svg ref={svgRef} className="rh-spark" width={width} height={LINE_H + 2} viewBox={`0 0 ${width} ${LINE_H + 2}`}
              role="img"
              aria-label={`Health score over ${points.length} weeks, from ${Math.round(g.lo)} to ${Math.round(g.hi)}, on a 0 to 100 axis`}
              onPointerDown={(e) => pick(e)} onPointerMove={pick}
              onPointerLeave={(e) => { if (e.pointerType === "mouse") setPicked(null); }}>
              {g.rules.map((r) => (
                <text key={r.v} className="rh-tick" x={GUTTER - 5} y={Math.min(LINE_H, Math.max(8, r.y + 3.5))} textAnchor="end">{r.v}</text>
              ))}
              <g transform={`translate(${GUTTER},0)`}>
                {g.rules.map((r) => (
                  <line key={r.v} x1={0} x2={plotW} y1={r.y} y2={r.y} stroke="currentColor" strokeOpacity={0.14} strokeWidth={1} strokeDasharray="2 3" />
                ))}
                {g.d ? <path d={g.d} fill="none" stroke="currentColor" strokeOpacity={0.55} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" /> : null}
                {/* A link over weeks with no row: dashed, so it never reads as one week's move. */}
                {g.dashed ? <path d={g.dashed} fill="none" stroke="currentColor" strokeOpacity={0.55} strokeWidth={1.5} strokeDasharray="3 3" strokeLinecap="round" /> : null}
                {g.dots.map((p, i) => <circle key={i} cx={p.x} cy={p.y} r={1.8} fill="currentColor" fillOpacity={0.55} />)}
                {(() => {
                  const p = picked == null ? null : g.pts[picked];
                  const e = p ?? { x: g.endX, y: g.endY };
                  return <circle cx={e.x} cy={e.y} r={3} fill="var(--accent)" stroke="var(--panel)" strokeWidth={1.5} />;
                })()}
              </g>
            </svg>
          ) : null}
          <div className="rh-tile-read hix-readout">
            {at ? `Week of ${at.week}: ${Math.round(at.index)}${at.gap ? ` (${carriedWords(at.gapReason)})` : ""}${atSpan ? ` — ${atSpan}` : ""}` : ""}
            {points.length > 1 ? " — drag across the line to read a week." : ""}
          </div>
          {g && g.gaps > 0 ? <div className="rh-cap">{gapWords(g.gaps)}</div> : null}

          {at && at.scores ? (
            <div className="hix-bars">
              <div className="rh-cap">{barsCaptionWords(at.week)}</div>
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
                        {b && b.side !== "none" ? <span className="hix-bar" style={{ left: `${b.x}%`, width: `${b.w}%` }} /> : null}
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
              {bars && !bars.bars.length ? (
                <div className="rh-cap"><CantInline>{at.gap ? `${carriedWords(at.gapReason).replace(/^./, (c) => c.toUpperCase())}; there are no moves to show.` : "This is the first scored week; moves start the week after."}</CantInline></div>
              ) : null}
            </div>
          ) : null}
          {(ask && at) || askTrend ? (
            <div className="rh-tile-acts">
              {ask && at ? (
                <button className="key" onClick={ask}>
                  <Send size={12} /> {indexAskLabel(at.week, atIdx === points.length - 1 && at.week === currentWeek)}…
                </button>
              ) : null}
              {askTrend ? (
                <button className="key" onClick={askTrend}>
                  <Send size={12} /> {INDEX_TREND_ASK_LABEL}…
                </button>
              ) : null}
            </div>
          ) : null}
          <div className="rh-cap">{indexExplainWords(series.baselineWeek, BRAND.displayName, { disabled: last.disabled, overridden: last.overridden })}</div>
          {tree ? <div className="rh-cap">{tree}</div> : null}
          {view?.lastRefresh ? <div className="rh-cap">Last weekly refresh {view.lastRefresh.slice(0, 10)}.</div> : null}
        </div>
      ) : null}
    </section>
  );
}
