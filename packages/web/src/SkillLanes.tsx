/**
 * The context sheet's skills chart: one row per skill, a mark per load, on the
 * same x axis as the charts above it. Geometry and sentences are pure, in
 * `contextPlot/cplotSkills.ts`; this file only emits SVG and the section
 * around it.
 */
import { useRef, useState } from "react";
import type { AgentRun, ContextEvent, ContextSample, SkillLoad } from "@waterplane/shared";
import { fmtAxisTime, makePlot } from "./contextPlot";
import {
  SKILL_MARK_DY, SKILL_METHOD, SKILL_ROW_H, skillAtPoint, skillReadout, skillRepeatText, skillRows, skillSummary,
  type SkillMark,
} from "./contextPlot/cplotSkills";
import { CTX_SERIES } from "./ContextGraph";

/* The agent lanes' gutter, so a mark lines up with the bar above it. */
const PAD = { top: 4, right: 10, bottom: 20, left: 40 };
const DOT_R = 3.5;

function SkillChart({ samples, events, own, agents, width, picked, onPick }: {
  samples: ContextSample[];
  events: ContextEvent[];
  own: SkillLoad[] | undefined;
  agents: AgentRun[];
  width: number;
  picked: SkillMark | null;
  onPick: (m: SkillMark | null) => void;
}) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  // Only the x half of the plot is used; the rows are this chart's own y.
  const p = makePlot({ width, height: 100, pad: PAD, samples, events, windowTok: null, refs: [], agents });
  const rows = skillRows(p, own, agents);
  const top = PAD.top;
  const plotH = rows.length * SKILL_ROW_H;
  const height = top + plotH + PAD.bottom;
  const span = p.t1 - p.t0;
  const xTicks = [0, 0.5, 1].map((f) => p.tx(p.x + f * p.w));
  const same = (a: SkillMark, b: SkillMark | null) => !!b && a.load === b.load;
  const pickAt = (e: React.PointerEvent<SVGSVGElement>, toggle: boolean) => {
    const box = svgRef.current?.getBoundingClientRect();
    if (!box) return;
    const x = ((e.clientX - box.left) / box.width) * width;
    const y = ((e.clientY - box.top) / box.height) * height;
    const hit = skillAtPoint(rows, top, x, y);
    onPick(toggle && hit && same(hit, picked) ? null : hit);
  };
  return (
    <svg ref={svgRef} className="ctx-chart" width={width} height={height} viewBox={`0 0 ${width} ${height}`}
      onPointerDown={(e) => pickAt(e, true)}
      onPointerMove={(e) => { if (e.buttons) pickAt(e, false); }}
      role="img" aria-label="skills loaded over time, one row per skill">
      {p.breaks.map((b, i) => (
        <g key={`k${i}`}>
          <rect x={b.x} y={top} width={b.w} height={plotH} fill="var(--panel)" />
          {[0, 1].map((k) => (
            <line key={k} x1={b.x + 1 + k * 5} y1={top + plotH} x2={b.x + b.w - 5 + k * 5} y2={top}
              stroke="var(--line)" strokeWidth={1} />
          ))}
        </g>
      ))}
      {rows.map((r, i) => {
        const y = top + i * SKILL_ROW_H;
        return (
          <g key={r.name}>
            <line x1={p.x} x2={p.x + p.w} y1={y + SKILL_MARK_DY + 0.5} y2={y + SKILL_MARK_DY + 0.5}
              stroke="var(--line)" strokeWidth={1} strokeOpacity={0.6} />
            <text className="ctx-tick" x={p.x} y={y + 9}>{r.name}{r.marks.length > 1 ? ` ×${r.marks.length}` : ""}</text>
            {r.marks.map((m, k) => {
              const on = same(m, picked);
              return (
                <circle key={k} cx={m.x} cy={y + SKILL_MARK_DY} r={DOT_R}
                  fill={m.agent ? "var(--panel)" : CTX_SERIES}
                  stroke={on ? "var(--accent)" : m.agent ? "var(--fg)" : CTX_SERIES}
                  strokeOpacity={on ? 1 : m.agent ? 0.6 : 1} strokeWidth={on ? 2 : 1.25} />
              );
            })}
          </g>
        );
      })}
      <line x1={p.x} x2={p.x + p.w} y1={top + plotH + 0.5} y2={top + plotH + 0.5} stroke="var(--line)" strokeWidth={1} />
      {xTicks.map((t, i) => (
        <text key={`x${i}`} className="ctx-tick" x={p.px(t)} y={height - 6}
          textAnchor={i === 0 ? "start" : i === xTicks.length - 1 ? "end" : "middle"}>{fmtAxisTime(t, span)}</text>
      ))}
    </svg>
  );
}

/**
 * The section: name, headline, chart, the tapped mark as text, legend, method.
 * Absent on an older host (`own` undefined and no agent carrying any); a
 * conversation that loaded none gets one sentence instead of an empty chart.
 */
export function SkillSection({ samples, events, own, agents, width, span }: {
  samples: ContextSample[];
  events: ContextEvent[];
  own: SkillLoad[] | undefined;
  agents: AgentRun[];
  width: number;
  span: number;
}) {
  const [picked, setPicked] = useState<SkillMark | null>(null);
  const summary = skillSummary(own, agents);
  if (own === undefined && !summary) return null;
  if (!summary) return <>
    <div className="ctx-chart-title">Skills</div>
    <div className="empty ctx-note">No skill has been loaded in this conversation or its subagents.</div>
  </>;
  const anyAgent = agents.some((a) => a.skills?.length);
  const anyOwn = !!own?.length;
  const p = makePlot({ width: Math.max(width, 1), height: 100, pad: PAD, samples, events, windowTok: null, refs: [], agents });
  const repeat = skillRepeatText(skillRows(p, own, agents));
  return <>
    <div className="ctx-chart-title">Skills</div>
    <div className="ctx-summary">{summary}</div>
    <div className="ctx-box">
      {width > 0 && (
        <SkillChart samples={samples} events={events} own={own} agents={agents}
          width={width} picked={picked} onPick={setPicked} />
      )}
    </div>
    <div className="ctx-readout">
      {picked ? skillReadout(picked, span) : "tap a mark to read that load"}
    </div>
    <div className="ctx-legend">
      {anyOwn && (
        <span><svg width="10" height="10" aria-hidden><circle cx="5" cy="5" r={DOT_R} fill={CTX_SERIES} /></svg> this conversation</span>
      )}
      {anyAgent && (
        <span><svg width="10" height="10" aria-hidden><circle cx="5" cy="5" r={DOT_R} fill="none" stroke="var(--fg)" strokeOpacity={0.6} strokeWidth={1.25} /></svg> a subagent</span>
      )}
    </div>
    {repeat && <div className="empty ctx-note">{repeat}</div>}
    <details className="hint-more ctx-method">
      <summary>how the skills chart is counted</summary>
      <p>{SKILL_METHOD}</p>
    </details>
  </>;
}
