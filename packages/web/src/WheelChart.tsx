/**
 * The model · effort wheel as a controlled chart: one spoke per model, effort
 * rings from the centre (lowest) to the rim (highest). Draws and reports a
 * selection; deciding what a pick DOES is the caller's — the live session's
 * popover (`core/session/ModelWheel.tsx`) and the new-session ask
 * (`LaunchAskSheet.tsx`) mean different things by the same point.
 *
 * Both callers draw it through `WheelPicker` below — the sentence above, the
 * chart, the model chips under it — so the two places cannot drift into two
 * looks. The sentence goes ABOVE, never under: the finger choosing a point sits
 * on the chart, and on a phone whatever is below it is under the hand. Pure
 * rules (spokes, hit test) are `modelWheel.ts`.
 *
 * Quiet on purpose: the rings are faint circles, not a web of polygons, and a
 * pick marks ONE dot — never a filled ring. The dot is the answer; a shaded
 * band reads as "everything inside this" and a chart, not a control.
 */
import { useState, useRef, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import type { Effort } from "@waterplane/shared";
import { MAX_SPOKES, nodeAt, nodeXY, ringRadius, spokeAngle, spokeLabel, wheelCandidates, wheelSpokes, type WheelGeom } from "./modelWheel";
import { LS, lsJson, lsSetJson } from "./storage";
import { Hint } from "./kit/Hint";

// The drawing's own units; the SVG scales to its container's width. Wider than
// tall because spoke labels run sideways off the left and right spokes.
const VB_W = 380;
const VB_H = 300;
const R_IN = 40;
const R_OUT = 112;
const LABEL_R = R_OUT + 16;

export interface WheelPick { model: string; effort: Effort | null }

export interface WheelChartProps {
  spokes: string[];
  /** Empty ⇒ one ring and a pick carries `effort: null`. */
  efforts: Effort[];
  /** Where the session is now, marked in green — absent before a session exists. */
  current?: { model?: string; effort?: Effort };
  value: WheelPick | null;
  onPick(p: WheelPick): void;
}

export function WheelChart({ spokes, efforts, current, value, onPick }: WheelChartProps): ReactNode {
  const g: WheelGeom = { spokes: spokes.length, rings: Math.max(1, efforts.length), rIn: R_IN, rOut: R_OUT };
  const curSpoke = current?.model ? spokes.indexOf(current.model) : -1;
  const curRing = current?.effort ? efforts.indexOf(current.effort) : -1;
  const selSpoke = value ? spokes.indexOf(value.model) : -1;
  const selRing = value?.effort ? efforts.indexOf(value.effort) : efforts.length === 0 && value ? 0 : -1;
  const svgRef = useRef<SVGSVGElement>(null);
  const dragging = useRef(false);

  // Screen point → drawing units, centred. Through the SVG's own CTM so the
  // container's width (and the UI scale) never skews the hit test.
  const pickAt = (e: ReactPointerEvent) => {
    const m = svgRef.current?.getScreenCTM();
    if (!m) return;
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse());
    const hit = nodeAt(p.x, p.y, g);
    if (hit) onPick({ model: spokes[hit.spoke], effort: efforts.length > 0 ? efforts[hit.ring] : null });
  };

  // Effort labels sit in the gap between the first two spokes, so they never
  // collide with a spoke line or its model label.
  const labelA = spokeAngle(0.5, g.spokes);

  return (
    <svg ref={svgRef} className="model-wheel" viewBox={`${-VB_W / 2} ${-VB_H / 2} ${VB_W} ${VB_H}`}
      role="img" aria-label="model and effort wheel"
      onPointerDown={(e) => { dragging.current = true; e.currentTarget.setPointerCapture(e.pointerId); pickAt(e); }}
      onPointerMove={(e) => { if (dragging.current) pickAt(e); }}
      onPointerUp={() => { dragging.current = false; }}
      onPointerCancel={() => { dragging.current = false; }}>
      {/* One faint circle per effort ring — a guide for the eye, never shaded. */}
      {Array.from({ length: g.rings }, (_, r) => (
        <circle key={r} cx={0} cy={0} r={ringRadius(r, g)} className="mw-ring" />
      ))}
      {spokes.map((m, s) => {
        const a = spokeAngle(s, g.spokes);
        const c = Math.cos(a);
        const anchor = Math.abs(c) < 0.2 ? "middle" : c > 0 ? "start" : "end";
        const cls = `mw-label${s === curSpoke ? " cur" : ""}${s === selSpoke ? " sel" : ""}`;
        return (
          <g key={m}>
            <line x1={0} y1={0} x2={R_OUT * c} y2={R_OUT * Math.sin(a)} className="mw-spoke" />
            <text x={LABEL_R * c} y={LABEL_R * Math.sin(a)} textAnchor={anchor} dominantBaseline="middle" className={cls}>{spokeLabel(m)}</text>
          </g>
        );
      })}
      {efforts.length > 1 && efforts.map((e, r) => {
        const rr = ringRadius(r, g);
        return (
          <text key={e} x={rr * Math.cos(labelA)} y={rr * Math.sin(labelA)} textAnchor="middle" dominantBaseline="middle"
            className={`mw-effort${selRing === r ? " sel" : ""}`}>{e}</text>
        );
      })}
      {spokes.map((m, s) => Array.from({ length: g.rings }, (_, r) => {
        const p = nodeXY(s, r, g);
        const isCur = s === curSpoke && (efforts.length === 0 || r === curRing);
        const isSel = s === selSpoke && r === selRing;
        return <circle key={`${m}:${r}`} cx={p.x} cy={p.y} r={isSel ? 8 : isCur ? 6.5 : 3.5}
          className={`mw-node${isCur ? " cur" : ""}${isSel ? " sel" : ""}`} />;
      }))}
      <circle cx={0} cy={0} r={3} className="mw-hub" />
    </svg>
  );
}

export interface WheelPickerProps {
  /** The backend's catalogue (`modelChoices`). */
  cat: { aliases: string[]; ids: string[] };
  efforts: Effort[];
  /** The live session's launch, marked in green — absent before a session exists. */
  current?: { model?: string; effort?: Effort };
  value: WheelPick | null;
  onPick(p: WheelPick): void;
  /** The selection's model was taken off the wheel — drop the pick. */
  onClear?(): void;
  /** The line above the sentence: where this session is, or will start. */
  now: ReactNode;
  /** The sentence above the chart: what the point under the finger means. */
  says: ReactNode;
  /** Drawn between the chart and the model chips (Apply, version chips). */
  children?: ReactNode;
}

/**
 * The wheel as both places draw it: sentence, chart, then the models it may
 * carry as chips that latch — on means "a spoke". Which ones are off is
 * `LS.wheelHidden`, one list for both wheels. The model the session runs (or,
 * before one exists, the one picked) stays a spoke even when its chip is off,
 * and the note under the chips says so rather than the chip refusing the tap.
 */
export function WheelPicker({ cat, efforts, current, value, onPick, onClear, now, says, children }: WheelPickerProps): ReactNode {
  const [hidden, setHidden] = useState<string[]>(() => lsJson<string[]>(LS.wheelHidden, []));
  const keep = current?.model ?? value?.model;
  const spokes = wheelSpokes(cat, keep, hidden);
  const all = wheelCandidates(cat);
  const shown = all.filter((m) => !hidden.includes(m));
  const toggle = (m: string) => {
    const next = hidden.includes(m) ? hidden.filter((h) => h !== m) : [...hidden, m];
    setHidden(next);
    lsSetJson(LS.wheelHidden, next);
    if (next.includes(m) && value?.model === m && m !== keep) onClear?.();
  };
  return (
    <>
      <div className="mw-now muted">{now}</div>
      <Hint className="mw-says">{says}</Hint>
      <WheelChart spokes={spokes} efforts={efforts} current={current} value={value} onPick={onPick} />
      {children}
      {all.length > 1 && (
        <div className="mw-models">
          <div className="mw-models-head muted">On the wheel · {spokes.length} of {all.length}</div>
          <div className="mw-chips">
            {all.map((m) => {
              const on = !hidden.includes(m);
              return (
                <button key={m} className={`row-chip${on ? " on" : ""}`} aria-pressed={on} onClick={() => toggle(m)}>
                  {spokeLabel(m)}
                </button>
              );
            })}
          </div>
          {keep && hidden.includes(keep) && (
            <Hint>{spokeLabel(keep)} stays on the wheel while it is {current ? "this session’s model" : "the pick"}.</Hint>
          )}
          {shown.length > MAX_SPOKES && (
            <Hint>The wheel holds {MAX_SPOKES}; the first {MAX_SPOKES} chips that are on are drawn.</Hint>
          )}
        </div>
      )}
    </>
  );
}
