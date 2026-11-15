/**
 * "By model" — the Agent readings over time card's second view (R-metrics-072): every setup-panel
 * reading over the chosen days, split by the model a session ran on, side by side, with the same
 * day-shuffle band as the before and after. The numbers and the absences are shared
 * `compareByModel`; the words are `agentSeriesPlot.ts`. The usual state is one model only: that
 * is said in one sentence, and how to get a comparison (alternate by day) is in the `?`.
 */
import { useMemo } from "react";
import { BY_MODEL_ALTERNATE_TEXT, BY_MODEL_WINDOWS, compareByModelAll, type AgentPoint, type ByModelResult } from "@waterplane/shared";
import { Button, Explain } from "@waterplane/kit";
import { byModelHelp, byModelNotes, byModelSideWords, byModelWords, ratioScale, readingDef } from "./agentSeriesPlot.ts";

const PAD = 8;

function Strip({ r, width }: { r: ByModelResult; width: number }) {
  const s = ratioScale(r.ratio, r.band, Math.max(60, width - 2 * PAD));
  return (
    <svg width={width} height={34} role="img" aria-label="the ratio against the band of normal variation">
      <g transform={`translate(${PAD} 0)`}>
        <rect x={s.band[0]} y={6} width={Math.max(1, s.band[1] - s.band[0])} height={14} fill="var(--fg)" fillOpacity={0.1} stroke="var(--line)" />
        <line x1={s.one} x2={s.one} y1={3} y2={23} stroke="var(--muted)" strokeDasharray="2 2" />
        <circle cx={s.ratio} cy={13} r={4.5} fill="var(--fg)" stroke="var(--panel)" strokeWidth={1.5} />
        {s.ticks.map((t, i) => <text key={i} x={t.x} y={32} fontSize={9} fill="var(--muted)" textAnchor={i === 0 ? "start" : i === 2 ? "end" : "middle"}>×{t.r}</text>)}
      </g>
    </svg>
  );
}

export function AgentModelCompare({ points, width, days, setDays, hueOf }: {
  points: readonly AgentPoint[];
  width: number;
  days: number;
  setDays: (d: number) => void;
  hueOf: (model: string) => string;
}) {
  const all = useMemo(() => compareByModelAll(points, { now: Date.now(), days }), [points, days]);
  const shown = all.filter((x) => !("absent" in x.r));
  // One model only (or no model at all) on every reading: one sentence, not four.
  const lone = shown.length === 0 && all.every((x) => "absent" in x.r && x.r.kind !== "tooFew") ? all[0]! : null;
  const notes = [...new Set(shown.flatMap((x) => byModelNotes(x.r as ByModelResult)))];
  const swatch = (m: string) => <span aria-hidden="true" style={{ display: "inline-block", width: 8, height: 8, borderRadius: 2, marginRight: 5, background: hueOf(m) }} />;

  return (<>
    <div className="ts-filter" role="group" aria-label="days">
      <span className="ts-scope-tag">last</span>
      {BY_MODEL_WINDOWS.map((d) => (
        <Button key={d} className={d === days ? "active" : undefined} onClick={() => setDays(d)}>{d} days</Button>
      ))}
      <Explain of="compare by model">{byModelHelp(BY_MODEL_ALTERNATE_TEXT)}</Explain>
    </div>
    {lone && "absent" in lone.r ? <div className="empty ts-caveat">{lone.r.absent}</div> : all.map(({ reading, r }) => {
      const def = readingDef(reading);
      return (
        <div key={reading} className="ctx-box">
          <div className="section section-head"><span>{def.label}</span></div>
          {"absent" in r ? <div className="empty ts-caveat">{r.absent}</div> : (<>
            <div className="empty ts-caveat">{swatch(r.a.model)}{byModelSideWords(def, r, "a")}</div>
            <div className="empty ts-caveat">{swatch(r.b.model)}{byModelSideWords(def, r, "b")}</div>
            <div className="empty ts-caveat">{byModelWords(r)}</div>
            {width > 0 && <Strip r={r} width={width} />}
          </>)}
        </div>
      );
    })}
    {notes.map((n) => <div key={n} className="empty ts-caveat">{n}</div>)}
  </>);
}
