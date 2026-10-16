/** The two day charts: tokens or dollars per day, and subagents started per day. */
import { useCallback, useRef, useState } from "react";
import { fmtCount, fmtExact, fmtUsd, fmtUsdShort, normalizeModel } from "@waterplane/shared";
import {
  areaUnder, columns, DAY_MS, type DayPoint, dayTicks, makeDayPlot, type MixSeries, MODEL_SLOT,
  modelBands, nearestDay, ScrubHint, SERIES, stacks, stepPath,
} from "@waterplane/kit";
import { CHART_H, PAD } from "../constants.ts";
import { type MixDay } from "./MixChart.tsx";

/**
 * The two time charts — one series each, so no legend box.
 *
 * `slots` is the WEEK mode and it inverts one rule on purpose. Everywhere else
 * a day with no activity is simply not a point, because over three months a
 * gap is the weekend and drawing seven flat columns per fortnight says nothing.
 * Inside ONE week the seven columns ARE the axis: a Wednesday at zero is a day
 * off, which is a reading, so each day gets a named tick and a faint slot
 * behind it and an empty column is visibly an empty column rather than a
 * missing one.
 */
export function DayChart({ pts, width, kind, slots = false, maxColW, money = false, trend, stepMs, label }: {
  pts: DayPoint[];
  width: number;
  kind: "area" | "columns";
  /**
   * What the chart is of, for a screen reader. Defaulted from `kind` because
   * for most of this screen's life `area` meant exactly one chart — the
   * cumulative one. It does not any more: the per-day and per-hour series can
   * be drawn as an area too, and a filled series announcing itself as "running
   * total" is a wrong answer to the only question a screen reader can ask.
   */
  label?: string;
  /** Draw one labelled slot per point — see above. */
  slots?: boolean;
  /** Column cap. Wider in week mode, where seven columns have room. */
  maxColW?: number;
  /** Label the axis and the readout in dollars rather than tokens. */
  money?: boolean;
  /**
   * A smoothed line to lay over the columns — the rolling mean.
   *
   * Passed in rather than computed here, and computed over the WHOLE day series
   * rather than the visible one (`rollingMean` in the body): a 7-day mean
   * derived from the seven days on screen would be one point, in the middle,
   * which is not a trend but a restatement of the total. It is clipped to the
   * window afterwards, so the line entering from the left edge is the real
   * average of the week before.
   */
  trend?: DayPoint[];
  /**
   * What one bucket is worth on the axis — a day unless this chart is the
   * intraday one, which is the same chart an hour at a time. The whole reason
   * it is a parameter and not a second component: two time axes in one screen
   * is two ways of rounding one.
   */
  stepMs?: number;
}) {
  const height = CHART_H;
  const p = makeDayPlot({ width, height, pad: PAD, points: pts, stepMs });
  /** Hour-resolution buckets need the clock in every label; day ones must not
   *  carry a meaningless 00:00. */
  const intraday = !!stepMs && stepMs < DAY_MS;
  const [hover, setHover] = useState<DayPoint | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);

  const onMove = useCallback((e: React.PointerEvent<SVGSVGElement>) => {
    const box = svgRef.current?.getBoundingClientRect();
    if (!box) return;
    setHover(nearestDay(p, pts, ((e.clientX - box.left) / box.width) * width));
  }, [p, pts, width]);

  if (!pts.length) return <div className="empty">{intraday ? "No hours in this window." : "No days in this window."}</div>;
  const cols = kind === "columns" ? columns(p, pts, maxColW) : [];
  // The slot a column sits in, drawn faintly, so a zero-height column still
  // occupies a visible place on the axis.
  const slotW = Math.max(1, Math.min((maxColW ?? 14) + 8, p.slot - 2));

  return (
    <>
      <svg ref={svgRef} className="ctx-chart" width={width} height={height} viewBox={`0 0 ${width} ${height}`}
        onPointerDown={onMove} onPointerMove={onMove}
        onPointerLeave={() => setHover(null)} onPointerCancel={() => setHover(null)}
        role="img" aria-label={label ?? (kind === "area" ? "cumulative tokens over time" : "tokens per day")}>
        {p.yTicks.map((v) => (
          <line key={v} x1={p.x} x2={p.x + p.w} y1={p.py(v)} y2={p.py(v)} stroke="var(--line)" strokeWidth={1} />
        ))}
        {slots && kind === "columns" && pts.map((pt) => (
          <rect key={`s${pt.day}`} x={p.px(pt.t) - slotW / 2} y={p.y} width={slotW} height={p.h}
            rx={3} fill="var(--fg)" fillOpacity={0.045} />
        ))}
        {kind === "area" ? <>
          <path d={areaUnder(p, pts)} fill={SERIES} fillOpacity={0.14} />
          <path d={stepPath(p, pts)} fill="none" stroke={SERIES} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          {/* One point is a line with no length and an area with no width, so
              a week whose first day is the only day drawn came out blank — on
              a Monday, which is exactly when the week view is opened. */}
          {pts.length === 1 && <circle cx={p.px(pts[0].t)} cy={p.py(pts[0].v)} r={4} fill={SERIES} />}
        </> : cols.map((c, i) => (
          // 4px rounded cap, square at the baseline: the spec for a column.
          <rect key={i} x={c.x} y={c.y} width={c.w} height={c.h} rx={Math.min(2, c.w / 2)} fill={SERIES}
            fillOpacity={hover && hover.day === c.point.day ? 1 : 0.78} />
        ))}
        {/* Over the columns, never under them: the columns are the data and
            the mean is a reading OF it. Dashed, and thin, because a solid line
            of the same weight reads as a second series. Drawn over the area
            form as well: the mean is a reading of the same numbers whichever
            shape they are in, and it is the one line that survives a window
            wide enough to make every bucket a hairline. */}
        {trend && trend.length > 1 && (
          <path d={stepPath(p, trend)} fill="none" stroke="var(--fg)" strokeOpacity={0.5}
            strokeWidth={1.5} strokeDasharray="4 3" strokeLinejoin="round" strokeLinecap="round" />
        )}
        {p.yTicks.map((v) => (
          // `fmtCount`, not the context graph's `fmtTokens`: that one stops at
          // millions, so a 13.6-billion axis labelled itself "15000M".
          <text key={`t${v}`} className="ctx-tick" x={p.x - 6} y={p.py(v) + 3.5} textAnchor="end">{money ? fmtUsdShort(v) : fmtCount(v)}</text>
        ))}
        {slots
          ? pts.map((pt) => (
            <text key={`d${pt.day}`} className="ctx-tick" x={p.px(pt.t)} y={height - 6} textAnchor="middle">
              {new Date(pt.t).toLocaleDateString(undefined, { weekday: "short" })}
            </text>
          ))
          : dayTicks(p).map((t, i) => (
            <text key={i} className="ctx-tick" x={t.x} y={height - 6} textAnchor={t.anchor}>{t.label}</text>
          ))}
        {hover && kind === "area" && (
          <g>
            <line x1={p.px(hover.t)} x2={p.px(hover.t)} y1={p.y} y2={p.y + p.h} stroke="var(--fg)" strokeOpacity={0.35} strokeWidth={1} />
            <circle cx={p.px(hover.t)} cy={p.py(hover.v)} r={4.5} fill={SERIES} stroke="var(--panel)" strokeWidth={2} />
          </g>
        )}
      </svg>
      {/* Fixed height, so dragging across the chart does not shuffle the page. */}
      <div className="ctx-readout">
        {hover
          ? `${intraday
              ? `${new Date(hover.t).toLocaleDateString(undefined, { day: "numeric", month: "short" })} ${new Date(hover.t).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`
              : new Date(hover.t).toLocaleDateString(undefined, { weekday: slots ? "short" : undefined, day: "numeric", month: "short", year: "numeric" })
            } · ${hover.v > 0 ? (money ? fmtUsd(hover.v) : fmtExact(hover.v)) : "nothing recorded"}`
          : <ScrubHint />}
      </div>
    </>
  );
}

/**
 * The same days, split by kind — what the volume chart cannot say.
 *
 * ── Why this is allowed to stack when nothing else here is ──────────────────
 *
 * `statsPlot`'s daily columns are one series on purpose: 96% of every column is
 * cache reads, so an absolute stack is one colour with three slivers beside it
 * pretending to be information. That argument is about HEIGHT. Rescale every
 * column to the same height and the chart stops being about volume — which the
 * chart above already answers — and starts being about proportion, where a
 * 96/3/0.2 split is exactly what a reader wants to see hold steady or not.
 *
 * The absolute mode is kept beside it because volume and mix are two readings
 * and nobody should have to hold one in their head to read the other. It
 * carries the sliver problem honestly rather than floor-inflating the small
 * bands: a chart whose whole subject is proportion must not distort one.
 *
 * ── What it is for ──────────────────────────────────────────────────────────
 *
 * A week where cache writes climb from 3% to 12% is a week the session shape
 * changed — longer conversations, more re-reads, a new tool writing into the
 * window. It is invisible in every other chart on this screen, and in the cost
 * view it is the single biggest lever: cache writes are 3% of the tokens and
 * 38% of the money.
 */
/**
 * Subagents started per day, stacked by the model that ran them.
 *
 * ── Why it is a chart of its own and not a fourth `dayView` ─────────────────
 *
 * Its y axis counts WHOLE AGENTS. Every other chart on this screen counts
 * tokens or dollars, and the one control above them all switches between those
 * two — a fourth view whose axis is neither would make that switch mean
 * nothing on one of its states. It also answers a different question: the spend
 * charts say how much the fan-out cost, and this one says how often the work
 * fans out at all, which is the shape of how somebody works rather than of what
 * they used.
 *
 * Bars always, never an area: this is a count of EVENTS, and between two
 * launches there is no number of agents running — there is nothing. An area
 * would interpolate a value across days on which none started.
 *
 * It shares the window, the filled days and the model colours with the charts
 * above, so a spike in the spend and the burst of agents under it line up
 * without any prose having to claim they are the same fact.
 */
export function AgentDayChart({ rows, width, bands: modelSlots, slots = false, maxColW }: {
  rows: MixDay[];
  width: number;
  bands: ReturnType<typeof modelBands>;
  slots?: boolean;
  maxColW?: number;
}) {
  const height = Math.round(CHART_H * 0.55);
  const countOf = (r: MixDay, match: (alias: string) => boolean) =>
    (r.src.agents ?? []).filter((a) => match(normalizeModel(a.model) ?? a.model))
      .reduce((n, a) => n + a.count, 0);
  const named = new Set(modelSlots.bands.map((b) => b.alias));
  const series: MixSeries<MixDay>[] = [
    ...modelSlots.bands.map((b) => ({
      slot: b.slot,
      name: b.alias.replace(/^claude-/, ""),
      at: (r: MixDay) => countOf(r, (a) => a === b.alias),
    })),
    ...(modelSlots.restSlot != null ? [{
      slot: modelSlots.restSlot,
      name: modelSlots.restName,
      at: (r: MixDay) => countOf(r, (a) => !named.has(a)),
    }] : []),
  ];
  const pts: DayPoint[] = rows.map((r) => ({
    t: r.t, day: r.day,
    v: series.reduce((n, k) => n + (k.at ? k.at(r) : 0), 0),
  }));
  // Whole numbers on the axis — "1.5 agents" is not a reading — and a floor of
  // 1 so a window whose busiest day ran one agent still has an axis.
  const top = Math.max(1, ...pts.map((p) => p.v));
  const p = makeDayPlot({ width, height, pad: PAD, points: pts, yMax: top });
  const ticks = top <= 4
    ? Array.from({ length: top + 1 }, (_, i) => i)
    : [0, Math.round(top / 2), top];
  const cols = stacks(p, rows, series, { normalize: false, maxW: maxColW });
  if (!rows.length) return <div className="empty">No days in this window.</div>;
  return (
    <svg className="ctx-chart" width={width} height={height} viewBox={`0 0 ${width} ${height}`}
      role="img" aria-label="subagents started per day, by model">
      {ticks.map((v) => (
        <line key={v} x1={p.x} x2={p.x + p.w} y1={p.py(v)} y2={p.py(v)} stroke="var(--line)" strokeWidth={1} />
      ))}
      {cols.map(({ point, bands: bs }) => bs.map((b, i) => (
        <rect key={`${point.day}-${i}`} x={b.x} y={b.y} width={b.w} height={Math.max(1, b.h - 1)}
          rx={1.5} fill={MODEL_SLOT[b.slot] ?? SERIES} fillOpacity={0.92}>
          <title>{`${point.day} — ${b.value} × ${b.kind}`}</title>
        </rect>
      )))}
      {ticks.map((v) => (
        <text key={`t${v}`} className="ctx-tick" x={p.x - 6} y={p.py(v) + 3.5} textAnchor="end">{v}</text>
      ))}
      {slots
        ? rows.map((r) => (
          <text key={`d${r.day}`} className="ctx-tick" x={p.px(r.t)} y={height - 6} textAnchor="middle">
            {new Date(r.t).toLocaleDateString(undefined, { weekday: "short" })}
          </text>
        ))
        : dayTicks(p).map((t, i) => (
          <text key={i} className="ctx-tick" x={t.x} y={height - 6} textAnchor={t.anchor}>{t.label}</text>
        ))}
    </svg>
  );
}
