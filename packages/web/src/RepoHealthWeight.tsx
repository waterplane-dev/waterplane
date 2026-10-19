import type { RepoHealthArea, RepoHealthPlotContext, RepoHealthPlotSeries } from "@waterplane/shared";
import { dumbbellGeom } from "./repoHealthPlot";
import { areaRowWords, areaSpreadWords, seriesValueWords } from "./repoHealthWords";
import { useBoxWidth } from "./kit/chart/useBoxWidth";
import { TILES_MORE_SUMMARY, areaAbsentWords } from "./repoHealthTileWords";
import { HintChip } from "./HintChip";
import { TICK_BASELINE, TICK_H } from "./RepoHealthChartKit";
import { WeightStack } from "./RepoHealthStack";

// ── the per-area spread ────────────────────────────────────────────────────

const DUMB_ROW_H = 30;

/**
 * Per area, on the latest reading: where a change usually lands and how far it
 * can reach.
 *
 * A dumbbell because the pair is a before→after per item, and it is the only
 * form that keeps BOTH numbers visible: two bars invite reading the difference
 * as a stack, and a bar of the difference hides the magnitude both ends are a
 * fraction of. One x scale across the rows, because the comparison is between
 * areas.
 */
export function AreaSpread({ areas, width }: {
  areas: Record<string, RepoHealthArea>;
  width: number;
}) {
  const keys = Object.keys(areas);
  if (!keys.length || width <= 0) return null;
  // A label gutter in the SVG rather than a column beside it: the bars have to
  // share one scale, and a flex row would let the longest name shorten them.
  const gutter = Math.min(84, Math.max(56, Math.round(width * 0.22)));
  const g = dumbbellGeom(
    keys.map((k) => ({ key: k, label: k, from: areas[k].expected, to: areas[k].ceiling })),
    width - 6, DUMB_ROW_H, gutter,
  );
  // The rows need a SCALE of their own, and not only to be readable. This
  // chart is drawn directly under a time series whose x axis is labelled with
  // days, and an unlabelled row of marks inherits the axis above it in the
  // eye: a bar from the middle of the box to the right edge reads as "host,
  // from 6 Sep to 21 Sep". Nothing in the geometry was wrong; the frame was
  // missing. Zero at the gutter and the shared maximum at the right edge —
  // both ends, because these are magnitudes on a zero-based scale and the far
  // label is what makes the zero mean something.
  const boxH = g.height + TICK_H;
  const right = width - 6;
  return (
    <div className="rh-chart">
      <div className="rh-chart-head">
        <span className="rh-chart-label">what a change carries, per area</span>
        <HintChip id="repohealth.areas" of="the per-area spread" />
      </div>
      <svg width={width} height={boxH} viewBox={`0 0 ${width} ${boxH}`} role="img"
        aria-label={`always-on weight per area, up to ${seriesValueWords(g.max, "chars")}`}>
        <title>per-area always-on weight, latest reading</title>
        {g.rows.map((r) => {
          const a = areas[r.key];
          const lo = r.x1;
          const hi = r.x2;
          return (
            <g key={r.key}>
              <text x={0} y={r.y} dominantBaseline="middle" className="rh-axis-label">{r.label}</text>
              {lo != null && hi != null ? (
                <line x1={lo} x2={hi} y1={r.y} y2={r.y} stroke="var(--chart-1)" strokeOpacity={0.35}
                  strokeWidth={3} strokeLinecap="round" />
              ) : null}
              {/* Two shades of one hue: the near end hollow, the far end solid.
                  A surface ring keeps them apart where an area's two numbers
                  are the same and the marks land on top of each other. */}
              {lo != null ? (
                <circle cx={lo} cy={r.y} r={4.5} fill="var(--panel)"
                  stroke="var(--chart-1)" strokeWidth={2} />
              ) : null}
              {hi != null ? (
                <circle cx={hi} cy={r.y} r={4.5} fill="var(--chart-1)"
                  stroke="var(--panel)" strokeWidth={1.5} />
              ) : null}
              <title>{r.label} — {areaRowWords(a)}</title>
            </g>
          );
        })}
        <line x1={gutter} x2={right} y1={g.height + 0.5} y2={g.height + 0.5}
          stroke="var(--fg)" strokeOpacity={0.12} strokeWidth={1} />
        <text className="rh-tick" x={gutter} y={g.height + TICK_BASELINE} textAnchor="start">0</text>
        <text className="rh-tick" x={right} y={g.height + TICK_BASELINE} textAnchor="end">
          {seriesValueWords(g.max, "chars")}
        </text>
      </svg>
      <ul className="rh-legend">
        <li><span className="rh-swatch rh-swatch-hollow" aria-hidden />what a change there usually carries</li>
        <li><span className="rh-swatch rh-swatch-dot" style={{ background: "var(--chart-1)" }} aria-hidden />with every one of its bodies loaded</li>
      </ul>
      {/* Rows in words + method fold; each row's words are also its mark's title. */}
      <details className="hint-more rh-more">
        <summary>{TILES_MORE_SUMMARY}</summary>
        <ul className="rh-rows">
          {keys.map((k) => (
            <li key={k}><span className="rh-rows-key">{k}</span> {areaRowWords(areas[k])}</li>
          ))}
        </ul>
        <p>{areaSpreadWords()}</p>
      </details>
    </div>
  );
}

/**
 * The weight card (jump-nav target `#rh-weight`): the always-on weight stack,
 * then the per-area spread — or, in the OPEN, why there is none
 * (`areaAbsentWords`, three states). Measures its own content box, so the
 * caller passes data and no width.
 */
export function WeightCard({ claudeMd, descriptions, context, width }: {
  claudeMd: RepoHealthPlotSeries | null;
  descriptions: RepoHealthPlotSeries | null;
  context: RepoHealthPlotContext;
  /** First paint's guess only; the card measures itself. */
  width?: number;
}) {
  const [boxW, boxRef] = useBoxWidth();
  const w = boxW || width || 0;
  const absent = areaAbsentWords(context);
  return (
    <div className="rh-card" id="rh-weight" ref={boxRef}>
      <WeightStack claudeMd={claudeMd} descriptions={descriptions} width={w} />
      {absent ? <div className="rh-cap">{absent}</div> : <AreaSpread areas={context.areas} width={w} />}
    </div>
  );
}
