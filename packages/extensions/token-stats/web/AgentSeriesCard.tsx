/**
 * "Agent readings over time": did agents get cheaper or faster after an instruction change?
 *
 * One card, one repo (default: the one in front of you) or every repo, one model at a time, one
 * reading at a time, on a day or week axis, with what changed drawn beneath it as shapes. Tap a
 * mark to read the same reading 14 days before and after it next to the band that day-to-day
 * variation alone makes. Geometry and every sentence are `agentSeriesPlot.ts`; the medians and
 * the comparison are shared `agentseries/`. It judges nothing, and a reading with too few sessions
 * says so rather than drawing a zero.
 */
import { useMemo, useState } from "react";
import {
  compareAround, derivedMarkers, normalizeModel, repoLabel, seriesOf, START_PARTS,
  type AgentMarker, type AgentPoint, type SeriesBucket, type SeriesReading,
} from "@waterplane/shared";
import { Empty, MODEL_SLOT, modelBands, SERIES, SLOT, useBoxWidth, useRemoteResource, Button } from "@waterplane/kit";
import { ledgers, useCore } from "@waterplane/sdk";
import { ScopeCard } from "./TokenInsights.tsx";
import {
  absentSummary, absentWhy, allAbsent, axisOf, clipBuckets, COMPARE_NOTE, compareWords, coverFrom, dayGrainOffered, fmtKChars, fmtReading,
  type Grain, MARKER_KINDS, markerKind, markerWords, medianOrNull, MARK_GAP, MARK_ROW_H, markerPickLabel, foldedCompareWords, modelsIn, partBands, partTwinWords, placeMarkers,
  type PlacedMarker, ratioScale, READINGS, readingDef, runsOf, shapePath, slotAtX, slotX, stackTops, valuesOnAxis, yScale,
} from "./agentSeriesPlot.ts";

const PAD_L = 44;
const PAD_R = 8;
const CHART_H = 110;
const ROW_H = MARK_ROW_H;

type Scope = string; // a repo id, or "all"

export function AgentSeriesCard({ online }: { online: boolean }) {
  const c = useCore();
  const targets = c.world.repos.filter((r) => r.isPrimary);
  const [scope, setScope] = useState<Scope>(() => c.world.activeRepo?.id ?? "all");
  const [grainPick, setGrain] = useState<Grain>("week");
  const [reading, setReading] = useState<SeriesReading>("start");
  const [picked, setPicked] = useState<string | null>(null);
  const [mark, setMark] = useState<string | null>(null);
  /** Which change of a folded mark the before/after is centred on (index into its `markers`); 0 = the earliest. */
  const [markSub, setMarkSub] = useState(0);
  const [slot, setSlot] = useState<number | null>(null);
  const [width, boxRef] = useBoxWidth();
  const one = scope !== "all";

  const pts = useRemoteResource(`agentpoints:${scope}`, () => ledgers.agentPoints(one ? scope : null), { offline: !online });
  const mk = useRemoteResource(`agentmarkers:${scope}`, () => ledgers.agentMarkers(scope), { offline: !online, enabled: one });
  const doc = pts.data && pts.data.ok ? pts.data : null;
  const refusal = pts.data && !pts.data.ok ? pts.data.error : null;

  const def = readingDef(reading);
  const cover = useMemo(() => (doc ? coverFrom(doc.points, doc.cut) : null), [doc]);
  const points = useMemo<AgentPoint[]>(() => {
    if (!doc) return [];
    if (!cover?.from) return doc.points;
    const [y, m, d] = cover.from.split("-").map(Number) as [number, number, number];
    const from = new Date(y, m - 1, d).getTime();
    return doc.points.filter((p) => p.t0 >= from);
  }, [doc, cover]);

  // A window too wide for day slots loses the Day chip; a picked Day then reads as Week.
  const dayOk = useMemo(() => dayGrainOffered(points), [points]);
  const grain: Grain = grainPick === "day" && !dayOk ? "week" : grainPick;
  const { models, unnamed } = useMemo(() => modelsIn(points, reading), [points, reading]);
  const model = picked && models.some((m) => m.model === picked) ? picked : models[0]?.model;
  const { bands: mbands, restSlot } = useMemo(
    () => modelBands(models.map((m) => ({ key: m.model, label: normalizeModel(m.model) ?? m.model }))), [models]);
  const hueOf = (id: string): string => {
    const alias = normalizeModel(id) ?? id;
    const s = mbands.find((b) => b.alias === alias)?.slot ?? restSlot ?? 0;
    return MODEL_SLOT[s] ?? "var(--muted)";
  };

  const series = useMemo(() => {
    const raw: SeriesBucket[] = seriesOf(points, { grain, ...(model ? { model } : {}) });
    return clipBuckets(raw, cover?.from ?? null);
  }, [points, grain, model, cover]);
  const left = PAD_L;
  const right = Math.max(left + 40, width - PAD_R);
  const axis = useMemo(() => axisOf(series.map((b) => b.key), grain), [series, grain]);
  const n = axis.keys.length;

  const markers = useMemo<AgentMarker[]>(() => {
    if (!doc) return [];
    return one ? (mk.data && mk.data.ok ? mk.data.markers : []) : derivedMarkers(points, { listings: false });
  }, [doc, one, mk.data, points]);
  const layout = useMemo(() => placeMarkers(markers, axis, left, right, MARK_GAP), [markers, axis, left, right]);
  const sel: PlacedMarker | undefined = layout.placed.find((p) => `${p.kind}:${p.markers[0]!.t}` === mark);
  const at = sel ? sel.markers[Math.min(markSub, sel.markers.length - 1)]! : undefined;
  const cmp = useMemo(
    () => (at ? compareAround(points, at.t, { reading, ...(model ? { model } : {}) }) : null),
    [at, points, reading, model]);

  const pick = (b: SeriesBucket) => (reading === "start" ? b.start : reading === "look" ? b.look : reading === "req" ? b.req : b.subStart);
  const values = useMemo(() => valuesOnAxis(axis, series, pick), [axis, series, reading]); // eslint-disable-line react-hooks/exhaustive-deps
  const why = absentSummary(series, pick);
  const y = yScale(values, CHART_H - 16, 8);
  const parts = useMemo(() => (reading === "start" ? partBands(axis, series, START_PARTS) : []), [axis, series, reading]);
  const tops = useMemo(() => stackTops(parts, n), [parts, n]);
  const partMax = Math.max(0, ...(tops[tops.length - 1] ?? []).map((t) => t.hi));
  const py = yScale([partMax], CHART_H - 16, 8);

  const slotW = n > 0 ? (right - left) / n : 0;
  // The slot under a finger, by x: the chart is the picker (pointerdown, then drag), never a row of
  // thin tap targets. `touchAction: pan-y` keeps the page scrolling vertically over it.
  const scrub = (e: React.PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const i = slotAtX(((e.clientX - r.left) / Math.max(1, r.width)) * width, n, left, right);
    if (i >= 0) setSlot(i);
  };
  const readIdx = slot !== null && slot < n ? slot : values.map((v, i) => (v !== null ? i : -1)).filter((i) => i >= 0).pop() ?? null;
  const readBucket = readIdx !== null ? series.find((b) => b.key === axis.keys[readIdx]) : undefined;
  const readout = readIdx === null ? null : readBucket
    ? `${axis.keys[readIdx]}${grain === "week" ? " (week from)" : ""}: ${
      medianOrNull(pick(readBucket)) !== null
        ? `median ${fmtReading(def, medianOrNull(pick(readBucket))!)}, ${(pick(readBucket) as { n: number }).n} sessions`
        : absentWhy(pick(readBucket))}`
    : `${axis.keys[readIdx]}: no sessions.`;

  const partTwin = reading === "start" ? partTwinWords(readBucket, START_PARTS) : null;
  const ticks = n === 0 ? [] : [0, Math.floor((n - 1) / 2), n - 1].filter((v, i, a) => a.indexOf(v) === i);
  const markH = layout.rows.length * ROW_H;

  const reset = () => { setMark(null); setMarkSub(0); setSlot(null); };
  const chips = (
    <>
      <select className="search" aria-label="repo" value={scope} onChange={(e) => { setScope(e.target.value); reset(); }}>
        {targets.map((r) => <option key={r.id} value={r.id}>{repoLabel(r)}</option>)}
        <option value="all">All repos</option>
      </select>
      {(["week", "day"] as const).filter((g) => g === "week" || dayOk).map((g) => (
        <Button key={g} className={grain === g ? "active" : undefined} onClick={() => { setGrain(g); reset(); }}>{g}</Button>
      ))}
    </>
  );

  return (
    <ScopeCard title="Agent readings over time" chips={chips}
      caption={one ? "this repo, its full history" : "every repo on this desktop; memory and skills-listing marks need one repo, since each repo has its own"}>
      <div className="ctx-box" style={{ paddingTop: 0 }} ref={boxRef} />
      <Empty res={pts} empty={!doc} thing="agent readings">
        {refusal ?? "No conversation logs to read."}
      </Empty>
      {doc && <>
        {cover?.words && <div className="empty ts-caveat">{cover.words}</div>}

        <div className="ts-filter" role="group" aria-label="model">
          <span className="ts-scope-tag">model</span>
          {models.map((m) => (
            <Button key={m.model} className={m.model === model ? "active" : undefined}
              onClick={() => { setPicked(m.model); reset(); }}>
              <span aria-hidden="true" style={{ display: "inline-block", width: 8, height: 8, borderRadius: 2, marginRight: 5, background: hueOf(m.model) }} />
              {normalizeModel(m.model) ?? m.model}
            </Button>
          ))}
        </div>
        {models.length > 1 && <div className="empty ts-caveat">One model at a time: sessions on different models are never pooled, because a model change moves these readings more than an instruction edit does.</div>}
        {unnamed > 0 && <div className="empty ts-caveat">{unnamed.toLocaleString("en-US")} sessions do not record their model and are left out.</div>}

        <div className="ts-filter" role="group" aria-label="reading">
          <span className="ts-scope-tag">reading</span>
          {READINGS.map((r) => (
            <Button key={r.id} className={r.id === reading ? "active" : undefined} onClick={() => { setReading(r.id); reset(); }}>{r.label}</Button>
          ))}
        </div>

        {n === 0 || why !== null && allAbsent(values) ? (
          <div className="empty ts-caveat">{n === 0 ? "No sessions for this model here." : why} {n > 0 && "Nothing is drawn rather than a zero."}</div>
        ) : width > 0 && <>
          <div className="section section-head"><span>{def.label}</span></div>
          <svg className="ctx-chart" width={width} height={CHART_H} viewBox={`0 0 ${width} ${CHART_H}`}
            role="img" aria-label={`${def.label}, median per ${grain}`} style={{ touchAction: "pan-y" }}
            onPointerDown={scrub} onPointerMove={(e) => { if (e.buttons) scrub(e); }}>
            {y.ticks.map((v) => (
              <g key={v}>
                <line x1={left} x2={right} y1={y.y(v)} y2={y.y(v)} stroke="var(--line)" strokeWidth={1} />
                <text x={left - 4} y={y.y(v) + 3} textAnchor="end" fontSize={9} fill="var(--muted)">{def.unit === "tokens" ? fmtReading(def, v).replace(" tokens", "") : String(Math.round(v * 10) / 10)}</text>
              </g>
            ))}
            {runsOf(values).map((run, k) => run.length === 1
              ? <circle key={k} cx={slotX(run[0]!.i, n, left, right)} cy={y.y(run[0]!.v)} r={3} fill={SERIES} />
              : <path key={k} d={run.map((p, j) => `${j ? "L" : "M"}${slotX(p.i, n, left, right).toFixed(1)} ${y.y(p.v).toFixed(1)}`).join("")} fill="none" stroke={SERIES} strokeWidth={2} strokeLinejoin="round" />)}
            {readIdx !== null && values[readIdx] !== null && <circle cx={slotX(readIdx, n, left, right)} cy={y.y(values[readIdx]!)} r={4} fill={SERIES} stroke="var(--panel)" strokeWidth={2} />}
            {readIdx !== null && <line x1={slotX(readIdx, n, left, right)} x2={slotX(readIdx, n, left, right)} y1={8} y2={CHART_H - 8} stroke="var(--accent)" strokeOpacity={0.5} />}
          </svg>
          {readout && <div className="empty ts-caveat">{readout}</div>}

          {reading === "start" && parts.length > 0 && <>
            <div className="section section-head"><span>What the first request carried</span></div>
            <svg className="ctx-chart" width={width} height={CHART_H} viewBox={`0 0 ${width} ${CHART_H}`} role="img" aria-label="start context by part, characters" style={{ touchAction: "pan-y" }}
              onPointerDown={scrub} onPointerMove={(e) => { if (e.buttons) scrub(e); }}>
              {py.ticks.map((v) => (
                <g key={v}>
                  <line x1={left} x2={right} y1={py.y(v)} y2={py.y(v)} stroke="var(--line)" strokeWidth={1} />
                  <text x={left - 4} y={py.y(v) + 3} textAnchor="end" fontSize={9} fill="var(--muted)">{fmtKChars(v)}</text>
                </g>
              ))}
              {readIdx !== null && <line x1={slotX(readIdx, n, left, right)} x2={slotX(readIdx, n, left, right)} y1={8} y2={CHART_H - 8} stroke="var(--accent)" strokeOpacity={0.5} />}
              {parts.map((b, bi) => b.values.map((v, i) => v === null ? null : (
                <rect key={`${b.id}${i}`} x={left + i * slotW + 1} width={Math.max(1, slotW - 2)}
                  y={py.y(tops[bi]![i]!.hi)} height={Math.max(0, py.y(tops[bi]![i]!.lo) - py.y(tops[bi]![i]!.hi))}
                  fill={b.slot === null ? "var(--muted)" : SLOT[b.slot]} fillOpacity={b.slot === null ? 0.45 : 0.9} stroke="var(--panel)" strokeWidth={0.5} />
              )))}
            </svg>
            <div className="empty ts-caveat">
              Measured on each session's first request: characters per part (median of the sessions that measured it, each part on its own), in the order the request carries them.
              {" "}The grey band folds the smaller parts into one; the line below names every part for the {grain} you touch.
            </div>
            {partTwin && <div className="empty ts-caveat">{partTwin}</div>}
            <div className="ts-filter" aria-label="parts legend">
              {parts.map((b) => (
                <span key={b.id} className="ts-scope-tag">
                  <span aria-hidden="true" style={{ display: "inline-block", width: 8, height: 8, borderRadius: 2, marginRight: 4, background: b.slot === null ? "var(--muted)" : SLOT[b.slot], opacity: b.slot === null ? 0.45 : 1 }} />
                  {b.label}{b.members ? ` (${b.members.join(", ")})` : ""}
                </span>
              ))}
            </div>
          </>}

          {/* What changed: one row per kind, a shape AND its word; a tap reads the before and after. */}
          <div className="section section-head"><span>What changed</span></div>
          {layout.placed.length > 0 ? (
            <svg className="ctx-chart" width={width} height={markH + 22} viewBox={`0 0 ${width} ${markH + 22}`} role="group" aria-label="changes on the same axis">
              {layout.rows.map((k, row) => (
                <g key={k}>
                  <line x1={left} x2={right} y1={row * ROW_H + ROW_H / 2} y2={row * ROW_H + ROW_H / 2} stroke="var(--line)" strokeDasharray="2 3" />
                  <text x={left - 4} y={row * ROW_H + ROW_H / 2 + 3} textAnchor="end" fontSize={8} fill="var(--muted)">{markerKind(k).word.split(" ")[0]}</text>
                </g>
              ))}
              {layout.placed.map((p) => {
                const key = `${p.kind}:${p.markers[0]!.t}`;
                const cy = p.row * ROW_H + ROW_H / 2;
                const on = key === mark;
                return (
                  <g key={key} role="button" tabIndex={0} aria-label={markerWords(p)} style={{ cursor: "pointer" }}
                    onClick={() => { setMark(on ? null : key); setMarkSub(0); }} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { setMark(on ? null : key); setMarkSub(0); } }}>
                    <rect x={p.x - MARK_GAP / 2} y={p.row * ROW_H} width={MARK_GAP} height={ROW_H} fill="transparent" />
                    {on && <circle cx={p.x} cy={cy} r={9} fill="none" stroke="var(--accent)" strokeWidth={1.5} />}
                    <path d={shapePath(markerKind(p.kind).shape, p.x, cy, 5)} fill="var(--fg)" fillOpacity={0.8} />
                    {p.count > 1 && <text x={p.x + 7} y={cy - 5} fontSize={8} fill="var(--fg)">{p.count}</text>}
                  </g>
                );
              })}
              {ticks.map((i) => (
                <text key={i} x={slotX(i, n, left, right)} y={markH + 14} textAnchor={i === 0 ? "start" : i === n - 1 ? "end" : "middle"} fontSize={9} fill="var(--muted)">{axis.keys[i]}</text>
              ))}
            </svg>
          ) : <div className="empty ts-caveat">No changes are known in these days{one ? "." : "; instruction changes are read per repo, so pick one."}</div>}
          {layout.placed.length > 0 && (
            <div className="ts-filter" aria-label="marker legend">
              {MARKER_KINDS.filter((k) => layout.rows.includes(k.kind)).map((k) => (
                <span key={k.kind} className="ts-scope-tag">
                  <svg width={12} height={12} aria-hidden="true"><path d={shapePath(k.shape, 6, 6, 4.5)} fill="var(--fg)" fillOpacity={0.8} /></svg> {k.word}
                </span>
              ))}
            </div>
          )}
          {layout.outside > 0 && <div className="empty ts-caveat">{layout.outside} more changes fall on days outside this axis.</div>}
          {one && mk.data && mk.data.ok && mk.data.absent.map((a) => <div key={a} className="empty ts-caveat">{a}</div>)}
          {one && mk.data && !mk.data.ok && <div className="empty ts-caveat">Changes could not be read: {mk.data.error}</div>}

          {sel && cmp && <div className="ctx-box" aria-live="polite">
            <div className="empty ts-caveat">{markerWords(sel)}</div>
            {sel.markers.length > 1 && (
              <div className="ts-filter" role="group" aria-label="changes in this mark">
                <span className="ts-scope-tag">compare around</span>
                {sel.markers.map((m, i) => (
                  <Button key={`${m.t}:${m.label}`} className={at === m ? "active" : undefined} onClick={() => setMarkSub(i)}>{markerPickLabel(m)}</Button>
                ))}
              </div>
            )}
            {at && foldedCompareWords(sel, at) && <div className="empty ts-caveat">{foldedCompareWords(sel, at)}</div>}
            <div className="empty ts-caveat">{compareWords(def, cmp)}</div>
            {!("absent" in cmp) && (() => {
              const s = ratioScale(cmp.ratio, cmp.band, Math.max(60, width - 2 * PAD_R));
              return (
                <svg width={width} height={34} role="img" aria-label="the ratio against the band of normal variation">
                  <g transform={`translate(${PAD_R} 0)`}>
                    <rect x={s.band[0]} y={6} width={Math.max(1, s.band[1] - s.band[0])} height={14} fill="var(--fg)" fillOpacity={0.1} stroke="var(--line)" />
                    <line x1={s.one} x2={s.one} y1={3} y2={23} stroke="var(--muted)" strokeDasharray="2 2" />
                    <circle cx={s.ratio} cy={13} r={4.5} fill="var(--fg)" stroke="var(--panel)" strokeWidth={1.5} />
                    {s.ticks.map((t, i) => <text key={i} x={t.x} y={32} fontSize={9} fill="var(--muted)" textAnchor={i === 0 ? "start" : i === 2 ? "end" : "middle"}>×{t.r}</text>)}
                  </g>
                </svg>
              );
            })()}
            <div className="empty ts-caveat">The shaded span is the ratios whole days shuffled between the two sides produce; the dot is the measured ratio. {COMPARE_NOTE}</div>
          </div>}

          <div className="empty ts-caveat">
            Median per {grain} over {def.over}. A {grain} with fewer than five of them draws no point, and tapping it says how many there were.
          </div>
        </>}
      </>}
    </ScopeCard>
  );
}
