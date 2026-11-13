/**
 * One agent reading as weekly bars (geometry `agentWeekPlot.ts`). The bars are
 * the region's WEEK PICKER: a tap anywhere in a week's slot picks it for every
 * chart, and the answer is the TEXT line under the chart (`readout`), never a
 * floating box. The picked week's column wears a band behind it, not a status
 * colour; a week whose reading was not taken is a dashed outline at the floor.
 * Both y bounds are printed (0 and the top), so a short bar is never read
 * against an unlabelled axis.
 */
import { useRef } from "react";
import { SLOT } from "./kit/chart/TokenComposition";
import { useBoxWidth } from "./kit/chart/useBoxWidth";
import { colAt, labelCols, weekBars } from "./agentWeekPlot";
import { noneIn, weekChip } from "./agentReadingsWords";

const H = 96;
const PAD_TOP = 6;
const AXIS_H = 16;
const GUTTER = 40;

export function AgentWeekBars({ weeks, values, picked, onPick, fmtTick, parts, label }: {
  weeks: readonly string[];
  /** Per week, the stack's parts in slot order, or null where the reading was not taken. */
  values: readonly (readonly number[] | null)[];
  picked: number;
  onPick: (i: number) => void;
  fmtTick: (v: number) => string;
  /** Legend names for a stack of more than one part, in slot order. */
  parts?: readonly string[];
  label: string;
}) {
  const [width, box] = useBoxWidth();
  const svg = useRef<SVGSVGElement | null>(null);
  const plotW = Math.max(1, width - GUTTER - 4);
  const g = weekBars(values, plotW, H, GUTTER, PAD_TOP);
  const n = weeks.length;
  const labels = labelCols(n, picked, (i) => g.cols[i]!.cx, 38);

  const pick = (e: React.PointerEvent<SVGSVGElement>) => {
    const el = svg.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const x = ((e.clientX - r.left) / Math.max(1, r.width)) * width;
    const i = colAt(x, GUTTER, plotW, n);
    if (i >= 0 && i !== picked) onPick(i);
  };

  const slotW = plotW / Math.max(1, n);
  if (g.cols.every((c) => !c.total)) {
    // Every week zero or not taken: an axis over empty slots reads as a broken chart.
    // A week not taken still says why in the readout line under this.
    return g.cols.some((c) => c.total === 0) ? <div className="rh-cap">{noneIn(n)}</div> : null;
  }
  const pc = g.cols[picked];
  return (
    <div ref={box} className="ar-bars">
      {width > 0 ? (
        <svg ref={svg} width={width} height={PAD_TOP + H + AXIS_H} viewBox={`0 0 ${width} ${PAD_TOP + H + AXIS_H}`}
          onPointerDown={pick} onPointerMove={(e) => { if (e.buttons) pick(e); }}
          role="img" aria-label={`${label}, one bar per week`} style={{ touchAction: "pan-y" }}>
          {pc ? <rect x={pc.cx - slotW / 2} y={PAD_TOP} width={slotW} height={H} fill="var(--accent)" fillOpacity={0.2} rx={3} /> : null}
          <line x1={GUTTER} x2={width - 4} y1={g.base} y2={g.base} stroke="var(--line)" />
          <text className="rh-tick" x={GUTTER - 5} y={PAD_TOP + 7} textAnchor="end">{fmtTick(g.top)}</text>
          <text className="rh-tick" x={GUTTER - 5} y={g.base + 3.5} textAnchor="end">0</text>
          {g.cols.map((c, i) => c.parts ? (
            <g key={i}>
              {/* A real zero is a floor tick, so the dashed box means only "not taken". */}
              {c.parts.length ? c.parts.map((p) => (
                <rect key={p.slot} x={c.x} y={p.y} width={c.w} height={p.h} fill={SLOT[p.slot % SLOT.length]}
                  fillOpacity={i === picked ? 1 : 0.7} />
              )) : <rect x={c.x} y={g.base - 2} width={c.w} height={2} fill="var(--fg)" fillOpacity={0.5} />}
              {i === picked && c.parts.length ? (
                <rect x={c.x - 1} y={Math.min(...c.parts.map((p) => p.y)) - 3} width={c.w + 2} height={2} fill="var(--accent)" />
              ) : null}
            </g>
          ) : (
            <rect key={i} x={c.x + 0.5} y={g.base - 10} width={c.w - 1} height={10} fill="none"
              stroke="var(--fg)" strokeOpacity={0.45} strokeDasharray="2 2" />
          ))}
          {labels.map((i) => (
            <text key={i} className="rh-tick" x={g.cols[i]!.cx} y={g.base + 13} textAnchor="middle"
              fontWeight={i === picked ? 650 : undefined}>{weekChip(weeks[i]!)}</text>
          ))}
        </svg>
      ) : null}
      {parts && parts.length > 1 ? (
        <ul className="rh-legend">
          {parts.map((p, i) => (
            <li key={p}><span className="rh-swatch" style={{ background: SLOT[i % SLOT.length] }} aria-hidden />{p}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
