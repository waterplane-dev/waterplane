import { useCallback, useEffect, useRef, useState } from "react";
import { hhmm } from "./format";
import { gapXs, lineGeom, seriesStats, ticks, type Series } from "./graphGeom";

/**
 * One machine graph on the *This desktop* sheet: the readings across the full
 * width, the scale on the axis, and every line's latest / lowest / highest in
 * words above it. Geometry and its rules are `graphGeom.ts`'s; this only draws.
 *
 * The axis is the frame the caller passes (`lo`..`hi`), never fitted here —
 * a flat line has to mean a flat machine.
 */

export interface GraphLine {
  key: string;
  label: string;
  /** A `.sys-*` tone class, shared with the memory bar's dots. */
  tone: "app" | "wired" | "compressed";
  series: Series;
}

interface Props {
  lines: readonly GraphLine[];
  lo: number;
  hi: number;
  fmt: (v: number) => string;
  /** First and last reading's clock, for the time line under the plot. */
  from?: number;
  to?: number;
  h?: number;
}

/** Room on the right for the axis labels. */
const GUTTER = 46;

export function SysGraph({ lines, lo, hi, fmt, from, to, h = 92 }: Props) {
  const roRef = useRef<ResizeObserver | null>(null);
  const [width, setWidth] = useState(0);
  const boxRef = useCallback((el: HTMLDivElement | null) => {
    roRef.current?.disconnect();
    roRef.current = null;
    if (!el) return;
    setWidth(el.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    roRef.current = ro;
  }, []);
  useEffect(() => () => roRef.current?.disconnect(), []);

  const w = Math.max(40, width - GUTTER);
  const f = { w, h, lo, hi };
  const gaps = gapXs(lines.map((l) => l.series), w);
  const y = (v: number) => h - ((v - lo) / (hi - lo || 1)) * (h - 1) - 0.5;

  return (
    <div className="sg">
      <div className="sg-legend">
        {lines.map((l) => {
          const st = seriesStats(l.series);
          return (
            <span className="sg-key" key={l.key}>
              <span className={`sys-dot sys-${l.tone}`} aria-hidden="true" /> {l.label}
              {st && (
                <>
                  {" "}<b className="sg-now">{fmt(st.last)}</b>
                  <span className="sg-range"> · {st.min === st.max ? "steady" : `${fmt(st.min)}–${fmt(st.max)}`}</span>
                </>
              )}
            </span>
          );
        })}
      </div>
      <div className="sg-plot" ref={boxRef}>
        {width > 0 && (
          <svg width={w + GUTTER} height={h} viewBox={`0 0 ${w + GUTTER} ${h}`} role="img"
            aria-label={lines.map((l) => {
              const st = seriesStats(l.series);
              return st ? `${l.label} ${fmt(st.last)}, between ${fmt(st.min)} and ${fmt(st.max)}` : `${l.label}: no reading`;
            }).join("; ")}>
            {ticks(lo, hi).map((t, i) => (
              <g key={i}>
                <line x1={0} x2={w} y1={y(t)} y2={y(t)} className={i === 2 ? "sg-base" : "sg-grid"} />
                <text x={w + 6} y={i === 0 ? 9 : i === 2 ? h - 1 : y(t) + 3.5} className="sg-tick">{fmt(t)}</text>
              </g>
            ))}
            {gaps.map((x, i) => <line key={`g${i}`} x1={x} x2={x} y1={0} y2={h} className="sg-gap" />)}
            {lines.map((l) => {
              const g = lineGeom(l.series, f);
              return (
                <g key={l.key} className={`sg-line sg-${l.tone}`}>
                  {g.areas.map((pts, i) => <polygon key={`a${i}`} points={pts} className="sg-area" />)}
                  {g.runs.map((pts, i) => <polyline key={`r${i}`} points={pts} className="sg-stroke" />)}
                  {g.dots.map((d, i) => <circle key={`d${i}`} cx={d.x} cy={d.y} r={2} className="sg-dot" />)}
                </g>
              );
            })}
          </svg>
        )}
      </div>
      {from != null && to != null && to > from && (
        <div className="sg-time" style={{ marginRight: GUTTER }}>
          <span>{hhmm(from)}</span>
          <span>{hhmm(to)}</span>
        </div>
      )}
    </div>
  );
}
