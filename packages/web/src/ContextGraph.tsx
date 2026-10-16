/**
 * How full the context window has been, drawn — the miniature and the chart.
 *
 * Geometry, scales and every sentence live in `contextPlot.ts`; this file
 * emits SVG and nothing else. The one thing it owns is the visual contract, and
 * that is worth stating because it was chosen rather than picked:
 *
 *  - **One series.** Tokens carried, over time. Area wash + 2 px line, in the
 *    categorical slot-1 blue. A single series gets no legend box (the title
 *    names it); the legend below the chart is for the two EVENT kinds, which
 *    are a different thing sharing the axis.
 *  - **The wash is a downward fade, never a flat fill** (`SeriesWash`), so the
 *    LINE stays the thing the eye lands on and a tall curve does not read as a
 *    solid block. One colour at two alphas — the validated token — so there is
 *    nothing new for the palette validator to clear.
 *  - **Spend is a SECOND miniature, never a second line on the first.** Same
 *    blue, because the blue means "this conversation's tokens" on both; told
 *    apart by the one thing that distinguishes them — a curve that cannot fall,
 *    under a curve that drops every compaction. They share a unit and nothing
 *    else, which is the same reason the sheet draws two charts.
 *  - **The colours were validated, not chosen by eye**, and validated TWICE —
 *    once per theme. They live in `styles.css` (`--ctx-series`,
 *    `--ctx-compact`, `--ctx-limit`) and are pinned by
 *    `packages/web/src/theme.test.mjs`, which re-measures every pair under
 *    simulated protanopia, deuteranopia and tritanopia on the surface the chart
 *    actually sits on. Orange-for-compaction was the first draft and failed —
 *    against the limit red it is two event kinds nobody could tell apart — which
 *    is why the amber is slot 4 of the categorical set and not an orange.
 *  - **Events carry a shape and a word, never colour alone.** A compaction is a
 *    ▼ over its rule; a wall is a ■ over its rule and a shaded band running to
 *    the reset instant. Both are named in the legend and again in the table.
 *  - **Reference lines are dashed; gridlines are solid hairlines.** The
 *    opposite of the usual mistake: dashing a gridline makes it read as a
 *    threshold, so the dash is reserved for the things that ARE thresholds.
 *  - **Text never wears the data colour.** Labels and values are the app's ink
 *    tokens; identity comes from the mark beside them.
 */
import { useCallback, useId, useRef, useState } from "react";
import { Sigma, TriangleAlert } from "lucide-react";
import { contextPct, costChip, costText, fmtShare, usageChip, usageText, type AgentRun, type ContextEvent, type ContextSample, type ContextSpark, type SpendWarn } from "@waterplane/shared";
import {
  areaPath, autoCompactSetLabel, eventLabel, fmtAxisTime, fmtGap, fmtTokens, fmtTokensFine, fmtYTick, linePath, makePlot,
  agentAtPoint, agentLanes, agentLines, agentSpendBand, laneGeom, modelLabel, nearestSample, sparkGeom, spendSparkGeom,
  spendSparkTitle, stackBands, USED,
  type AgentLane, type ModelSlots, type Plot, type SpendFacts, type StackSeries,
} from "./contextPlot";
import { MODEL_SLOT, SLOT } from "./kit/chart/TokenComposition";
import { REST_SLOT } from "./modelHue";

/**
 * The validated three, as CSS custom properties rather than literals.
 *
 * They were three hex strings until the app grew a light mode, at which point
 * they were three hex strings validated against a surface half the users would
 * never see: `#3987e5` is 3.7:1 on `--panel` in dark and 1.6:1 on the white one,
 * i.e. a data series drawn in invisible ink. The values now live beside every
 * other colour in `styles.css`, twice, and this file names the meaning.
 *
 * Safe everywhere they are used: all three are SVG paint values (`fill`,
 * `stroke`) and one CSS `background`, all of which resolve `var()`.
 */
export const CTX_SERIES = "var(--ctx-series)";
export const CTX_COMPACT = "var(--ctx-compact)";
export const CTX_LIMIT = "var(--ctx-limit)";

const PAD = { top: 10, right: 10, bottom: 20, left: 40 };
/* The spend chart sits under the context one and shares its left gutter, so
   the two y axes line up and the x axis reads as one. Less headroom: its
   only reference line is at the very top and is labelled inside the plot. */
const SPEND_PAD = { top: 12, right: 10, bottom: 20, left: 40 };

// ── the row miniature ─────────────────────────────────────────────────────

/**
 * The trend half of a stat tile, on a launcher row.
 *
 * It draws NOTHING interactive of its own, and it never will: it lives inside
 * the row's `<button>`, so a control in here would be a button inside a button —
 * invalid markup, and on a phone a tap target overlapping the one that opens the
 * session. The tap belongs to whoever composes the tile: `App.tsx` gives the
 * `.row-spark` wrapper `role="button"` and opens the context sheet for THAT
 * session, which is one element, one target, one thing said about it.
 */
export function ContextSparkline({ spark, width = 76, height = 20, value = false }: {
  spark: ContextSpark;
  width?: number;
  height?: number;
  /**
   * Print the latest reading beside the curve.
   *
   * A curve alone says "rising", never "rising to what", and on a launcher row
   * the number is the whole point: the title that carries it is a hover, i.e.
   * nothing at all on a phone. Off where the caller already writes the reading
   * out in words (the session header does), so the figure is never said twice.
   *
   * Always the absolute token count (`1.8k`, `fmtTokensFine`), never a percentage: a row with no
   * known window has no percentage to give, and two rows whose percentages
   * match can be a factor of five apart in tokens. The percentage, where it
   * exists, is already the `contextPill` badge on the same row.
   */
  value?: boolean;
}) {
  const wash = paintId(useId());
  const g = sparkGeom(spark, width, height);
  if (!g) return null;
  const last = spark.pts[spark.pts.length - 1];
  const pct = contextPct(last, spark.windowTok);
  const compacts = spark.marks.filter((m) => m.kind === "compact").length;
  const limits = spark.marks.filter((m) => m.kind === "limit").length;
  // What the whole session has used, against what the next turn re-reads. Two
  // different facts about the same conversation, which is why they sit side by
  // side rather than one replacing the other: a fan-out session's window can be
  // small while its bill is millions, and the curve cannot say so.
  // Money where it could be priced, tokens otherwise — the same ladder the
  // spend miniature's chip climbs, so a row with a curve and a row without one
  // never print the same session in two different units.
  const used = costChip(spark.costUsd) ?? usageChip(spark.usageTok);
  // The row is scanned, not studied, so the whole readout is in the title:
  // where it is, what it peaked at, and what the ticks are. It also names the
  // axis, because a curve at half height means nothing until you know whether
  // the top is 200k or a million.
  const title = [
    pct != null
      ? `context: ${Math.round(pct)}% of ${fmtTokens(spark.windowTok!)}, peak ${fmtTokens(spark.peak)}`
      : `context: ${fmtTokens(last)} now, peak ${fmtTokens(spark.peak)} (window unknown — this row's scale is its own)`,
    // Asked of `usageTok` itself, not of `used`: the chip may be money now, and
    // the tokens it replaced belong in the title either way.
    spark.usageTok != null && spark.usageTok > 0
      ? usageText(spark.usageTok, spark.agentTok ?? null) : null,
    spark.costUsd != null
      ? costText(spark.costUsd, spark.agentCostUsd ?? null, spark.unpricedTok ?? null) : null,
    // The agents' own windows, which the parent's curve never shows — the
    // faint area behind it. Tokens, not a percentage: an agent may run a model
    // whose window is not this axis's.
    g.agentPeak != null ? `agents peaked at ${fmtTokens(g.agentPeak)}` : null,
    spark.autoCompactTok != null ? `compacts at ${fmtTokens(spark.autoCompactTok)}` : null,
    spark.autoCompactSetTok ? `curve tops out at the auto-compact setting, ${fmtTokens(spark.autoCompactSetTok)}` : null,
    compacts ? `${compacts} compaction${compacts > 1 ? "s" : ""}` : null,
    limits ? `${limits} usage limit${limits > 1 ? "s" : ""}` : null,
  ].filter(Boolean).join(" · ");
  const svg = (
    <svg className="ctx-spark" width={width} height={height} viewBox={`0 0 ${width} ${height}`}
      role="img" aria-label={title}><title>{title}</title>
      <defs><SeriesWash id={wash} /></defs>
      {/* The floor the wash sits on. A hairline, in ink at low alpha: without
          it a shallow curve and an empty box look the same at 20 px tall. */}
      <line x1={0} x2={width} y1={height - 0.5} y2={height - 0.5}
        stroke="currentColor" strokeOpacity={0.16} strokeWidth={1} />
      {g.refY != null && (
        <line x1={0} x2={width} y1={g.refY} y2={g.refY} stroke="currentColor" strokeOpacity={0.35}
          strokeWidth={1} strokeDasharray="2 3" />
      )}
      {/* The agents' windows, BEHIND the parent: faint ink, no hue of its own
          (the blue means this conversation's tokens), same axis, clamped at
          its top. Absent from an older host, and then nothing here moves. */}
      {g.agentArea && <path d={g.agentArea} fill="currentColor" fillOpacity={0.13} />}
      <path d={g.area} fill={`url(#${wash})`} />
      <path d={g.line} fill="none" stroke={CTX_SERIES} strokeWidth={1.5}
        strokeLinejoin="round" strokeLinecap="round" />
      {/* Event rules stop a pixel short of the floor and carry a round cap, so
          six of them read as marks ON the curve rather than as a fence in front
          of it. The colour and the count are unchanged — see the file header. */}
      {g.ticks.map((t, i) => (
        <line key={i} x1={t.x} x2={t.x} y1={1} y2={height - 1.5} strokeLinecap="round"
          stroke={t.kind === "compact" ? CTX_COMPACT : CTX_LIMIT} strokeWidth={1.25} strokeOpacity={0.7} />
      ))}
      {/* A 2 px surface ring, so the end dot stays legible where it crosses a
          tick or the reference line. */}
      <circle cx={g.endX} cy={g.endY} r={2.6} fill={CTX_SERIES} stroke="var(--panel)" strokeWidth={2} />
    </svg>
  );
  if (!value) return svg;
  return (
    <span className="ctx-spark-pair" title={title}>
      {svg}
      <span className="ctx-spark-val">{fmtTokensFine(last)}</span>
      {/* The total, marked by the one glyph that says "summed" — never a bare
          second number, which beside the context reading is two figures in the
          same units meaning different things. Absent on a host that does not
          measure it, rather than 0 or the window reading repeated.

          Drawn HERE only where there is no spend curve to hang it on: with one,
          the figure belongs beside the curve it is the end of (`SpendSparkline`)
          and printing it twice on one tile is the same number claiming to be two
          readings. An older host sends no `usedPts`, and this row is then exactly
          what it has always been. */}
      {used && !spendSparkGeom(spark, width, height) && (
        <span className="ctx-spark-use"><Sigma size={10} /> {used}</span>
      )}
    </span>
  );
}

/**
 * The gradient every miniature's wash is painted with.
 *
 * A flat 16% fill under a 1.5 px line is the shape a chart library gives you;
 * it also makes a tall curve look like a solid block and a shallow one look
 * like a smear. Fading it out downward keeps the LINE the thing the eye lands
 * on and leaves the area as what it is — a hint of mass under the curve.
 *
 * `stopColor` is the validated series token, never a literal, so the pair of
 * stops is one colour at two alphas in both themes and the palette validator
 * has nothing new to clear.
 */
/**
 * A `useId` value made safe to name in `url(#…)`.
 *
 * React's ids are `:r3:` — colons and all — and a colon inside a functional URL
 * reference is not something every engine resolves, so a gradient referenced
 * that way renders as no paint at all (an invisible area under a visible line,
 * which is the failure mode that looks like a design decision). Stripped, and
 * prefixed so the result cannot start with a digit either.
 */
function paintId(id: string): string {
  return `w${id.replace(/[^a-zA-Z0-9_-]/g, "")}`;
}

function SeriesWash({ id }: { id: string }) {
  return (
    <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stopColor={CTX_SERIES} stopOpacity={0.3} />
      <stop offset="100%" stopColor={CTX_SERIES} stopOpacity={0.02} />
    </linearGradient>
  );
}

/**
 * The second miniature on a launcher row: what this session has SPENT.
 *
 * Deliberately the same blue as the context curve, for the reason `SpendChart`
 * states — the blue means "this conversation's tokens" on both, and the two are
 * told apart by the thing that actually distinguishes them: one is a sawtooth,
 * the other cannot fall. A fifth hue would have to be re-validated in two
 * themes to say something the shape already says.
 *
 * Null on a host that sends no `usedPts`, and then the launcher row is exactly
 * what it was: one curve, with the total as a `Σ` chip beside it.
 */
export function SpendSparkline({ spark, width = 76, height = 14, warn = null }: {
  spark: ContextSpark;
  width?: number;
  height?: number;
  /** Past the person's orange/red spend mark (`shared/spendwarn.ts`): a
   *  triangle in that colour beside the figure, and the figure in it too. */
  warn?: SpendWarn | null;
}) {
  const wash = paintId(useId());
  const g = spendSparkGeom(spark, width, height);
  if (!g) return null;
  // The figure beside the curve is what somebody means by "what has this
  // session cost me", and it is MONEY: `38M` and `18M` sit next to each other
  // on the launcher saying nothing about which conversation was the expensive
  // one, because that depends on the model each ran and on how much of the
  // traffic was cache reads at a tenth of the rate. `$4.21` is the same fact
  // with the arithmetic done. The tokens are not lost — the title carries
  // them, and the curve is still drawn in them.
  //
  // The fall-through is the ladder this row has always had: the priced total
  // (agents included — the one the dashed line marks), else the token total,
  // else the end of the curve. Each step is absent rather than zero, so a host
  // that cannot price a model shows exactly what it showed before.
  const chip = costChip(spark.costUsd) ?? usageChip(spark.usageTok) ?? fmtTokensFine(g.end);
  const title = warn ? `${warn.text}\n${spendSparkTitle(spark, g)}` : spendSparkTitle(spark, g);
  return (
    <span className="ctx-spark-pair" title={title}>
      <svg className="ctx-spark" width={width} height={height} viewBox={`0 0 ${width} ${height}`}
        role="img" aria-label={title}><title>{title}</title>
        <defs><SeriesWash id={wash} /></defs>
        <line x1={0} x2={width} y1={height - 0.5} y2={height - 0.5}
          stroke="currentColor" strokeOpacity={0.16} strokeWidth={1} />
        {/* The grand total, subagents included — a reference, so dashed, like
            every other threshold in this file. The GAP between it and the end of
            the curve is the agents' share: a quantity nothing here can place in
            time, which is why it is not part of the line. */}
        {g.totalY != null && (
          <line x1={0} x2={width} y1={g.totalY} y2={g.totalY} stroke="currentColor"
            strokeOpacity={0.45} strokeWidth={1} strokeDasharray="3 3" />
        )}
        <path d={g.area} fill={`url(#${wash})`} />
        {/* The subagents' spend stacked on the parent's, in the sheet's grey
            (no fifth hue): on a fan-out session it is most of the box, and
            without it the parent's curve sat on the floor under a total at the
            top — a scale that looked wrong because half of it was missing. */}
        {g.agentBand && <>
          <path d={g.agentBand.area} fill="var(--fg)" fillOpacity={0.16} />
          <path d={g.agentBand.top} fill="none" stroke="var(--fg)" strokeOpacity={0.5} strokeWidth={1}
            strokeLinejoin="round" strokeLinecap="round" />
        </>}
        <path d={g.line} fill="none" stroke={CTX_SERIES} strokeWidth={1.5}
          strokeLinejoin="round" strokeLinecap="round" />
        <circle cx={g.endX} cy={g.endY} r={2.2} fill={CTX_SERIES} stroke="var(--panel)" strokeWidth={1.5} />
      </svg>
      <span className={warn ? `ctx-spark-use spend-warn-${warn.level}` : "ctx-spark-use"}>
        {warn ? <TriangleAlert size={10} aria-label={warn.level === "high" ? "past the red spend mark" : "past the orange spend mark"} /> : <Sigma size={10} />} {chip}
      </span>
    </span>
  );
}

// ── the chart ─────────────────────────────────────────────────────────────

export interface ContextChartProps {
  samples: ContextSample[];
  events: ContextEvent[];
  /** The window the axis calls 100% — the SAME on every chart, so two of them
   *  can be compared. Null ⇒ a token axis, and the sheet says so. */
  windowTok: number | null;
  /** Where an auto-compaction was OBSERVED to fire. Not the window. */
  autoCompactTok: number | null;
  /** The `autoCompactWindow` SETTING as it reads now, in tokens — a second line,
   *  labelled as a setting so it is never read as the measurement above. */
  autoCompactSetTok?: number | null;
  /** The session's subagents: each one's own window is drawn on this axis. */
  agents?: AgentRun[];
  width: number;
  height?: number;
  /**
   * The reading under the crosshair, reported UP.
   *
   * The readout is a line of text above the chart rather than a floating box
   * inside it: an SVG tooltip cannot wrap, and on a phone a box that follows
   * the finger is under the finger. Lifting the state is what lets the sheet
   * render it as ordinary text — and the table view carries the same values,
   * so nothing is gated behind the hover.
   */
  onHover?: (s: ContextSample | null) => void;
  /**
   * Stack the area by these series instead of filling it as one.
   *
   * The LINE stays whatever it always was — the stack's top edge is the same
   * series, so a reader who learnt the shape is not asked to learn a second
   * one. Null (or an older host with no per-sample split) draws exactly the
   * chart that shipped before.
   */
  bands?: StackSeries[] | null;
}

export function ContextChart({ samples, events, windowTok, autoCompactTok, autoCompactSetTok = null, width, height = 200, onHover, bands, agents }: ContextChartProps) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [hover, setHoverAt] = useState<ContextSample | null>(null);
  const setHover = useCallback((s: ContextSample | null) => { setHoverAt(s); onHover?.(s); }, [onHover]);

  const refs = [autoCompactTok, autoCompactSetTok].filter((v): v is number => v != null);
  const p = makePlot({ width, height, pad: PAD, samples, events, refs, windowTok, agents });
  const span = p.t1 - p.t0;

  // Touch and mouse alike: the crosshair follows a drag, which on a phone is
  // the only pointer there is.
  const onMove = useCallback((e: React.PointerEvent<SVGSVGElement>) => {
    const box = svgRef.current?.getBoundingClientRect();
    if (!box) return;
    // The SVG is drawn at `width` user units and laid out at `box.width` CSS
    // px; on a rotated phone those differ, and mixing them puts the crosshair
    // on the wrong reading.
    const x = ((e.clientX - box.left) / box.width) * width;
    setHover(nearestSample(p, samples, x));
  }, [p, samples, width, setHover]);

  const yTicks = p.yTicks;
  // Placed by PIXEL and read back through the axis's inverse, not by dividing
  // the time span. On a compressed axis the two are different: half-way
  // through a two-day span is inside the break, so `t0 + span/2` drew the
  // middle label on top of the first one.
  const xTicks = [0, 0.5, 1].map((f) => p.tx(p.x + f * p.w));

  return (
    // Drawn at the width the caller MEASURED, not at 100% of a box that may
    // have changed since: a viewBox stretched to fit distorts the stroke and
    // the tick text along with the curve.
    <svg ref={svgRef} className="ctx-chart" width={width} height={height}
      viewBox={`0 0 ${width} ${height}`}
      onPointerDown={onMove} onPointerMove={onMove}
      onPointerLeave={() => setHover(null)} onPointerCancel={() => setHover(null)}
      role="img" aria-label="context window over time">

      {/* Gridlines: solid hairlines, one step off the surface. */}
      {yTicks.map((v) => (
        <line key={`g${v}`} x1={p.x} x2={p.x + p.w} y1={p.py(v)} y2={p.py(v)}
          stroke="var(--line)" strokeWidth={1} />
      ))}

      {/* Either the one wash, or the composition inside it. The bands are
          drawn UNDER the line on purpose: the line is the reading, the bands
          are what it was made of, and a 2 px stroke over the seam is also what
          keeps the top band's edge crisp where it meets the axis. */}
      {bands
        ? <StackFills p={p} samples={samples} series={bands} />
        : <path d={areaPath(p, samples)} fill={CTX_SERIES} fillOpacity={0.14} />}
      {/* Each agent's OWN window, thin and in ink so the parent's line stays
          the reading this chart is about — but on the same axis, because a
          parent at 31% over an agent at 97% is the fact a fan-out hides. */}
      {agents && agentLines(p, agents).map((l) => (
        <path key={`a${l.id}`} d={l.d} fill="none" stroke="var(--fg)" strokeOpacity={0.45}
          strokeWidth={1.25} strokeLinejoin="round" strokeLinecap="round" />
      ))}
      <path d={linePath(p, samples)} fill="none" stroke={CTX_SERIES} strokeWidth={2}
        strokeLinejoin="round" strokeLinecap="round" />

      {/* Where the axis was compressed. Drawn, never hidden: the strip is
          painted out in the surface colour and struck through with two slanted
          hairlines — the ordinary axis-break mark — so a two-day silence reads
          as a two-day silence rather than as two adjacent turns. What the gap
          holds is in the strip's own title and in the sheet's note. */}
      {p.breaks.map((b, i) => (
        <g key={`k${i}`}>
          <title>{`${fmtGap(b.to - b.from)} with no activity — the axis is compressed here`}</title>
          <rect x={b.x} y={p.y} width={b.w} height={p.h} fill="var(--panel)" />
          {[0, 1].map((k) => (
            <line key={k} x1={b.x + 1 + k * 5} y1={p.y + p.h} x2={b.x + b.w - 5 + k * 5} y2={p.y}
              stroke="var(--line)" strokeWidth={1} />
          ))}
        </g>
      ))}

      {/* A usage wall is a STRETCH, not an instant: the band runs from the
          rejection to the reset the account named, which is the part of the
          conversation where nothing could have happened. */}
      {events.filter((e) => e.kind === "limit" && e.resetAt != null).map((e, i) => (
        <rect key={`b${i}`} x={p.px(e.t)} y={p.y} width={Math.max(1, p.px(e.resetAt!) - p.px(e.t))} height={p.h}
          fill={CTX_LIMIT} fillOpacity={0.12} />
      ))}


      {/* The WINDOW is the axis top, not a line — that is what makes the scale
          shared. The one threshold left is a measurement: where a compaction
          was last seen to fire. Dashed on purpose (see the header), and pushed
          under its own rule when it sits within a line-height of the top,
          which it usually does. */}
      {autoCompactTok != null && (
        <RefLine p={p} v={autoCompactTok} label={`compacts ~${fmtYTick(p, autoCompactTok)}`}
          below={p.py(autoCompactTok) - p.y < 13} />
      )}
      {/* The SETTING, beside the measurement: a finer dash and its label on the
          LEFT, so the two never print over each other when they nearly agree. */}
      {autoCompactSetTok != null && (
        <RefLine p={p} v={autoCompactSetTok} label={autoCompactSetLabel(autoCompactSetTok)}
          below={p.py(autoCompactSetTok) - p.y < 13} start dash="1.5 3" />
      )}

      {/* `rebuild` events are not drawn on the chart — see `sparkOf` in the
          host's `ctxlog.ts`. The window does not move when a cache expires, so
          there is nothing here for a rule to point at, and the two event
          colours are the only two that were validated. The values view and the
          cost panel say it in words instead. */}
      {events.filter((e) => e.kind !== "rebuild").map((e, i) => {
        const x = p.px(e.t);
        // The RULE sits at the true x; the glyph is nudged inside the plot so
        // an event at either edge — a wall before the first reading is the
        // common one — is a whole mark rather than half of one.
        const gx = Math.min(p.x + p.w - 5, Math.max(p.x + 5, x));
        const c = e.kind === "compact" ? CTX_COMPACT : CTX_LIMIT;
        return (
          <g key={`e${i}`}>
            <title>{eventLabel(e).text}</title>
            <line x1={x} x2={x} y1={p.y} y2={p.y + p.h} stroke={c} strokeWidth={1.5} strokeOpacity={0.85} />
            {/* Shape as well as colour: ▼ compaction, ■ wall. */}
            {e.kind === "compact"
              ? <path d={`M${gx - 4},${p.y}L${gx + 4},${p.y}L${gx},${p.y + 6}Z`} fill={c} stroke="var(--panel)" strokeWidth={1} />
              : <rect x={gx - 3.5} y={p.y} width={7} height={7} fill={c} stroke="var(--panel)" strokeWidth={1} />}
          </g>
        );
      })}

      {/* Axes: y values on the left, three times along the bottom. Tabular
          figures, because these are a column of numbers that must align. */}
      {yTicks.map((v) => (
        <text key={`t${v}`} className="ctx-tick" x={p.x - 6} y={p.py(v) + 3.5} textAnchor="end">{fmtYTick(p, v)}</text>
      ))}
      {xTicks.map((t, i) => (
        <text key={`x${i}`} className="ctx-tick" x={p.px(t)} y={height - 6}
          textAnchor={i === 0 ? "start" : i === xTicks.length - 1 ? "end" : "middle"}>{fmtAxisTime(t, span)}</text>
      ))}

      {hover && (
        <g>
          <line x1={p.px(hover.t)} x2={p.px(hover.t)} y1={p.y} y2={p.y + p.h}
            stroke="var(--fg)" strokeOpacity={0.35} strokeWidth={1} />
          <circle cx={p.px(hover.t)} cy={p.py(hover.tok)} r={4.5}
            fill={CTX_SERIES} stroke="var(--panel)" strokeWidth={2} />
        </g>
      )}
    </svg>
  );
}

/**
 * The same conversation's running total, on its own axes.
 *
 * Deliberately a QUIETER chart than the one above it: no crosshair, no y
 * gridlines past the ticks, half the height. A cumulative curve has one shape
 * and two readable features — where it steepened, and where it flattened —
 * and everything a crosshair would answer is either the headline above it or
 * the context chart's own readout at the same instant.
 *
 * It wears the SAME series colour as the context chart on purpose. The blue is
 * "this conversation's tokens" on both, and the two curves are told apart by
 * the thing that actually distinguishes them — one is a sawtooth, the other
 * cannot fall — rather than by a fifth hue the palette validator would have to
 * re-clear in two themes.
 *
 * The event rules are carried over unlabelled: a compaction is the moment the
 * context chart drops and this one does not, which is the whole point of
 * putting them on one x axis, and repeating the ▼ and ■ glyphs here would read
 * as a second set of events.
 */
export function SpendChart({ samples, events, facts, width, height = 96, bands, agents, agentCum }: {
  samples: ContextSample[];
  events: ContextEvent[];
  facts: SpendFacts;
  width: number;
  height?: number;
  /** The agents' running total over time (`ContextSeriesDoc.agentCum`),
   *  stacked on the parent's curve as a grey band. Absent from an older host:
   *  then the dashed total alone marks the agents' share, as it always did. */
  agentCum?: [number, number][] | null;
  /** Stack the fill by these series — see `ContextChartProps.bands`. They must
   *  be built off `cum`, the CUMULATIVE tuple: a stack of per-request values
   *  under a cumulative line would not add up to the line it is inside. */
  bands?: StackSeries[] | null;
  agents?: AgentRun[];
}) {
  // `refs` carries the grand total so the axis CONTAINS the dashed line — the
  // rule this file's plot header states, and the case it was written for: the
  // agent share is often most of the bill, and an axis fitted to the curve
  // alone would draw the total off the top of the chart.
  const p = makePlot({
    width, height, pad: SPEND_PAD, samples, events, windowTok: null, agents,
    value: USED, refs: facts.total != null ? [facts.total] : [],
    // Three, not the chart's five: at this height five labels sit a couple of
    // pixels apart and the dashed total lands on top of one of them. A
    // cumulative curve is read for its SHAPE and its end, both of which three
    // gridlines place perfectly well.
    yWant: 3,
  });
  const span = p.t1 - p.t0;
  const xTicks = [0, 0.5, 1].map((f) => p.tx(p.x + f * p.w));
  const band = facts.agents != null ? agentSpendBand(p, samples, agentCum) : { area: "", top: "" };
  return (
    <svg className="ctx-chart" width={width} height={height} viewBox={`0 0 ${width} ${height}`}
      role="img" aria-label="tokens spent over time">
      {p.yTicks.map((v) => (
        <line key={`g${v}`} x1={p.x} x2={p.x + p.w} y1={p.py(v)} y2={p.py(v)}
          stroke="var(--line)" strokeWidth={1} />
      ))}

      {bands
        ? <StackFills p={p} samples={samples} series={bands} />
        : <path d={areaPath(p, samples, USED)} fill={CTX_SERIES} fillOpacity={0.14} />}
      {/* The subagents' spend, ON TOP of the parent's: the same grey ink as
          their windows above (no fifth hue), step-held at their own
          timestamps, its top edge ending on the dashed whole-session total. */}
      {band.area && <>
        <path d={band.area} fill="var(--fg)" fillOpacity={0.16} />
        <path d={band.top} fill="none" stroke="var(--fg)" strokeOpacity={0.5} strokeWidth={1.25} strokeLinejoin="round" />
      </>}
      <path d={linePath(p, samples, USED)} fill="none" stroke={CTX_SERIES} strokeWidth={2}
        strokeLinejoin="round" strokeLinecap="round" />

      {/* The same breaks as the chart above, drawn the same way: the two share
          one time axis, and a compressed stretch marked on one and not the
          other would be two different axes wearing the same labels. */}
      {p.breaks.map((b, i) => (
        <g key={`k${i}`}>
          <title>{`${fmtGap(b.to - b.from)} with no activity — the axis is compressed here`}</title>
          <rect x={b.x} y={p.y} width={b.w} height={p.h} fill="var(--panel)" />
          {[0, 1].map((k) => (
            <line key={k} x1={b.x + 1 + k * 5} y1={p.y + p.h} x2={b.x + b.w - 5 + k * 5} y2={p.y}
              stroke="var(--line)" strokeWidth={1} />
          ))}
        </g>
      ))}

      {events.filter((e) => e.kind !== "rebuild").map((e, i) => (
        <line key={`e${i}`} x1={p.px(e.t)} x2={p.px(e.t)} y1={p.y} y2={p.y + p.h}
          stroke={e.kind === "compact" ? CTX_COMPACT : CTX_LIMIT} strokeWidth={1.5} strokeOpacity={0.55} />
      ))}

      {/* The whole total, subagents included — a reference, so dashed. The
          grey band's top edge ends on it; from an older host with no agent
          series, the GAP between it and the curve is the agents' share. */}
      {facts.total != null && facts.agents != null && (
        <RefLine p={p} v={facts.total} label={`${fmtTokens(facts.total)} with subagents`}
          below={p.py(facts.total) - p.y < 13} />
      )}

      {p.yTicks.map((v) => (
        <text key={`t${v}`} className="ctx-tick" x={p.x - 6} y={p.py(v) + 3.5} textAnchor="end">{fmtTokens(v)}</text>
      ))}
      {xTicks.map((t, i) => (
        <text key={`x${i}`} className="ctx-tick" x={p.px(t)} y={height - 6}
          textAnchor={i === 0 ? "start" : i === xTicks.length - 1 ? "end" : "middle"}>{fmtAxisTime(t, span)}</text>
      ))}
    </svg>
  );
}

/**
 * The stack itself: one filled path per band, in the palette's own slots.
 *
 * Opaque, not the single series' 14% wash — a stack read through a wash is
 * three shades of one colour. The 2 px surface-coloured seam between bands is
 * the spacer the mark specs call for: without it two adjacent fills touch and a
 * thin band disappears into its neighbour, which on this data (96% cache read,
 * 0.2% output) is most of the stack.
 *
 * Bands are keyed by IDENTITY, so React reuses the same node for the same kind
 * or model across a toggle rather than re-keying by position and animating one
 * series into another.
 */
function StackFills({ p, samples, series }: { p: Plot; samples: ContextSample[]; series: StackSeries[] }) {
  const bands = stackBands(p, samples, series);
  return (
    <g>
      {bands.map((b) => b.d && (
        <path key={b.key} d={b.d} fill={SLOT[b.slot] ?? MODEL_SLOT[REST_SLOT]}
          fillOpacity={0.85} stroke="var(--panel)" strokeWidth={0.75} strokeOpacity={0.6}>
          <title>{`${b.name}: ${fmtTokens(b.total)}`}</title>
        </path>
      ))}
    </g>
  );
}

/**
 * The stack's own legend — identity is never colour alone.
 *
 * Every band, with its swatch, its name and its value, in ink. Four entries at
 * most (the palette's own cap), which is inside the count where direct labels
 * are mandatory — the value beside each name IS that direct label, and it is
 * what lets the strip be read without hovering anything on a phone.
 */
export function StackLegend({ p, samples, series, fmt = fmtTokens }: {
  p: Plot;
  samples: ContextSample[];
  series: StackSeries[];
  fmt?: (n: number) => string;
}) {
  const bands = stackBands(p, samples, series);
  const whole = bands.reduce((n, b) => n + b.total, 0);
  return (
    <div className="ctx-legend ctx-legend-stack">
      {bands.map((b) => (
        <span key={b.key}>
          <svg width="10" height="10" aria-hidden>
            <rect x="0" y="1" width="10" height="8" rx="2" fill={SLOT[b.slot] ?? MODEL_SLOT[REST_SLOT]} />
          </svg>
          {b.name} <b>{fmt(b.total)}</b>
          {whole > 0 && <span className="ctx-legend-pct"> {fmtShare(b.total / whole)}</span>}
        </span>
      ))}
    </div>
  );
}

/**
 * The third chart: every subagent as a bar over its own span, packed into
 * swim lanes on the same x axis as the two above (`agentLanes`).
 *
 * The strip answers what the spend chart's grey band cannot: HOW LONG each
 * agent ran, how many ran AT ONCE, and which one was dear (outlined). Colour is
 * the model, from the screen's one `modelSlots`. A tap or drag picks the
 * nearest bar and reports it UP as a line of text under the strip — never a
 * floating box; the pick survives lifting the finger, and a tap on the picked
 * bar lets go.
 */
export function AgentLanesChart({ samples, events, agents, slots, width, onPick, picked }: {
  samples: ContextSample[];
  events: ContextEvent[];
  agents: AgentRun[];
  slots: ModelSlots | null;
  width: number;
  onPick?: (a: AgentRun | null) => void;
  picked?: AgentRun | null;
}) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const top = 6;
  // The x axis is the plot's; the lane packing needs only `px`, so the height
  // follows from how many lanes it took.
  const probe = makePlot({ width, height: 100, pad: { ...SPEND_PAD, top }, samples, events, windowTok: null, refs: [], agents });
  const { bars, lanes } = agentLanes(probe, agents, slots);
  const { laneH, barH, plotH } = laneGeom(lanes);
  const height = top + plotH + SPEND_PAD.bottom;
  // Only the x half of the plot is used; the lanes are this chart's own y.
  const p = probe;
  const span = p.t1 - p.t0;
  const xTicks = [0, 0.5, 1].map((f) => p.tx(p.x + f * p.w));
  const pickAt = (e: React.PointerEvent<SVGSVGElement>, toggle: boolean) => {
    const box = svgRef.current?.getBoundingClientRect();
    if (!box || !onPick) return;
    const x = ((e.clientX - box.left) / box.width) * width;
    const y = ((e.clientY - box.top) / box.height) * height;
    const hit: AgentLane | null = agentAtPoint(bars, laneH, top, x, y);
    onPick(toggle && hit && picked && hit.run.id === picked.id ? null : hit?.run ?? null);
  };
  return (
    <svg ref={svgRef} className="ctx-chart" width={width} height={height} viewBox={`0 0 ${width} ${height}`}
      onPointerDown={(e) => pickAt(e, true)}
      onPointerMove={(e) => { if (e.buttons) pickAt(e, false); }}
      role="img" aria-label="subagents over time, one bar each">
      {p.breaks.map((b, i) => (
        <g key={`k${i}`}>
          <rect x={b.x} y={top} width={b.w} height={plotH} fill="var(--panel)" />
          {[0, 1].map((k) => (
            <line key={k} x1={b.x + 1 + k * 5} y1={top + plotH} x2={b.x + b.w - 5 + k * 5} y2={top}
              stroke="var(--line)" strokeWidth={1} />
          ))}
        </g>
      ))}
      <line x1={p.x} x2={p.x + p.w} y1={top + plotH + 0.5} y2={top + plotH + 0.5} stroke="var(--line)" strokeWidth={1} />
      {bars.map((b) => {
        const on = picked?.id === b.run.id;
        return (
          <rect key={b.run.id} x={b.x} y={top + b.lane * laneH + (laneH - barH) / 2} width={b.w} height={barH}
            rx={Math.min(2, barH / 2)} fill={SLOT[b.slot] ?? MODEL_SLOT[REST_SLOT]}
            fillOpacity={picked && !on ? 0.55 : 0.9}
            stroke={on || b.dearest ? "var(--fg)" : "none"} strokeWidth={on ? 1.5 : 1}>
            <title>{`${b.run.type ?? "agent"} · ${fmtTokens(b.run.tok)}`}</title>
          </rect>
        );
      })}
      {xTicks.map((t, i) => (
        <text key={`x${i}`} className="ctx-tick" x={p.px(t)} y={height - 6}
          textAnchor={i === 0 ? "start" : i === xTicks.length - 1 ? "end" : "middle"}>{fmtAxisTime(t, span)}</text>
      ))}
    </svg>
  );
}

/** Under the spend chart: which fill is which. The parent keeps its own series
 *  (or the stack the context chart's legend names); the agents are the grey band; the
 *  dashed line is the whole session. */
export function SpendLegend({ agents, dashed, stacked }: { agents: boolean; dashed: boolean; stacked: boolean }) {
  if (!agents && !dashed) return null;
  return (
    <div className="ctx-legend">
      <span><svg width="14" height="10" aria-hidden><rect x="0" y="3" width="14" height="2.5" rx="1.2" fill={CTX_SERIES} /></svg> this conversation{stacked ? " (stacked as the window below)" : ""}</span>
      {agents && (
        <span><svg width="10" height="10" aria-hidden><rect x="0" y="1" width="10" height="8" rx="2" fill="var(--fg)" fillOpacity={0.3} /></svg> subagents</span>
      )}
      {dashed && (
        <span><svg width="14" height="10" aria-hidden><line x1="0" x2="14" y1="5" y2="5" stroke="var(--fg)" strokeOpacity={0.5} strokeDasharray="4 3" /></svg> whole session</span>
      )}
    </div>
  );
}

/**
 * Which colour is which model, under the subagent chart.
 *
 * Its own legend rather than leaning on the one above it: the areas may be
 * stacked by KIND (or not at all) while these bars are always coloured by model,
 * so the chart above is frequently naming four different things in the same
 * four colours. Absent with one model — a legend of one entry names a colour
 * nothing is being told apart from.
 */
export function ModelLegend({ slots, only }: {
  slots: ModelSlots | null;
  /** The slots the chart actually painted. A legend naming a colour that is
   *  nowhere on the chart is a reader looking for a band that does not exist —
   *  this screen's model table spans the conversation AND its agents, and the
   *  two charts draw different halves of it. */
  only?: Set<number>;
}) {
  if (!slots) return null;
  const entries = [
    ...slots.named.map((m) => ({ slot: m.slot, name: modelLabel(m.id) })),
    ...(slots.rest ? [{ slot: slots.rest.slot, name: slots.rest.name }] : []),
  ].filter((e) => !only || only.has(e.slot));
  if (entries.length < 2) return null;
  return (
    <div className="ctx-legend ctx-legend-stack">
      {entries.map((e) => (
        <span key={e.name}>
          <svg width="10" height="10" aria-hidden>
            <rect x="0" y="1" width="10" height="8" rx="2" fill={SLOT[e.slot] ?? MODEL_SLOT[REST_SLOT]} />
          </svg>
          {e.name}
        </span>
      ))}
    </div>
  );
}

/** A dashed threshold with its own label, clamped inside the plot so the text
 *  never rides off the top or bottom edge. */
function RefLine({ p, v, label, below, start, dash = "4 4" }: { p: Plot; v: number; label: string; below?: boolean; start?: boolean; dash?: string }) {
  const y = p.py(v);
  const ty = below ? Math.min(p.y + p.h - 2, y + 11) : Math.max(p.y + 9, y - 4);
  return (
    <g>
      <line x1={p.x} x2={p.x + p.w} y1={y} y2={y} stroke="var(--fg)" strokeOpacity={0.4}
        strokeWidth={1} strokeDasharray={dash} />
      <text className="ctx-ref" x={start ? p.x + 4 : p.x + p.w} y={ty} textAnchor={start ? "start" : "end"}>{label}</text>
    </g>
  );
}

/** One legend entry — the mark, then the word, in ink. */
export function ContextLegend({ events, agents = 0 }: { events: ContextEvent[]; agents?: number }) {
  const compacts = events.filter((e) => e.kind === "compact").length;
  const limits = events.filter((e) => e.kind === "limit").length;
  return (
    <div className="ctx-legend">
      <span><svg width="14" height="10" aria-hidden><rect x="0" y="3" width="14" height="2.5" rx="1.2" fill={CTX_SERIES} /></svg> context</span>
      {agents > 0 && (
        <span><svg width="14" height="10" aria-hidden><rect x="0" y="4" width="14" height="1.25" fill="var(--fg)" fillOpacity={0.45} /></svg> each agent's own window ({agents})</span>
      )}
      {compacts > 0 && (
        <span><svg width="10" height="10" aria-hidden><path d="M1,1L9,1L5,8Z" fill={CTX_COMPACT} /></svg> compaction ({compacts})</span>
      )}
      {limits > 0 && (
        <span><svg width="10" height="10" aria-hidden><rect x="1.5" y="1.5" width="7" height="7" fill={CTX_LIMIT} /></svg> usage limit ({limits})</span>
      )}
    </div>
  );
}
