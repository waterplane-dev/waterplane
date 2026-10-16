/**
 * The health index as a chart: ONE chained weekly number (`shared/healthindex.ts`,
 * the one layer that takes a side), its line over weeks and the picked week's
 * five contributions as diverging bars. Geometry and sentences are
 * `healthIndexWords.ts`; this file only paints a `HealthIndexResponse` it is
 * handed — the phone fetches it (`HealthIndexSection.tsx`), the VS Code panel
 * derives it from the series file in the folder — so it reaches no socket.
 * Ink curve, accent end dot ringed in the panel colour (the series charts'
 * convention, never `--ctx-series`), a faint 100 baseline, no status colour.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { HeartPulse, Send } from "lucide-react";
import { BRAND, HEALTH_INDEX_VS_WEEKS, healthIndexVs, isoWeekOf, type HealthIndexResponse } from "@waterplane/shared";
import { Explain } from "./Explain";
import { CantInline } from "./Unavailable";
import type { IndexTrendWeek, IndexVsSubject, IndexWeekSubject } from "./setupRemedy";
import {
  INDEX_TREND_ASK_LABEL, barsCaptionWords, carriedWords, contributionBars, gapWords, indexAskLabel, indexExplainWords, indexLineGeom,
  indexVsWords, linkSpanWords, signedTenths, sinceBaselineWords, treeGrowthWords, weekChangeWords,
} from "./healthIndexWords";

const LINE_H = 64;
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
  onAskTrend?: (weeks: IndexTrendWeek[], baselineWeek: string, vs: IndexVsSubject | null) => void;
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
  const bars = at ? contributionBars(at.contributions, 100) : null;
  const ask = onAsk && at && atPrev && at.lnLink !== null && bars?.bars.length
    ? () => onAsk({
      week: at.week,
      prevWeek: atPrev.week,
      index: at.index,
      delta: at.index - atPrev.index,
      movers: bars.bars.map((b) => ({ key: b.key, name: b.name, points: b.value })),
    }, vsOf(atIdx))
    : null;
  // A trend needs at least one linked week; a lone baseline is a point, not a line.
  const askTrend = onAskTrend && series && points.some((p) => p.lnLink !== null)
    ? () => onAskTrend(points.map((p) => ({
      week: p.week, index: p.index, gap: p.gap, lnLink: p.lnLink, contributions: p.contributions,
      ...(p.gapReason ? { gapReason: p.gapReason } : {}),
    })), series.baselineWeek, vsOf(points.length - 1))
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
          {/* With a series, the baseline sentence is already the box's last caption. */}
          {series ? null : <p>One number per repo, chained week over week from {BRAND.displayName}'s five readings; 100 is the first week all five exist.</p>}
          <p>It is built from {BRAND.displayName}'s readings only — the same five in every repo, so one repo's index can be put beside another's. Higher is the direction the app aims for. Each of the five counts against the repo as it grows — longer files, more escape hatches — so the index climbs when they shrink and drops when they grow. It is the one place the app takes a side; the readings below only report.</p>
        </Explain>
      </div>

      {empty}

      {series && last ? (
        <div className="rh-box hix-box" ref={boxRef}>
          <div className="rh-tile-valrow">
            <span className="rh-tile-val">{Math.round(last.index)}</span>
            <span className="hix-delta">{weekChangeWords(delta, last.week, currentWeek)}</span>
          </div>
          <div className="hix-vs">
            {sinceBaselineWords(last.index)}
            {indexVsWords(vsLast) ? <> · {indexVsWords(vsLast)}</> : null}
          </div>
          {view?.words ? <div className="rh-tile-mean">{view.words.body}</div> : null}

          {g ? (
            <svg ref={svgRef} className="rh-spark" width={width} height={LINE_H + 2} viewBox={`0 0 ${width} ${LINE_H + 2}`}
              role="img"
              aria-label={`Health index over ${points.length} weeks, from ${Math.round(g.lo)} to ${Math.round(g.hi)}; 100 is the baseline week`}
              onPointerDown={(e) => pick(e)} onPointerMove={pick}
              onPointerLeave={(e) => { if (e.pointerType === "mouse") setPicked(null); }}>
              <text className="rh-tick" x={GUTTER - 5} y={Math.min(LINE_H, Math.max(8, g.baseY + 3.5))} textAnchor="end">100</text>
              <g transform={`translate(${GUTTER},0)`}>
                <line x1={0} x2={plotW} y1={g.baseY} y2={g.baseY} stroke="currentColor" strokeOpacity={0.14} strokeWidth={1} strokeDasharray="2 3" />
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

          {at && bars && bars.bars.length ? (
            <div className="hix-bars">
              <div className="rh-cap">{barsCaptionWords(at.week)}</div>
              {/* Three columns — name, track, number — so no word ever sits on a bar or
                  runs off the edge. Bar geometry is in percent of the track. */}
              <div className="hix-bar-rows" role="img" aria-label={bars.bars.map((b) => b.words).join(", ")}>
                {bars.bars.map((b) => (
                  <div key={b.key} className="hix-bar-row" aria-hidden>
                    <span className="hix-barname">{b.name}</span>
                    <span className="hix-track">
                      {b.side === "none" ? null : <span className="hix-bar" style={{ left: `${b.x}%`, width: `${b.w}%` }} />}
                    </span>
                    <span className="hix-barval">{signedTenths(b.value)}</span>
                  </div>
                ))}
                <div className="hix-bar-row hix-bar-axis" aria-hidden>
                  <span />
                  <span className="hix-axis-words"><span>← pulled down</span><span>pushed up →</span></span>
                  <span />
                </div>
              </div>
            </div>
          ) : at && at.lnLink === null ? (
            <div className="rh-cap"><CantInline>{at.gap ? `This week was ${carriedWords(at.gapReason)}; there are no contributions to show.` : "This is the baseline week; contributions start the week after."}</CantInline></div>
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
