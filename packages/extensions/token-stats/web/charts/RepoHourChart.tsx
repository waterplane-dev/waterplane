/** The week, an hour per column, stacked by repo, with the weekly percentage on a fixed right axis. */
import { useRef } from "react";
import { fmtUsdShort, HOUR_MS, type UsageSample, usageSegments, type WeekBucket } from "@waterplane/shared";
import { dayTicks, makeDayPlot, SLOT } from "@waterplane/kit";
import { CHART_H } from "../constants.ts";
import { columnBands, OTHER_SLOT } from "../weekBands.ts";

/** Wider on the right than the screen's other charts: the right axis carries `100%`. */
const PAD = { top: 10, right: 34, bottom: 20, left: 46 };

/** A repo slot's fill: one of the four validated hues, or the fold's hueless grey. */
export function slotFill(slot: number): string {
  return slot === OTHER_SLOT ? "var(--muted)" : SLOT[slot] ?? "var(--muted)";
}

/**
 * Where the week's money went, hour by hour.
 *
 * Hand-rolled SVG on `makeDayPlot` with an hour step — the intraday geometry `DayChart` uses —
 * over a FIXED x domain, the hour the week's cut starts on (`windowStartHour`) to the end of the hour running
 * now: an hour nothing ran in is a real gap (no column), never a zero bar drawn as something.
 * Columns stack by repo band (`columnBands`: slots follow the repo, never re-ranked per column),
 * accumulated in value space. The weekly percentage is ink on a 0–100 axis that is fixed and
 * labelled (an unlabelled fixed axis reads as a fitted one), cut at every rollover or gap by
 * `usageSegments` — the kit rule, never joined across.
 *
 * A tap picks an hour — a FILTER on the list below, so the picked hour is the card's state (its
 * key, never pixels) and the column is outlined rather than recoloured. A gesture the browser
 * takes back (`pointercancel`: a scroll that began on the chart) restores the pick it began
 * with; a second tap on the picked column lets go.
 */
export function RepoHourChart({ buckets, slots, samples, everyMs, from, now, width, picked, onPick, limitAxis = true, height = CHART_H }: {
  buckets: WeekBucket[];
  slots: ReadonlyMap<string, number>;
  samples: readonly UsageSample[];
  everyMs: number;
  /** The hour the span's cut starts on (`CostWindowDoc.fromHour` — `windowStartHour` of the reset). */
  from: number;
  now: number;
  width: number;
  picked: string | null;
  onPick: (hour: string | null) => void;
  /** Draw the weekly-limit % axis. False where no limit readings exist to draw against it (the VS
   *  Code panel): an empty labelled 0–100% axis claims a line that is not there. */
  limitAxis?: boolean;
  /** The plot's height — shorter in the token sheet's "now" block, which leads the screen. */
  height?: number;
}) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const before = useRef<string | null>(null);
  /** The column the gesture began on: the scrub leaves it to the tap (a jittery tap that let
   *  go of the pick must not pick it again on its first pointermove). */
  const startH = useRef<string | null>(null);
  const lastTop = Math.max(from, new Date(now).setMinutes(0, 0, 0));
  // Columns sit at the middle of their hour; two zero sentinels pin the domain to the span
  // without moving the peak.
  const half = HOUR_MS / 2;
  const pts = [
    { t: from + half, v: 0, day: "" },
    ...buckets.map((b) => ({ t: b.t + half, v: b.usd, day: b.hour })),
    { t: lastTop + half, v: 0, day: "" },
  ].sort((a, b) => a.t - b.t);
  const p = makeDayPlot({ width, height, pad: PAD, points: pts, stepMs: HOUR_MS });
  const colW = Math.max(1, Math.min(10, p.slot * (p.slot > 4 ? 0.75 : 0.9)));
  const py2 = (v: number) => p.y + p.h - (Math.max(0, Math.min(100, v)) / 100) * p.h;
  const t0 = from;
  const t1 = lastTop + HOUR_MS;
  const inSpan = samples.filter((s) => s.t >= t0 && s.t <= t1);
  const segs = usageSegments(inSpan, "week", Math.max(45 * 60_000, everyMs * 3));
  const line = (seg: (typeof segs)[number]) =>
    seg.pts.map((s, i) => `${i ? "L" : "M"}${p.px(s.t).toFixed(1)},${py2(s.v).toFixed(1)}`).join("");
  const at = picked ? buckets.find((b) => b.hour === picked) ?? null : null;

  const hourAt = (e: { clientX: number }): string | null => {
    const r = svgRef.current?.getBoundingClientRect();
    if (!r?.width || !buckets.length) return null;
    const x = ((e.clientX - r.left) / r.width) * width;
    const t = p.t0 + ((x - p.x) / p.w) * (p.t1 - p.t0);
    let best: WeekBucket | null = null;
    for (const b of buckets) if (!best || Math.abs(b.t + half - t) < Math.abs(best.t + half - t)) best = b;
    // A tap more than an hour from any drawn column is a tap on a gap — nothing ran there.
    return best && Math.abs(best.t + half - t) <= Math.max(HOUR_MS, (p.t1 - p.t0) / p.w * 6) ? best.hour : null;
  };

  return (
    <svg ref={svgRef} className="ctx-chart" width={width} height={height} viewBox={`0 0 ${width} ${height}`}
      role="img" aria-label={limitAxis ? "dollars per hour since the weekly reset, stacked by repo, with the weekly limit percentage" : "dollars per hour, stacked by repo"}
      onPointerDown={(e) => {
        before.current = picked;
        const h = hourAt(e);
        startH.current = h;
        if (h) onPick(h === picked ? null : h);
      }}
      onPointerMove={(e) => {
        // Only a pressed pointer scrubs: a pick is a filter, and a mouse passing over must not
        // re-cut the list under it.
        if (!e.buttons) return;
        const h = hourAt(e);
        if (h && h !== picked && h !== startH.current) { startH.current = null; onPick(h); }
      }}
      onPointerCancel={() => onPick(before.current)}>
      {p.yTicks.map((v) => (
        <line key={v} x1={p.x} x2={p.x + p.w} y1={p.py(v)} y2={p.py(v)} stroke="var(--line)" strokeWidth={1} />
      ))}
      {buckets.map((b) => {
        const x = p.px(b.t + half) - colW / 2;
        return (
          <g key={b.hour}>
            {columnBands(b.byRepo, slots).map((band) => {
              const y = p.py(band.v1);
              return <rect key={band.key} x={x} y={y} width={colW} height={Math.max(band.usd > 0 ? 0.75 : 0, p.py(band.v0) - y)}
                fill={slotFill(band.slot)} />;
            })}
            {/* An hour the host had no repo split for (a conversation named it, the hour rows did
                not) is still drawn, as one hueless column — what ran is never left off. */}
            {!b.byRepo.some((r) => r.cost?.total > 0) && b.usd > 0 && (
              <rect x={x} y={p.py(b.usd)} width={colW} height={Math.max(0.75, p.py(0) - p.py(b.usd))} fill="var(--muted)" />
            )}
          </g>
        );
      })}
      {at && (
        <rect x={p.px(at.t + half) - colW / 2 - 2} y={p.y} width={colW + 4} height={p.h} rx={2}
          fill="none" stroke="var(--fg)" strokeOpacity={0.7} strokeWidth={1.25} pointerEvents="none" />
      )}
      {segs.map((seg, i) => (
        <g key={i} pointerEvents="none">
          {seg.rolled && seg.pts.length > 0 && (
            <line x1={p.px(seg.pts[0].t)} x2={p.px(seg.pts[0].t)} y1={p.y} y2={p.y + p.h}
              stroke="var(--fg)" strokeOpacity={0.3} strokeWidth={1} strokeDasharray="3 3" />
          )}
          <path d={line(seg)} fill="none" stroke="var(--fg)" strokeOpacity={0.75} strokeWidth={1.5}
            strokeLinejoin="round" strokeLinecap="round" />
          {seg.pts.length === 1 && <circle cx={p.px(seg.pts[0].t)} cy={py2(seg.pts[0].v)} r={2} fill="var(--fg)" />}
        </g>
      ))}
      {p.yTicks.map((v) => (
        <text key={`t${v}`} className="ctx-tick" x={p.x - 6} y={p.py(v) + 3.5} textAnchor="end">{fmtUsdShort(v)}</text>
      ))}
      {/* The right axis: the weekly percentage, 0–100 fixed, all three rules labelled. */}
      {limitAxis && [0, 50, 100].map((v) => (
        <g key={`r${v}`}>
          <line x1={p.x + p.w} x2={p.x + p.w + 4} y1={py2(v)} y2={py2(v)} stroke="var(--muted)" strokeWidth={1} />
          <text className="ctx-tick" x={p.x + p.w + 6} y={py2(v) + 3.5} textAnchor="start">{v}%</text>
        </g>
      ))}
      {dayTicks(p).map((t, i) => (
        <text key={i} className="ctx-tick" x={t.x} y={height - 6} textAnchor={t.anchor}>{t.label}</text>
      ))}
    </svg>
  );
}
