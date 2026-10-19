/**
 * The repo-health series, drawn.
 *
 * Geometry is `repoHealthPlot.ts` and every sentence is `repoHealthWords.ts`;
 * this file emits SVG and the chrome immediately around it, and nothing else.
 * No charting library — the same decision `ContextGraph.tsx` records, for the
 * same reasons: a library brings its own axis conventions, its own colours and
 * its own idea of what a missing point means, and the one thing these charts
 * must not do is invent a reading.
 *
 * ── The visual contract, which was chosen rather than picked ───────────────
 *
 *  - **A tile is a value first and a curve second.** The form is the stat tile
 *    the dataviz table gives for "a current value plus a trend": the number is
 *    the answer, the sparkline is the context, and a tile whose series cannot
 *    be drawn still prints its number. A sparkline alone says "rising" and
 *    never "rising to what".
 *  - **The curve is INK at reduced opacity, and the end dot is `--accent`.**
 *    Deliberately not `--ctx-series`: that blue means "this conversation's
 *    tokens" on the launcher rows, the context sheet and the all-sessions
 *    screen, and wearing it here would claim these curves are about the same
 *    entity. The end dot carries a `var(--panel)` ring so it stays separable
 *    where it lands on the line.
 *  - **No status colour anywhere.** No `--warn`, no `--dead`, no band, no zone,
 *    no red region. A reading compared to its own past has no side to be on:
 *    rising lines and rising escape hatches are opposite news, and a hue would
 *    choose for the reader. The slope is a glyph in `currentColor` with its own
 *    word beside it.
 *  - **Dashes are reserved for thresholds**, which is why the p95 and the
 *    longest file are printed as words under the tape rather than drawn as
 *    rules over it. Nobody chose either number.
 *  - **The categorical slots are `TokenComposition.tsx`'s `SLOT`**, validated
 *    as a set against both themes by `theme.test.mjs`. Four, never a generated
 *    fifth: anything past the fourth entity folds into one band drawn in ink
 *    and named in the legend.
 *  - **Every SVG takes a MEASURED width**, like `ContextChart` — never a fixed
 *    viewBox stretched with `preserveAspectRatio="none"`, which distorts the
 *    stroke and the text along with the curve on the one device that rotates.
 *
 * ── What this file may not do ──────────────────────────────────────────────
 *
 * Decide a number. The rank, the slope, the window and the order of the tape
 * are the tool's, computed in `tools/repohealth/` beside its frozen constants.
 * If a chart here wants a figure the wire does not carry, the figure is added
 * to the tool.
 */
import { useRef, useState, type ReactNode } from "react";
import { ChevronUp, Minus, Send, TrendingDown, TrendingUp } from "lucide-react";
import type { RepoHealthPlotSeries, RepoHealthPoint } from "@waterplane/shared";
import { MIN_READINGS, nearestPlotted, sparkGeom } from "./repoHealthPlot";
import {
  pointReadoutWords, rankSentence, rankChipWords, kpiMeaning,
  seriesValueWords, slopeWords, tileAbsentWords, variantHidesChart, variantWords,
  SERIES_ASK_ALL_LABEL, SERIES_ASK_LABEL, plotAxisModeWords, rankBasisWords, seriesAskNoteWords,
} from "./repoHealthWords";
import { useBoxWidth } from "./kit/chart/useBoxWidth";
import { latestIndex, openAmong, sparkAreaPath, toggleOpen } from "./repoHealthTileGeom";
import { TILES_MORE_SUMMARY, TILE_FOLD_LABEL, tileToggleTitle } from "./repoHealthTileWords";
import type { HealthAxisMode } from "./healthIndexWords";
import { HintChip } from "./HintChip";
import {
  CURVE_OPACITY, DOT_R, TICK_BASELINE, TICK_H, Crosshair, XAxis, clearsOnLeave, gutterFor, plotX, values,
} from "./RepoHealthChartKit";

// The chart marks, the stack and the weight card live beside this file; every name stays importable from here.
export { CURVE_OPACITY, DOT_R, TICK_BASELINE, TICK_H, Crosshair, XAxis, clearsOnLeave, gutterFor, plotX, values } from "./RepoHealthChartKit";
export { StackChart, WeightStack } from "./RepoHealthStack";
export { AreaSpread, WeightCard } from "./RepoHealthWeight";

/** The height of a tile's sparkline. Two more pixels than it needs, so the end
 *  dot's ring is fully inside the box at either extreme. */
const SPARK_H = 32;
/** An open tile's curve: room for the crosshair ring and the day ticks. */
const SPARK_OPEN_H = 48;

/**
 * Every metric on this sheet carries its own `?`.
 *
 * A tile's id is `repohealth.` plus the tool's own series key, so a series
 * added to `tools/repohealth/narrate.mjs` needs no edit here — only an entry
 * in the catalog, which a test insists on.
 */
const hintOf = (key: string) => `repohealth.${key}`;

// ── the trend half of a stat tile ──────────────────────────────────────────

/**
 * One series as a curve, x by reading index.
 *
 * Null when there is not enough to draw — the caller prints the absence in
 * words instead, because an empty box with an axis is a chart claiming to show
 * a series that was never measured.
 */
export function SeriesSpark({ points, width, height = SPARK_H, label, unit = "", axes = false, bounds = false, area = false, onPick }: {
  points: readonly RepoHealthPoint[];
  width: number;
  height?: number;
  /** For the accessible name. The readout is printed beside the curve, so this
   *  is a description and never the only place a number appears. */
  label: string;
  /** Appended to the crosshair's value. The y labels go WITHOUT it — a unit
   *  repeated on both ends of an axis is the same word twice in the tightest
   *  space on the tile, and the value above already carries it. */
  unit?: string;
  /**
   * Draw the y labels, the day ticks and the crosshair.
   *
   * Off by default, and the default is the interesting case: the 96×18
   * miniature inside a checklist row has no room for any of it, and it is a
   * second look at a number that row already prints in full. Axes there would
   * be three unreadable labels claiming to be a scale.
   */
  axes?: boolean;
  /**
   * Print the fitted low and high up the left WITHOUT the day ticks or the
   * crosshair — the compact grid tile. A fitted axis with no labels reads as a
   * zero-based one, so even the smallest tile that is a chart says its range;
   * it takes no pointer, because the tap there opens the tile.
   */
  bounds?: boolean;
  /** The wash under the curve (`sparkAreaPath`): none for a flat series. */
  area?: boolean;
  /**
   * The reading under the crosshair, reported UP.
   *
   * The readout is a line of text under the chart rather than a floating box
   * inside it — `ContextChart`'s rule, for its reasons: an SVG tooltip cannot
   * wrap, and on a phone a box that follows the finger is under the finger.
   *
   * The INDEX travels, not the point: the caller resolves it against the same
   * `points` it passed in, on the same render, so the ring and the sentence
   * are provably about one day even after a refresh appends rows.
   */
  onPick?: (i: number | null) => void;
}) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  // The selection is an INDEX, and the pixels are derived from it at every
  // render. Held as a `Plotted` it survives a width change — the phone
  // rotating, the sheet resizing — and then the ring is painted at last
  // orientation's coordinates while the readout still names the old day: a
  // chart whose two halves disagree about which point they are describing.
  // `ContextChart` stores the SAMPLE and calls `p.px(...)` at paint for the
  // same reason.
  const [pickedIndex, setPickedIndex] = useState<number | null>(null);
  // What was selected when the current gesture began, so a gesture the
  // browser takes away can be undone rather than landing as a choice.
  const before = useRef<number | null>(null);

  const vals = values(points);
  // TWO passes, on purpose. The gutter has to be wide enough for the y labels,
  // the y labels are this series' own low and high, and only `sparkGeom` knows
  // those — so the first pass is measured for its domain and thrown away, and
  // the second is drawn at the width left over. Both are pure and the series
  // is a couple of dozen points; the alternative is a second copy of the
  // low/high scan living here, which is the one thing this file may not hold.
  const probe = sparkGeom(vals, width, height);
  const yLabels = !probe ? []
    : probe.flat ? [seriesValueWords(probe.hi)]
    : [seriesValueWords(probe.hi), seriesValueWords(probe.lo)];
  const showY = axes || bounds;
  const gutter = showY && probe ? gutterFor(yLabels) : 0;
  // ONE plot width, shared by the geometry, the floor and the ticks. Computed
  // twice it is a clamp in one place and a negative number in the other, and
  // the two disagree exactly where a box is narrower than its own gutter.
  const plotW = Math.max(1, width - gutter);
  const g = gutter ? sparkGeom(vals, plotW, height) : probe;

  const choose = (i: number | null) => {
    setPickedIndex(i);
    // An index, not a point: the caller looks it up in the SAME `points` it
    // handed down, so the words under the chart and the ring on it cannot
    // end up describing two different days.
    onPick?.(i);
  };
  const pick = (e: { clientX: number }, toggle = false) => {
    if (!g) return;
    const x = plotX(e, svgRef.current, width, gutter);
    if (x == null) return;
    const hit = nearestPlotted(g.pts, x);
    if (!hit) return;
    // A second tap on the reading already chosen puts the chart back — a
    // selection with no way out is the same shape of problem as a control
    // that cannot be un-pressed, and on touch nothing else ever clears it.
    choose(toggle && hit.i === pickedIndex ? null : hit.i);
  };
  const clear = (e: { pointerType?: string }) => {
    if (!clearsOnLeave(e)) return;
    choose(null);
  };

  if (!g) return null;
  const at = pickedIndex == null ? null : g.pts.find((q) => q.i === pickedIndex) ?? null;
  const first = points[0]?.day;
  const last = points[points.length - 1]?.day;
  const title =
    `${label}: ${g.readings} reading${g.readings === 1 ? "" : "s"}` +
    (g.holes ? ` and ${g.holes} day${g.holes === 1 ? "" : "s"} with none` : "") +
    (first && last ? `, ${first} to ${last}` : "") +
    (g.flat
      ? " — unchanged across the series, drawn at mid-height"
      : `, ${seriesValueWords(g.lo, unit)} to ${seriesValueWords(g.hi, unit)}`);
  const boxH = height + (axes ? TICK_H : 0);
  return (
    <svg ref={svgRef} className="rh-spark" width={width} height={boxH} viewBox={`0 0 ${width} ${boxH}`}
      onPointerDown={axes ? (e) => { before.current = pickedIndex; pick(e, true); } : undefined}
      onPointerMove={axes ? pick : undefined}
      onPointerLeave={axes ? clear : undefined}
      // A gesture the browser TAKES BACK must not land as a choice: a vertical
      // scroll beginning over a tile fires pointerdown (which picks) and then
      // pointercancel once the pan is claimed, so without the restore,
      // scrolling past six charts silently re-picks all six.
      onPointerCancel={axes ? () => choose(before.current) : undefined}
      role="img" aria-label={title}><title>{title}</title>

      {/* The y axis is this series' OWN low and high, never zero — six tiles
          carry six units and a shared or zero-based axis across them would be
          a claim that they are comparable. Which is exactly why the two
          numbers are PRINTED: a fitted axis with no labels reads as a
          zero-based one, and every rise on it looks like a doubling. */}
      {showY && !g.flat ? (
        <>
          <line x1={gutter} x2={width} y1={g.hiY} y2={g.hiY}
            stroke="currentColor" strokeOpacity={0.1} strokeWidth={1} />
          <text className="rh-tick" x={gutter - 5} y={Math.max(8, g.hiY + 3.5)} textAnchor="end">
            {yLabels[0]}
          </text>
          <text className="rh-tick" x={gutter - 5} y={Math.min(height - 0.5, g.loY + 3.5)} textAnchor="end">
            {yLabels[1]}
          </text>
        </>
      ) : null}
      {/* A flat series has ONE value, so it gets one label on the line it sits
          on. Two identical numbers on two edges would read as a span. */}
      {showY && g.flat ? (
        <text className="rh-tick" x={gutter - 5} y={g.hiY + 3.5} textAnchor="end">{yLabels[0]}</text>
      ) : null}

      <g transform={gutter ? `translate(${gutter},0)` : undefined}>
        {/* The floor. A hairline in ink at low alpha: without it a shallow curve
            and an empty box look the same at 32 px tall. */}
        <line x1={0} x2={plotW} y1={height - 0.5} y2={height - 0.5}
          stroke="currentColor" strokeOpacity={0.14} strokeWidth={1} />
        {area && g.d ? (
          <path d={sparkAreaPath(g.d, height - 0.5, g.flat)} fill="currentColor" fillOpacity={0.07} stroke="none" />
        ) : null}
        {g.d ? (
          <path d={g.d} fill="none" stroke="currentColor" strokeOpacity={CURVE_OPACITY}
            strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
        ) : null}
        {/* Readings with no neighbour to join. Visible, because the alternative
            is a gappy series rendering as an empty box. */}
        {g.dots.map((p, i) => (
          <circle key={i} cx={p.x} cy={p.y} r={1.6} fill="currentColor" fillOpacity={CURVE_OPACITY} />
        ))}
        <circle cx={g.endX} cy={g.endY} r={DOT_R + 1} fill="var(--panel)" />
        <circle cx={g.endX} cy={g.endY} r={DOT_R} fill="var(--accent)" />
      </g>

      {axes ? (
        <XAxis points={points} w={plotW} y={height + TICK_BASELINE} gutter={gutter} />
      ) : null}
      {axes && at ? <Crosshair at={at} h={height} gutter={gutter} /> : null}
    </svg>
  );
}

/** The slope, as a glyph and a word. `currentColor` on purpose — see the
 *  header. Absent rather than neutral-looking when the tool gave none. */
function Slope({ slope }: { slope: RepoHealthPlotSeries["reading"]["slope"] }) {
  const word = slopeWords(slope);
  if (!word) return null;
  const Glyph = slope === "rising" ? TrendingUp : slope === "falling" ? TrendingDown : Minus;
  return (
    <span className="rh-slope"><Glyph size={14} aria-hidden /> {word}</span>
  );
}

/**
 * One stat tile: the value, the trend, and what the tool reads into it.
 *
 * Two shapes, one component, so a reading is drawn one way wherever it is.
 * Given `onToggle` it is a GRID tile: COMPACT until opened — label and `?`,
 * the value, the slope, a 32px curve with its fitted range printed and NO
 * pointer handlers (the tap opens the tile; a scrub there would fight it) —
 * then spanning both columns with the full anatomy below. Without `onToggle`
 * it is always the full tile: the VS Code view and any single-column caller.
 *
 * Each tile measures its OWN plot box (`useBoxWidth`, content box): a grid
 * column is not the region's width. `width` is only the first paint's guess.
 * `actions` is a slot, so this file knows nothing about sending — a chart
 * module that cannot reach a send path cannot become one that applies itself.
 */
export function SeriesTile({ s, width, actions, means, open, onToggle }: {
  s: RepoHealthPlotSeries;
  width?: number;
  actions?: ReactNode;
  /** A repo's OWN reading: its declared sentence stands where waterplane's
   *  catalog meaning and `?` would, since the catalog knows nothing about it. */
  means?: string;
  /** Grid tiles only: whether this one is the open one (state in the grid). */
  open?: boolean;
  onToggle?: () => void;
  /** The region's x mode, for wording only — the caller hands the points
   *  already folded (weeks) or whole (commits); nothing here re-folds them. */
  axis?: HealthAxisMode;
}) {
  const [boxW, boxRef] = useBoxWidth();
  const w = boxW || width || 0;
  // The INDEX the crosshair is on, resolved against `s.points` on the same
  // render the ring is drawn from — see `SeriesSpark`'s `onPick`.
  const [pickedIndex, setPickedIndex] = useState<number | null>(null);
  const grid = !!onToggle;
  const vals = values(s.points);
  const readings = vals.reduce<number>((n, v) => (v == null ? n : n + 1), 0);
  // A reading the repo DISABLED says so where its curve would be, and draws
  // none: a chart under "left out of the index" invites reading it as an input.
  const variant = s.variant ? variantWords(s.variant) : null;
  const hidden = variantHidesChart(s.variant);
  // `sparkGeom` returns null on exactly this condition, so the tile knows
  // whether a curve exists WITHOUT a second geometry pass.
  const canDraw = readings >= MIN_READINGS && !hidden;
  const drawn = canDraw && w > 0;
  const absent = hidden ? null : tileAbsentWords({ absent: s.absent, readings, minToDraw: MIN_READINGS });
  const toggle = () => { setPickedIndex(null); onToggle?.(); };

  // The head: in the grid the NAME is the toggle (`aria-expanded`), and in a
  // compact tile its hit area is stretched over the whole tile by CSS — the
  // `?` sits beside it, never inside (a button in a button is invalid).
  const head = (
    <div className="rh-tile-head">
      {grid ? (
        <button type="button" className="rh-tile-toggle" aria-expanded={!!open}
          title={tileToggleTitle(s.label, !!open)} onClick={toggle}>
          <span className="rh-tile-label">{s.label}</span>
        </button>
      ) : <span className="rh-tile-label">{s.label}</span>}
      {means === undefined ? <HintChip id={hintOf(s.key)} of={s.label} /> : null}
    </div>
  );
  // The plot box exists whenever a curve CAN be drawn: it is what is measured,
  // so gating it on the measurement would leave the width 0 for ever.
  const plot = (axes: boolean) => canDraw ? (
    <div className="rh-tile-plot" ref={boxRef}>
      {drawn ? (axes
        ? <SeriesSpark points={s.points} width={w} height={SPARK_OPEN_H} label={s.label} unit={s.unit} axes area
            onPick={setPickedIndex} />
        : <SeriesSpark points={s.points} width={w} label={s.label} unit={s.unit} bounds area />) : null}
    </div>
  ) : null;

  if (grid && !open) {
    return (
      <li className="rh-tile">
        {head}
        <div className="rh-tile-valrow">
          <span className="rh-tile-val">{seriesValueWords(s.last, s.unit)}</span>
          <Slope slope={s.reading.slope} />
        </div>
        {plot(false)}
        {/* Absences never fold: a compact tile still says why it has no curve. */}
        {hidden && variant ? <div className="rh-tile-variant">{variant.lead}</div> : null}
        {absent ? <div className="rh-tile-absent">{absent}</div> : null}
      </li>
    );
  }

  // The rank rides beside the value as a chip; the SENTENCE survives only
  // where there is no rank, because then it is the tool's reason and the
  // chip has nothing honest to say.
  const chip = rankChipWords(s.reading);
  const reading = chip ? null : rankSentence(s.reading);
  const meaning = means ?? kpiMeaning(s.key);
  // Untouched, the readout names the LATEST reading; the one drag instruction
  // is the region's (`SCRUB_HINT`, printed once above every chart).
  const shownIndex = pickedIndex ?? latestIndex(vals);
  const shown = shownIndex == null ? null : s.points[shownIndex] ?? null;
  return (
    <li className={grid ? "rh-tile open" : "rh-tile"}>
      {head}
      {meaning ? <div className="rh-tile-mean">{meaning}</div> : null}
      {/* The repo's say over this reading, ON its tile, attributed to the repo
          — once here, never as a badge. */}
      {variant ? (
        <div className="rh-tile-variant">
          <div>{variant.lead}</div>
          {variant.why ? <div>{variant.why}</div> : null}
          {variant.absent ? <div>{variant.absent}</div> : null}
        </div>
      ) : null}
      <div className="rh-tile-valrow">
        <span className="rh-tile-val">{seriesValueWords(s.last, s.unit)}</span>
        <Slope slope={s.reading.slope} />
        {chip ? <span className="rh-rank">{chip}</span> : null}
      </div>
      {plot(true)}
      {/* The crosshair's answer, in words, in a line that is ALWAYS there.
          Fixed by its own rule in CSS rather than by its content, so dragging
          across a curve does not shuffle the lines and the verbs under it. */}
      {drawn ? <div className="rh-scrub">{pointReadoutWords(shown, s.unit)}</div> : null}
      {/* The absence sits where the curve would have been, never dimmed. */}
      {absent ? <div className="rh-tile-absent">{absent}</div> : null}
      {reading ? <div className="rh-tile-read">{reading}</div> : null}
      {s.detail ? <div className="rh-tile-detail">{s.detail.trim()}</div> : null}
      {actions || grid ? (
        <div className="rh-tile-acts">
          {actions}
          {grid ? (
            <button type="button" className="key rh-verb" onClick={toggle}>
              <ChevronUp size={12} aria-hidden /> {TILE_FOLD_LABEL}
            </button>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

/**
 * The tiles as a two-column grid, ONE open at a time (`toggleOpen`): the open
 * tile spans both columns, the rest stay compact. The state is here and not
 * in a tile, because "one at a time" is a fact about the set.
 */
export function TileGrid<T extends RepoHealthPlotSeries>({ series, actionsFor, meansFor, axis }: {
  series: readonly T[];
  actionsFor?: (s: T) => ReactNode;
  /** A repo's own `means` per tile (see `SeriesTile`). */
  meansFor?: (s: T) => string | undefined;
  axis?: HealthAxisMode;
}) {
  const [openKey, setOpenKey] = useState<string | null>(null);
  const keys = series.map((s) => s.key);
  const open = openAmong(openKey, keys);
  return (
    <ul className="rh-tiles rh-grid">
      {series.map((s) => (
        <SeriesTile key={s.key} s={s} axis={axis} means={meansFor?.(s)}
          open={open === s.key}
          onToggle={() => setOpenKey((k) => toggleOpen(openAmong(k, keys), s.key))}
          actions={actionsFor?.(s)} />
      ))}
    </ul>
  );
}

/**
 * The tiles card (jump-nav target `#rh-tiles`): the grid, then ONE open line
 * naming the x mode with its `?`, the ask-all verb, and the method — the
 * mode's long form, the rank basis, what the verbs are — folded.
 *
 * `series` arrive as the region draws them: folded to weeks by the caller in
 * weeks mode, whole in commits mode. Without `axis` the points are per day,
 * which is what the commits wording says.
 */
export function TilesCard({ series, windowReadings, minReadings, axis, onAsk, onAskAll, actionsFor, after, title }: {
  series: readonly RepoHealthPlotSeries[];
  windowReadings: number;
  minReadings: number;
  axis?: HealthAxisMode;
  /** Absent = no verb, never a dimmed one (no send path, no repo). */
  onAsk?: (s: RepoHealthPlotSeries) => void;
  onAskAll?: () => void;
  /** A surface's own verbs: per tile in place of `onAsk`'s, and card-wide under the tiles (VS Code's prompts). */
  actionsFor?: (s: RepoHealthPlotSeries) => ReactNode; after?: ReactNode;
  title?: ReactNode;
}) {
  if (!series.length) return null;
  const pts = series.reduce<readonly RepoHealthPoint[]>((a, s) => (s.points.length > a.length ? s.points : a), series[0].points);
  const mode = plotAxisModeWords(axis ?? "commits", pts.length, pts[0]?.day, pts[pts.length - 1]?.day);
  return (
    <div className="rh-card" id="rh-tiles">
      {title ? <h3 className="rh-h">{title}</h3> : null}
      <TileGrid series={series} axis={axis}
        actionsFor={actionsFor ?? (onAsk ? (s) => (
          <button type="button" className="key rh-verb" onClick={() => onAsk(s)}>
            <Send size={12} aria-hidden /> {SERIES_ASK_LABEL}…
          </button>
        ) : undefined)} />
      <div className="rh-cap">
        {mode.lead} <HintChip id="repohealth.reading" of="the percentile and the arrow" />
      </div>
      {/* Under the tiles: it sends what they say, so it comes after them. */}
      {onAskAll ? (
        <div className="rh-tile-acts">
          <button type="button" className="key rh-verb" onClick={onAskAll}>
            <Send size={12} aria-hidden /> {SERIES_ASK_ALL_LABEL}…
          </button>
        </div>
      ) : null}
      {after}
      <details className="hint-more rh-more">
        <summary>{TILES_MORE_SUMMARY}</summary>
        <p>{mode.more}</p>
        <p>{rankBasisWords(windowReadings, minReadings)}</p>
        {onAsk || onAskAll ? <p>{seriesAskNoteWords()}</p> : null}
      </details>
    </div>
  );
}
