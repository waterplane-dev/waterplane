import { useRef, useState, type ReactNode } from "react";
import type { RepoHealthPoint } from "@waterplane/shared";
import { nearestPlotted, stackGeom, type StackInput } from "./repoHealthPlot";
import { seriesValueWords, stackReadoutWords } from "./repoHealthWords";
import { TILES_MORE_SUMMARY } from "./repoHealthTileWords";
import { weightStackWords } from "./repoHealthStackWords";
import { SLOT } from "./kit/chart/TokenComposition";
import { HintChip } from "./HintChip";
import { TICK_BASELINE, TICK_H, XAxis, Crosshair, clearsOnLeave, gutterFor, plotX, values } from "./RepoHealthChartKit";
import type { RepoHealthPlotSeries } from "@waterplane/shared";

/** The band with no hue of its own — the folded tail, drawn in ink. */
const foldedFill = "var(--muted)";
const fillFor = (slot: number) => (slot >= 0 && slot < SLOT.length ? SLOT[slot] : foldedFill);

// ── stacked bands over time ────────────────────────────────────────────────

const STACK_H = 96;

/**
 * Any number of series that add up, over the reading index.
 *
 * ONE implementation, used by the always-on weight and by the lines-per-
 * package split. They are the same chart with different bands, and a second
 * copy would be a second crosshair, a second axis and a second idea of what a
 * missing column means — the kind of fork this repo spends its rules on. What
 * differs between the two callers is passed in: the bands, the unit, the word
 * for the top edge, and the caption.
 *
 * The axis is ZERO-BASED, unlike a tile's, because the quantity IS a total:
 * a fitted floor would cut the bottom band off.
 */
export function StackChart({ inputs, points, unit, totalLabel, label, width, caption, more, hint }: {
  inputs: readonly StackInput[];
  /** The x axis and the crosshair's day and sha. Every `values` array is the
   *  same length as this by construction — one row per reading. */
  points: readonly RepoHealthPoint[];
  unit: string;
  /** What the top edge is called in the legend: "the total", "all packages". */
  totalLabel: string;
  /** Name of the whole chart — the accessible one, and now the drawn one too:
   *  the `?` beside it needs a subject, and a lone question mark floating over
   *  a chart is a control with nothing to be about. */
  label: string;
  width: number;
  caption?: ReactNode;
  /** Method prose: folded into `details.hint-more` under the legend. An
   *  absence never goes here — that is `caption`, in the open. */
  more?: ReactNode;
  hint: string;
}) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  // An index, for the reason `SeriesSpark` gives: pixels held across a width
  // change describe the previous geometry.
  const [pickedIndex, setPickedIndex] = useState<number | null>(null);
  const before = useRef<number | null>(null);

  // Same two passes as a tile's curve, for the same reason — except the top
  // label is the only one that has to be measured: the bottom of a stack is
  // zero by definition (see `stackGeom`), and `0` is never the widest string.
  const probe = inputs.length && width > 0 ? stackGeom(inputs, width, STACK_H) : null;
  const gutter = probe ? gutterFor([seriesValueWords(probe.top)]) : 0;
  const plotW = Math.max(1, width - gutter);
  const g = gutter ? stackGeom(inputs, plotW, STACK_H) : probe;

  const pick = (e: { clientX: number }, toggle = false) => {
    if (!g) return;
    const x = plotX(e, svgRef.current, width, gutter);
    if (x == null) return;
    const hit = nearestPlotted(g.pts, x);
    if (!hit) return;
    setPickedIndex(toggle && hit.i === pickedIndex ? null : hit.i);
  };

  // The x labels come from `points` and the geometry from `inputs`; they are
  // the same length by construction, and if they ever are not, the day under
  // a column is the wrong day. Refusing is the only answer that cannot draw a
  // mislabelled axis — `stackGeom` refuses a ragged `inputs` set for the same
  // reason one line up.
  if (!g || width <= 0 || points.length !== inputs[0].values.length) return null;
  const at = pickedIndex == null ? null : g.pts.find((q) => q.i === pickedIndex) ?? null;
  const total = g.totals[g.totals.length - 1];
  const boxH = STACK_H + TICK_H;
  // Untouched, the readout names the LATEST column; the drag instruction is
  // the region's, printed once (`SCRUB_HINT`).
  const shown = at ?? g.pts[g.pts.length - 1] ?? null;
  const readout = shown
    ? stackReadoutWords(
        points[shown.i],
        inputs.map((b) => ({ label: b.label, v: b.values[shown.i] ?? null })),
        g.totals[shown.i] ?? null,
        unit,
      )
    : null;
  return (
    <div className="rh-chart">
      <div className="rh-chart-head">
        <span className="rh-chart-label">{label}</span>
        <HintChip id={hint} of={label} />
      </div>
      <svg ref={svgRef} className="rh-spark" width={width} height={boxH} viewBox={`0 0 ${width} ${boxH}`}
        onPointerDown={(e) => { before.current = pickedIndex; pick(e, true); }}
        onPointerMove={pick}
        onPointerLeave={(e) => { if (clearsOnLeave(e)) setPickedIndex(null); }}
        onPointerCancel={() => setPickedIndex(before.current)}
        role="img"
        aria-label={`${label}, ${seriesValueWords(total, unit)} at the last reading`}>
        <title>{label} over {g.totals.length} readings</title>

        {/* Both labels only when the top is ABOVE the floor. A stack whose
            every column is zero has `topY === zeroY`, and two labels both
            reading `0` drawn on top of each other is a smudge that looks
            like a rendering fault rather than like a total of nothing. */}
        {g.top > 0 ? (
          <text className="rh-tick" x={gutter - 5} y={Math.max(8, g.topY + 3.5)} textAnchor="end">
            {seriesValueWords(g.top)}
          </text>
        ) : null}
        <text className="rh-tick" x={gutter - 5} y={Math.min(STACK_H - 0.5, g.zeroY + 3.5)} textAnchor="end">
          0
        </text>

        <g transform={gutter ? `translate(${gutter},0)` : undefined}>
          {g.bands.map((b) => (
            <g key={b.key}>
              {b.d ? <path d={b.d} fill={fillFor(b.slot)} fillOpacity={0.85} /> : null}
              {b.stubs.map((st, i) => (
                <rect key={i} x={st.x - 0.75} y={st.y1} width={1.5} height={Math.max(1, st.y0 - st.y1)}
                  fill={fillFor(b.slot)} fillOpacity={0.85} />
              ))}
            </g>
          ))}
          {/* The top edge is the total, and it stays a LINE: the stack's shape
              is the split, the line is the number. */}
          {g.topLine ? (
            <path d={g.topLine} fill="none" stroke="var(--fg)" strokeOpacity={0.5} strokeWidth={1.5}
              strokeLinecap="round" strokeLinejoin="round" />
          ) : null}
        </g>

        <XAxis points={points} w={plotW} y={STACK_H + TICK_BASELINE} gutter={gutter} />
        {at ? <Crosshair at={at} h={STACK_H} gutter={gutter} /> : null}
      </svg>
      <div className="rh-scrub">{readout}</div>
      <ul className="rh-legend">
        {g.bands.map((b) => (
          <li key={b.key}>
            <span className="rh-swatch" style={{ background: fillFor(b.slot) }} aria-hidden />
            {b.label} — {seriesValueWords(b.last, unit)}
          </li>
        ))}
        <li>
          <span className="rh-swatch rh-swatch-line" aria-hidden />
          {totalLabel} — {seriesValueWords(total, unit)}
        </li>
      </ul>
      {caption ? <div className="rh-cap">{caption}</div> : null}
      {more ? (
        <details className="hint-more rh-more">
          <summary>{TILES_MORE_SUMMARY}</summary>
          {more}
        </details>
      ) : null}
    </div>
  );
}

/**
 * CLAUDE.md and the skill descriptions, stacked, over the whole series.
 *
 * The one chart here that prints a TOTAL, so it prints it as a split in the
 * same mark: the top edge IS the sum and the two bands underneath are what it
 * is made of. A total without its split is the failure `TokenComposition.tsx`
 * exists to prevent one screen over.
 *
 * Null when the two series are not both present — a stack of one band is a
 * chart that looks like a total and is not one.
 */
export function WeightStack({ claudeMd, descriptions, width }: {
  claudeMd: RepoHealthPlotSeries | null;
  descriptions: RepoHealthPlotSeries | null;
  width: number;
}) {
  if (!claudeMd || !descriptions) return null;
  return (
    <StackChart
      inputs={[
        { key: claudeMd.key, label: claudeMd.label, slot: 0, values: values(claudeMd.points) },
        { key: descriptions.key, label: descriptions.label, slot: 1, values: values(descriptions.points) },
      ]}
      points={claudeMd.points}
      unit="chars"
      totalLabel="the total"
      label="always-on weight"
      width={width}
      more={weightStackWords()}
      hint="repohealth.weight"
    />
  );
}
