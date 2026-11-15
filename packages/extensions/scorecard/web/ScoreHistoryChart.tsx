/**
 * The score over time, under the score: a fixed 0–10 axis labelled on every rule, one point per
 * Scorecard run in reading order, ink line, the picked (or latest) run as the accent dot. Its answer
 * is a TEXT line under the chart — day · score · commit, then which checks moved since the run
 * before — the only route to a past run's figure, so it is always there. Geometry and words:
 * `historyPlot.ts`.
 */
import { useRef, useState, type PointerEvent } from "react";
import { useStore } from "@waterplane/sdk";
import { Button, Explain, ScrubHint, useBoxWidth } from "@waterplane/kit";
import { absentWords, AXIS_WORDS, geom, pickIndex, PLOT_H, PAD, readout, spanWords } from "./historyPlot.ts";
import { histories } from "./state.ts";

export function ScoreHistoryChart({ repo }: { repo: string }) {
  const h = useStore(histories).get(repo);
  const [width, boxRef] = useBoxWidth();
  const [pick, setPick] = useState<number | null>(null);
  const before = useRef<number | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  if (!h) return null;
  const pts = h.points;
  const g = geom(pts, width);
  const absent = absentWords(pts.length, h.pending === true, pts[0]);
  const at = (e: PointerEvent<SVGSVGElement>) => {
    if (!g || !svgRef.current) return;
    const r = svgRef.current.getBoundingClientRect();
    setPick(pickIndex(g, e.clientX - r.left));
  };
  const i = pick != null && pick < pts.length ? pick : pts.length - 1;
  const ro = pts.length ? readout(pts, i) : null;
  return (
    <div className="sc-hist" ref={boxRef}>
      <div className="section section-head"><span>Score over time</span><Explain of="the score over time"><p>{AXIS_WORDS}</p></Explain></div>
      {absent ? <div className="sc-cap">{absent}</div> : null}
      {g ? (
        <svg ref={svgRef} className="sc-hist-svg" width={g.w} height={PLOT_H} viewBox={`0 0 ${g.w} ${PLOT_H}`} role="img"
          aria-label={`Scorecard score over ${pts.length} runs, axis 0 to 10; latest ${pts[pts.length - 1]!.score}`}
          onPointerDown={(e) => { before.current = pick; at(e); }} onPointerMove={at}
          onPointerCancel={() => setPick(before.current)}
          onPointerLeave={(e) => { if (e.pointerType === "mouse") setPick(null); }}>
          {g.rules.map((r) => (
            <g key={r.v}>
              <line x1={PAD.left} x2={g.w - PAD.right} y1={r.y} y2={r.y} stroke="currentColor" strokeOpacity={0.14} strokeDasharray="2 3" />
              <text className="sc-tick" x={PAD.left - 5} y={r.y + 3.5} textAnchor="end">{r.v}</text>
            </g>
          ))}
          {g.ticks.map((t) => <text key={t.x} className="sc-tick" x={t.x} y={PLOT_H - 4} textAnchor={t.anchor}>{t.label}</text>)}
          <path d={g.d} fill="none" stroke="currentColor" strokeOpacity={0.75} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
          {/* Per-run dots only while they stay apart; past that they are a grey bead chain over the line. */}
          {g.pts.length <= 12 ? g.pts.map((p, k) => <circle key={k} cx={p.x} cy={p.y} r={1.8} fill="currentColor" fillOpacity={0.75} />) : null}
          <circle cx={g.pts[i]!.x} cy={g.pts[i]!.y} r={4} fill="var(--accent)" stroke="var(--panel)" strokeWidth={1.5} />
        </svg>
      ) : null}
      {g && ro ? (
        <div className="sc-read">
          {/* Untouched, the head would repeat the score above: the hint holds its slot until a pick. */}
          {pick == null ? <ScrubHint /> : (
            <div className="sc-read-head"><span>{ro.head}</span>{pick !== pts.length - 1 ? <Button onClick={() => setPick(null)}>latest</Button> : null}</div>
          )}
          {ro.moved ? <div className="sc-cap">{pick == null ? `latest run: ${ro.moved}` : ro.moved}</div> : null}
        </div>
      ) : null}
      {pts.length ? <div className="sc-cap">{spanWords(pts.length, h.local === true)}</div> : null}
      {h.pending && g ? <div className="sc-cap">Reading more past runs back…</div> : null}
      {h.note ? <div className="sc-cap">{h.note}</div> : null}
    </div>
  );
}
