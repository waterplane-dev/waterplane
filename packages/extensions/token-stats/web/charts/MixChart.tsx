/** The stacked day chart: one day as a token-kind or model stack, as bars, an area or normalised. */
import { useCallback, useRef, useState } from "react";
import {
  fmtCount, normalizeModel, TOKEN_KINDS, type TokenDay, tokenTotal, type TokenTotals,
} from "@waterplane/shared";
import {
  type DayPoint, dayTicks, makeDayPlot, type MixSeries, MODEL_SLOT, modelBands, nearestDay,
  SERIES, stackAreas, stacks,
} from "@waterplane/kit";
import { CHART_H, PAD } from "../constants.ts";

/**
 * One day, as every stacked chart on this screen wants it.
 *
 * `totals` is the flat tally the kind stack reads; `src` is the row the scan
 * actually sent, which is where the per-model split and the subagent launches
 * live. Both, because the two stacks read different halves of the same day and
 * a row reduced to either one cannot draw the other.
 */
export interface MixDay {
  t: number;
  day: string;
  totals: TokenTotals;
  src: TokenDay;
}

export function MixChart({ rows, width, normalize, maxColW, slots = false, shape = "bars", by = "kind", bands: modelSlots }: {
  rows: MixDay[];
  width: number;
  normalize: boolean;
  maxColW?: number;
  slots?: boolean;
  /**
   * What the stack is split BY — the four token kinds, or the models that ran.
   *
   * The same numbers and the same geometry; a second question about them. "96%
   * of this was cache reads" is a fact about the traffic and "two thirds of it
   * was opus" is a fact about where the money went, and neither can be read off
   * the other. In the SHARE view the by-model stack is the one that shows a
   * migration: moving from opus to sonnet is a band crossing over, and in a
   * total it is nothing at all.
   */
  by?: "kind" | "model";
  /** Which model wears which slot, over the whole corpus — see `modelBands`.
   *  Required for `by: "model"`, ignored otherwise. */
  bands?: ReturnType<typeof modelBands>;
  /**
   * Columns or stacked areas — a form switch over the same numbers, not a
   * second reading of them.
   *
   * The columns are right while a column still has a width. Past about six
   * weeks on a phone a day's slot is under two pixels, and a stack of
   * two-pixel bars IS an area chart with noise between the bars: the bands are
   * what the eye reads either way, so `area` draws them. The caller passes the
   * GAP-FILLED rows for it (`fillMix`) — see that function for why filling is
   * honest for this series and for no other on the screen.
   */
  shape?: "bars" | "area";
}) {
  const height = CHART_H;
  // In normalized mode the y axis IS 0–100%, stated rather than fitted; in
  // absolute mode it is the usual token scale over the column totals.
  const pts: DayPoint[] = rows.map((r) => ({ t: r.t, day: r.day, v: tokenTotal(r.totals) }));
  const p = makeDayPlot({ width, height, pad: PAD, points: pts, yMax: normalize ? 100 : undefined });
  const kinds: MixSeries<MixDay>[] = by === "model" && modelSlots
    ? [
      ...modelSlots.bands.map((b) => ({
        slot: b.slot,
        name: b.alias.replace(/^claude-/, ""),
        // Summed over every logged id that folds to this alias, so a dated
        // snapshot and the plain alias are one band rather than two.
        at: (r: MixDay) => (r.src.byModel ?? [])
          .filter((m) => (normalizeModel(m.model) ?? m.model) === b.alias)
          .reduce((n, m) => n + tokenTotal(m.totals), 0),
      })),
      ...(modelSlots.restSlot != null ? [{
        slot: modelSlots.restSlot,
        name: modelSlots.restName,
        at: (r: MixDay) => {
          const named = new Set(modelSlots.bands.map((b) => b.alias));
          return (r.src.byModel ?? [])
            .filter((m) => !named.has(normalizeModel(m.model) ?? m.model))
            .reduce((n, m) => n + tokenTotal(m.totals), 0);
        },
      }] : []),
    ]
    : TOKEN_KINDS.map((k) => ({ id: k.id, slot: k.slot, name: k.name }));
  const cols = shape === "bars" ? stacks(p, rows, kinds, { normalize, maxW: maxColW }) : [];
  const bands = shape === "area" ? stackAreas(p, rows, kinds, { normalize }) : [];
  const [hover, setHover] = useState<string | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);

  const onMove = useCallback((e: React.PointerEvent<SVGSVGElement>) => {
    const box = svgRef.current?.getBoundingClientRect();
    if (!box) return;
    setHover(nearestDay(p, pts, ((e.clientX - box.left) / box.width) * width)?.day ?? null);
  }, [p, pts, width]);

  if (!rows.length) return <div className="empty">No days in this window.</div>;
  const shown = hover ? rows.find((r) => r.day === hover) : null;

  return (
    <>
      <svg ref={svgRef} className="ctx-chart" width={width} height={height} viewBox={`0 0 ${width} ${height}`}
        onPointerDown={onMove} onPointerMove={onMove}
        onPointerLeave={() => setHover(null)} onPointerCancel={() => setHover(null)}
        role="img" aria-label={`${normalize ? "share of each token kind per day" : "tokens per day by kind"}, as ${shape === "area" ? "stacked areas" : "stacked columns"}`}>
        {p.yTicks.map((v) => (
          <line key={v} x1={p.x} x2={p.x + p.w} y1={p.py(v)} y2={p.py(v)} stroke="var(--line)" strokeWidth={1} />
        ))}
        {cols.map(({ point, bands: bs }) => bs.map((b, i) => (
          <rect key={`${point.day}-${i}`} x={b.x} y={b.y} width={b.w} height={b.h}
            fill={MODEL_SLOT[b.slot] ?? SERIES}
            fillOpacity={hover && hover !== point.day ? 0.35 : 0.92} />
        )))}
        {/* Bands first, hairline between them second: the divider is drawn as
            the band's own top edge rather than as a gap, because a gap between
            two stacked areas is a hole the reader has to decide the meaning
            of, and at this density it is wider than the smallest band. */}
        {bands.map((b) => b.d && (
          <path key={b.kind} d={b.d} fill={MODEL_SLOT[b.slot] ?? SERIES} fillOpacity={0.9}
            stroke={MODEL_SLOT[b.slot] ?? SERIES} strokeWidth={0.75} strokeOpacity={0.9} />
        ))}
        {p.yTicks.map((v) => (
          <text key={`t${v}`} className="ctx-tick" x={p.x - 6} y={p.py(v) + 3.5} textAnchor="end">
            {normalize ? `${Math.round(v)}%` : fmtCount(v)}
          </text>
        ))}
        {shape === "area" && shown && (
          <line x1={p.px(shown.t)} x2={p.px(shown.t)} y1={p.y} y2={p.y + p.h}
            stroke="var(--fg)" strokeOpacity={0.45} strokeWidth={1} />
        )}
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
      {/* The readout and the legend both follow the SPLIT, never the four kinds
          they used to assume. A chart stacked by model under a legend naming
          token kinds is four correct bands wearing four wrong names, and it is
          the one kind of wrong that looks completely finished. */}
      <div className="ctx-readout">
        {shown
          ? `${new Date(shown.t).toLocaleDateString(undefined, { day: "numeric", month: "short" })} · ${kinds
              .map((k) => `${k.name} ${pctOfSeries(k, shown, kinds)}`).join(" · ")}`
          : "drag across the chart to read a day’s split"}
      </div>
      <div className="ts-legend">
        {kinds.map((k) => (
          <span key={k.name} className="ts-leg"
            title={k.id ? `${k.name} — ${TOKEN_KINDS.find((t) => t.id === k.id)?.what ?? ""}` : k.name}>
            <i style={{ background: MODEL_SLOT[k.slot] ?? SERIES }} />{k.name}
          </span>
        ))}
      </div>
    </>
  );
}

/** One band's share of a day, whatever the band is — a token kind or a model.
 *  `<0.1%` rather than 0%, because a band that is present must never read as
 *  absent. */
function pctOfSeries(k: MixSeries<MixDay>, row: MixDay, all: MixSeries<MixDay>[]): string {
  const val = (kk: MixSeries<MixDay>) => (kk.at ? kk.at(row) : kk.id ? (row.totals[kk.id] as number) : 0);
  const whole = all.reduce((n, kk) => n + val(kk), 0);
  if (whole <= 0) return "—";
  const v = (val(k) / whole) * 100;
  return v > 0 && v < 0.1 ? "<0.1%" : `${v.toFixed(1)}%`;
}
