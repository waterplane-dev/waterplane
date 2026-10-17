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
import type {
  RepoHealthArea, RepoHealthPlotContext, RepoHealthPlotSeries, RepoHealthPoint,
} from "@waterplane/shared";
import {
  MIN_READINGS, dumbbellGeom, indexTicks, nearestPlotted, sparkGeom, stackGeom,
  type Plotted, type StackInput,
} from "./repoHealthPlot";
import {
  areaRowWords, areaSpreadWords, axisDayWords, pointReadoutWords, rankSentence, rankChipWords, kpiMeaning,
  seriesValueWords, slopeWords, stackReadoutWords, tileAbsentWords, variantHidesChart, variantWords,
  SERIES_ASK_ALL_LABEL, SERIES_ASK_LABEL, plotAxisModeWords, rankBasisWords, seriesAskNoteWords,
} from "./repoHealthWords";
import { useBoxWidth } from "./kit/chart/useBoxWidth";
import { latestIndex, openAmong, sparkAreaPath, toggleOpen } from "./repoHealthTileGeom";
import { TILES_MORE_SUMMARY, TILE_FOLD_LABEL, areaAbsentWords, tileToggleTitle } from "./repoHealthTileWords";
import type { HealthAxisMode } from "./healthIndexWords";
import { weightStackWords } from "./repoHealthStackWords";
import { SLOT } from "./kit/chart/TokenComposition";
import { HintChip } from "./HintChip";

/** The curve's own weight of ink. Low enough that the VALUE stays the thing
 *  the eye lands on in a tile, high enough to read at 32 px tall. */
export const CURVE_OPACITY = 0.55;
/** The height of a tile's sparkline. Two more pixels than it needs, so the end
 *  dot's ring is fully inside the box at either extreme. */
const SPARK_H = 32;
/** An open tile's curve: room for the crosshair ring and the day ticks. */
const SPARK_OPEN_H = 48;
export const DOT_R = 2.5;

export const values = (points: readonly RepoHealthPoint[]): (number | null)[] => points.map((p) => p.v);

/**
 * Every metric on this sheet carries its own `?`.
 *
 * A tile's id is `repohealth.` plus the tool's own series key, so a series
 * added to `tools/repohealth/narrate.mjs` needs no edit here — only an entry
 * in the catalog, which a test insists on.
 */
const hintOf = (key: string) => `repohealth.${key}`;

/**
 * The strip under a plot where the day labels sit, and the tick baseline
 * inside it. Part of the SVG rather than a row of spans beneath it: the labels
 * have to line up with marks drawn in user units, and a flexbox row under the
 * box lines up with nothing.
 */
export const TICK_H = 15;
export const TICK_BASELINE = 11;
/** How many day labels a plot gets. Three — the two ends and the middle — is
 *  what fits at 10 px on a 360 px phone without the outer two colliding with
 *  their neighbour, and it is the same three `ContextChart` draws. */
const X_TICKS = 3;
/** The left gutter, sized to the LABELS rather than fixed: these series carry
 *  four magnitudes (`0.69`, `1,352`, `11,955`, `143,176`) and one width either
 *  clips the widest or wastes a third of the plot on the narrowest. */
const GUTTER_MIN = 26;
const GUTTER_MAX = 64;
const CHAR_PX = 6;
export const gutterFor = (labels: readonly string[]) => {
  let longest = 0;
  for (const t of labels) if (t.length > longest) longest = t.length;
  return Math.min(GUTTER_MAX, Math.max(GUTTER_MIN, longest * CHAR_PX + 8));
};

/**
 * Where a pointer landed, in the plot's own user units.
 *
 * The SVG is drawn at `width` user units and laid out at `box.width` CSS px,
 * and on a rotated phone those differ — mixing them puts the crosshair on the
 * wrong reading. `ContextChart` learnt this first; the arithmetic is the same
 * and is written once here.
 */
export function plotX(e: { clientX: number }, el: SVGSVGElement | null, width: number, gutter: number): number | null {
  const box = el?.getBoundingClientRect();
  if (!box || !box.width) return null;
  return ((e.clientX - box.left) / box.width) * width - gutter;
}

/** The day labels along the bottom, drawn from the points themselves. */
export function XAxis({ points, w, y, gutter }: {
  points: readonly RepoHealthPoint[];
  w: number;
  y: number;
  gutter: number;
}) {
  const ticks = indexTicks(points.length, w, X_TICKS);
  if (ticks.length < 2) return null;
  return (
    <>
      {ticks.map((t, k) => (
        <text key={t.i} className="rh-tick" x={gutter + t.x} y={y}
          textAnchor={k === 0 ? "start" : k === ticks.length - 1 ? "end" : "middle"}>
          {axisDayWords(points[t.i]?.day)}
        </text>
      ))}
    </>
  );
}

/**
 * Whether lifting the pointer should clear the readout.
 *
 * It should for a MOUSE and must not for a finger, and getting this backwards
 * is invisible on a desktop. `pointerleave` fires when a touch pointer is
 * destroyed, i.e. the instant you lift — so a shared handler wipes the answer
 * exactly when the finger stops covering it and the reader finally looks. A
 * mouse has hover, so leaving the box genuinely means "not pointing at
 * anything"; a touch has no hover, so the last thing touched IS the selection
 * and stays until something else is.
 */
export const clearsOnLeave = (e: { pointerType?: string }) => e.pointerType === "mouse";

/** The crosshair: a rule at the reading, and a ring on it. Ink, never the
 *  accent — the accent is reserved for WHERE the series ends, and two accents
 *  on one curve is two claims about which point matters. */
export function Crosshair({ at, h, gutter }: { at: Plotted; h: number; gutter: number }) {
  return (
    <g pointerEvents="none">
      <line x1={gutter + at.x} x2={gutter + at.x} y1={0} y2={h}
        stroke="currentColor" strokeOpacity={0.35} strokeWidth={1} />
      <circle cx={gutter + at.x} cy={at.y} r={4} fill="var(--panel)"
        stroke="currentColor" strokeOpacity={0.7} strokeWidth={2} />
    </g>
  );
}

/** The band with no hue of its own — the folded tail, drawn in ink. */
const foldedFill = "var(--muted)";
const fillFor = (slot: number) => (slot >= 0 && slot < SLOT.length ? SLOT[slot] : foldedFill);

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
