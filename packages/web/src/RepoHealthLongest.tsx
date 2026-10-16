/**
 * The longest file: its length over the series, WHICH file it was, and the
 * tape of today's longest files under it.
 *
 * Leads region 2's charts rather than sitting in the magnitudes at the foot:
 * one file carrying an ever larger share of the tree is the shape this sheet
 * exists to make visible, and it was the one figure a reader had to scroll
 * past every tile to find.
 *
 * Geometry is `repoHealthPlot.ts` (`sparkGeom` for the scale, `holderGeom`
 * for who held the crown), words are `repoHealthStackWords.ts`, and the axis,
 * crosshair and pointer rules are the tiles' own, imported rather than copied.
 */
import { useRef, useState } from "react";
import type { RepoHealthLongest, RepoHealthPlotClassics } from "@waterplane/shared";
import { FOLDED_SLOT, MIN_READINGS, holderGeom, nearestPlotted, sparkGeom } from "./repoHealthPlot";
import {
  CURVE_OPACITY, Crosshair, DOT_R, TICK_BASELINE, TICK_H, XAxis, clearsOnLeave, gutterFor, plotX, values,
} from "./RepoHealthTiles";
import { Tape } from "./RepoHealthMags";
import { holderWords, longestCaptionWords, longestPickWords, tapeWords } from "./repoHealthStackWords";
import { seriesValueWords } from "./repoHealthWords";
import { ScrubHint } from "./kit/chart/ScrubHint";
import { SLOT } from "./kit/chart/TokenComposition";
import { HintChip } from "./HintChip";
import { Explain } from "./Explain";

/** Twice a tile's height: this is the chart the region opens on, and a
 *  handover's step needs the room to read as a step and not a kink. */
const LONGEST_H = 64;

/** A folded or unnamed run is INK, like a stack's hueless remainder. */
const strokeFor = (slot: number) => (slot >= 0 && slot < SLOT.length ? SLOT[slot] : "currentColor");
const opacityFor = (slot: number) => (slot === FOLDED_SLOT ? CURVE_OPACITY : 1);

function LongestCurve({ longest, width }: { longest: RepoHealthLongest; width: number }) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  // An index, resolved at paint — `SeriesSpark`'s rule.
  const [pickedIndex, setPickedIndex] = useState<number | null>(null);
  const before = useRef<number | null>(null);

  const { points } = longest;
  const paths = longest.paths ?? null;
  const vals = values(points);
  const probe = width > 0 ? sparkGeom(vals, width, LONGEST_H) : null;
  const yLabels = !probe ? []
    : probe.flat ? [seriesValueWords(probe.hi)]
    : [seriesValueWords(probe.hi), seriesValueWords(probe.lo)];
  const gutter = probe ? gutterFor(yLabels) : 0;
  const plotW = Math.max(1, width - gutter);
  const g = probe ? sparkGeom(vals, plotW, LONGEST_H) : null;
  if (!g) return null;
  // Without per-reading names every point is "unnamed": one ink run, no
  // handovers, and the caption says why.
  const h = holderGeom(paths ?? points.map(() => null), g.pts);

  const pick = (e: { clientX: number }, toggle = false) => {
    const x = plotX(e, svgRef.current, width, gutter);
    if (x == null) return;
    const hit = nearestPlotted(g.pts, x);
    if (!hit) return;
    setPickedIndex(toggle && hit.i === pickedIndex ? null : hit.i);
  };

  const at = pickedIndex == null ? null : g.pts.find((q) => q.i === pickedIndex) ?? null;
  const picked = at ? points[at.i] : null;
  const readout = longestPickWords(picked, at && paths ? paths[at.i] : null, !!paths);
  const boxH = LONGEST_H + TICK_H;
  const folded = h.holders.filter((x) => x.slot === FOLDED_SLOT).length;
  const readings = g.readings;
  const label = "the longest file over time";
  const cap = longestCaptionWords({ handovers: h.handovers.length, folded, unnamed: h.unnamed, named: !!paths });

  return (
    <div className="rh-chart">
      <svg ref={svgRef} className="rh-spark" width={width} height={boxH} viewBox={`0 0 ${width} ${boxH}`}
        onPointerDown={(e) => { before.current = pickedIndex; pick(e, true); }}
        onPointerMove={pick}
        onPointerLeave={(e) => { if (clearsOnLeave(e)) setPickedIndex(null); }}
        onPointerCancel={() => setPickedIndex(before.current)}
        role="img"
        aria-label={`${label}: ${h.holders.length} file${h.holders.length === 1 ? "" : "s"} held the top spot, ${h.handovers.length} change${h.handovers.length === 1 ? "" : "s"}`}>
        <title>{label} over {readings} readings</title>

        {!g.flat ? (
          <>
            <line x1={gutter} x2={width} y1={g.hiY} y2={g.hiY}
              stroke="currentColor" strokeOpacity={0.1} strokeWidth={1} />
            <text className="rh-tick" x={gutter - 5} y={Math.max(8, g.hiY + 3.5)} textAnchor="end">{yLabels[0]}</text>
            <text className="rh-tick" x={gutter - 5} y={Math.min(LONGEST_H - 0.5, g.loY + 3.5)} textAnchor="end">{yLabels[1]}</text>
          </>
        ) : (
          <text className="rh-tick" x={gutter - 5} y={g.hiY + 3.5} textAnchor="end">{yLabels[0]}</text>
        )}

        <g transform={`translate(${gutter},0)`}>
          <line x1={0} x2={plotW} y1={LONGEST_H - 0.5} y2={LONGEST_H - 0.5}
            stroke="currentColor" strokeOpacity={0.14} strokeWidth={1} />
          {/* The step from the old holder's last reading to the new one's
              first: thin and in ink, because it belongs to neither file. */}
          {h.handovers.map((s) => (
            <line key={`s${s.i}`} x1={s.fromX} y1={s.fromY} x2={s.x} y2={s.y}
              stroke="currentColor" strokeOpacity={0.35} strokeWidth={1} />
          ))}
          {h.runs.map((r, k) => r.d ? (
            <path key={k} d={r.d} fill="none" stroke={strokeFor(r.slot)} strokeOpacity={opacityFor(r.slot)}
              strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
          ) : r.dot ? (
            <circle key={k} cx={r.dot.x} cy={r.dot.y} r={1.8} fill={strokeFor(r.slot)} fillOpacity={opacityFor(r.slot)} />
          ) : null)}
          {/* The handover itself: a ring in the NEW holder's hue where its
              line begins. Solid, never dashed — dashes mean a threshold. */}
          {h.handovers.map((s) => (
            <circle key={`h${s.i}`} cx={s.x} cy={s.y} r={4} fill="var(--panel)"
              stroke={strokeFor(s.slot)} strokeWidth={2} />
          ))}
          <circle cx={g.endX} cy={g.endY} r={DOT_R + 1} fill="var(--panel)" />
          <circle cx={g.endX} cy={g.endY} r={DOT_R} fill="var(--accent)" />
        </g>

        <XAxis points={points} w={plotW} y={LONGEST_H + TICK_BASELINE} gutter={gutter} />
        {at ? <Crosshair at={at} h={LONGEST_H} gutter={gutter} /> : null}
      </svg>
      <div className="rh-scrub">{readout ?? <ScrubHint />}</div>
      {h.holders.length ? (
        <ul className="rh-legend rh-legend-rows">
          {h.holders.map((x) => (
            <li key={x.path}>
              <span className="rh-swatch rh-swatch-line"
                style={{ background: strokeFor(x.slot), opacity: opacityFor(x.slot) }} aria-hidden />
              {holderWords(x, points[x.first]?.day, points[x.last]?.day, readings)}
            </li>
          ))}
        </ul>
      ) : null}
      {/* An absence in the open; the method behind a closed `Explain` — it
          was four sentences on every visit beside a `?` that names the hues. */}
      {cap.lead ? <div className="rh-cap">{cap.lead}</div> : null}
      <div className="rh-cap">
        <Explain of="the longest-file chart" label="how it is drawn">{cap.more}</Explain>
      </div>
    </div>
  );
}

/**
 * The longest-file section: the curve and today's tape, together at the top.
 *
 * Null when neither can be drawn — an older engine sends no `longest` and a
 * tree with no sizes sends no tape, and the magnitudes further down still
 * print what they have.
 */
export function LongestFiles({ longest, classics, p95, width, onOpenFile }: {
  longest: RepoHealthLongest | undefined;
  classics: RepoHealthPlotClassics;
  p95: number | null;
  width: number;
  onOpenFile?: (path: string) => void;
}) {
  const readings = longest ? longest.points.reduce((n, p) => (p.v == null ? n : n + 1), 0) : 0;
  const curve = longest && readings >= MIN_READINGS && width > 0;
  const tape = classics.tape && classics.tape.length ? classics.tape : null;
  if (!curve && !tape) return null;
  const last = longest?.points.length ? longest.points[longest.points.length - 1].v : null;
  const files = classics.files.length ? classics.files[classics.files.length - 1].v : null;
  return (
    <div className="rh-longest">
      <div className="rh-tile-head">
        <span className="rh-tile-label">the longest file <HintChip id="repohealth.longest" of="the longest file over time" /></span>
      </div>
      {last != null ? (
        <div className="rh-tile-val">
          {seriesValueWords(last, "lines")}
          {longest?.path ? <span className="rh-longest-path"> · {longest.path}</span> : null}
        </div>
      ) : null}
      {curve && longest ? <LongestCurve longest={longest} width={width} /> : null}
      {/* The longest file is said ONCE: on the value line above when there is
          one, so the tape's caption leaves it out; only with no value line
          does the caption carry it. */}
      {tape ? (
        <Tape tape={tape} paths={classics.tapePaths ?? null} width={width} onOpenFile={onOpenFile}
          caption={tapeWords(tape.length, last != null ? null : tape[0] ?? null, p95, files, longest?.path ?? null)} />
      ) : null}
    </div>
  );
}
