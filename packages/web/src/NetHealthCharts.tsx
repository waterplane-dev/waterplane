/**
 * The connection strip's readings over time: what a tap on the strip lands on.
 *
 * The rule the sheet keeps: everything the strip shows small has more behind it
 * here, and a chart comes first, the words after. Each chart is one question
 * about one reading; `link/linkSeries.ts` holds the maths and is node-tested.
 *
 * Grammar, so the charts read as one set: ONE range control, sticky at the top of
 * the sheet (`RangeBar`), because the sheet opens mid-way down and a row that
 * scrolled away could not be reached from where a tap lands. It also says once
 * what every chart would otherwise repeat: how to read a value, and the mark for
 * a stretch nobody measured, which is never a zero.
 */
import { useEffect, useState, type ReactNode } from "react";
import { fmtMs, fmtTotal, flushLinkSeries, readLinkSeries, whenText } from "./link";
import { hhmm } from "./format";
import {
  RANGES, binDown, binSeries, binUp, dropsOf, lostShare, pingCeiling, routeChanges, spanText, sumBins, PROBE_SEC,
  type LinkBin, type LinkMinute, type LinkRange, type RangeId,
} from "./link/linkSeries";
import { Button } from "./kit/Button";
import { ScrubHint } from "./kit/chart/ScrubHint";
import { useBoxWidth } from "./kit/chart/useBoxWidth";

const REREAD_MS = 30_000;

export interface LinkHistory {
  rows: LinkMinute[] | null;
  range: LinkRange;
  bins: LinkBin[];
  setRange: (id: RangeId) => void;
}

/** The sheet's one read of the rows, shared by every chart on it. */
export function useLinkHistory(): LinkHistory {
  const [rows, setRows] = useState<LinkMinute[] | null>(null);
  const [id, setId] = useState<RangeId>("24h");
  useEffect(() => {
    let live = true;
    const read = () => { flushLinkSeries(); void readLinkSeries().then((r) => { if (live) setRows(r); }); };
    read();
    const t = window.setInterval(read, REREAD_MS);
    return () => { live = false; window.clearInterval(t); };
  }, []);
  const range = RANGES.find((r) => r.id === id) ?? RANGES[1];
  return { rows, range, bins: binSeries(rows ?? [], range, Date.now()), setRange: setId };
}

const stamp = (b: LinkBin, range: LinkRange): string => (range.binMin === 1
  ? hhmm(b.from)
  : `${whenText(b.from)}–${hhmm(b.to)}`);

/** The one range control, and what holds for every chart under it. */
export function RangeBar({ h }: { h: LinkHistory }) {
  return (
    <div className="lc-range">
      <div className="ts-seg-chips">
        {RANGES.map((r) => (
          <Button key={r.id} className={r.id === h.range.id ? "active" : ""} onClick={() => h.setRange(r.id)}>{r.id}</Button>
        ))}
      </div>
      <p className="lc-range-note"><i className="lc-sw lc-gap" /> not measured · <ScrubHint /></p>
    </div>
  );
}

function Legend({ items }: { items: readonly (readonly [string, string])[] }) {
  if (!items.length) return null;
  return (
    <div className="lc-legend">
      {items.map(([cls, label]) => <span key={cls}><i className={`lc-sw ${cls}`} />{label}</span>)}
    </div>
  );
}

/** The frame every chart shares: name, range, plot, readout. The plot is drawn
 *  from a width, and a finger on it picks a bin. `bare`: the section's own title
 *  already names it, so the name is only for a screen reader. */
function Frame({ h, name, bare, height, readout, children, top, legend }: {
  h: LinkHistory; name: string; bare?: boolean; height: number; readout: (b: LinkBin) => string; top?: string;
  children: (w: number) => ReactNode; legend: readonly (readonly [string, string])[];
}) {
  const [w, box] = useBoxWidth();
  const [pick, setPick] = useState<number | null>(null);
  const at = (e: React.PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    if (r.width > 0) setPick(Math.max(0, Math.min(h.bins.length - 1, Math.floor(((e.clientX - r.left) / r.width) * h.bins.length))));
  };
  const b = pick != null ? h.bins[pick] : null;
  const step = w / h.bins.length;
  return (
    <div className="lc-chart">
      {(!bare || top) && (
        <div className="lc-head">
          <span className="lc-name">{bare ? "" : name}</span>
          {top && <span className="lc-top">top of chart {top}</span>}
        </div>
      )}
      <div ref={box} className="lc-plot">
        {w > 0 && (
          <svg width={w} height={height} viewBox={`0 0 ${w} ${height}`} role="img" aria-label={name}
            onPointerDown={at} onPointerMove={(e) => { if (e.buttons || e.pointerType === "touch") at(e); }}>
            {h.bins.map((x, i) => (x.measured ? null
              : <rect key={i} x={i * step} y={0} width={step + 0.5} height={height} className="lc-gap" />))}
            {children(w)}
            {pick != null && <line x1={(pick + 0.5) * step} x2={(pick + 0.5) * step} y1={0} y2={height} className="lc-cross" />}
          </svg>
        )}
      </div>
      <div className="lc-axis">
        <span>{whenText(h.bins[0].from)}</span><span>now</span>
      </div>
      <p className="lc-readout">
        {b ? `${stamp(b, h.range)} · ${b.measured ? readout(b) : "not measured: the app was not on screen"}` : null}
      </p>
      <Legend items={legend} />
    </div>
  );
}

function Tiles({ tiles }: { tiles: readonly (readonly [string, string, string?])[] }) {
  return (
    <div className="nh-stats">
      {tiles.map(([label, value, note]) => (
        <div key={label} className="nh-stat">
          <span className="nh-stat-v">{value}</span>
          <span className="nh-stat-l">{label}</span>
          {note && <span className="nh-stat-n">{note}</span>}
        </div>
      ))}
    </div>
  );
}

/** Too little to draw, said as what is true. The rows began when this build arrived. */
function NoRows({ h }: { h: LinkHistory }) {
  if (h.rows == null) return <p className="lc-readout">Reading the history…</p>;
  const first = h.rows.reduce((m, r) => Math.min(m, r.t), Infinity);
  if (!Number.isFinite(first)) return <p className="lc-readout">Nothing measured yet. It fills in while the app is on screen.</p>;
  return <p className="lc-readout">Not enough measured in this range yet. History starts {whenText(first * 60_000)}.</p>;
}

/** A chart of one minute is a blank plot with a scale, so a few come first. */
const MIN_MEASURED = 3;
const measured = (h: LinkHistory) => h.bins.reduce((n, b) => n + b.measured, 0) >= MIN_MEASURED;

/** Ping over time: a line for the median, a band up to the worst, and what went
 *  unanswered hanging from the top in proportion. */
export function PingHistory({ h }: { h: LinkHistory }) {
  const H = 110;
  const ceil = pingCeiling(h.bins);
  const s = sumBins(h.bins);
  const lost = s.miss + s.off;
  const readout = (b: LinkBin) => {
    const parts = [b.med != null ? `median ${fmtMs(b.med)}` : "no replies"];
    if (b.worst != null) parts.push(`worst ${fmtMs(b.worst)}`);
    if (b.miss) parts.push(`${b.miss} unanswered`);
    if (b.off) parts.push(`${spanText(b.off * PROBE_SEC)} no socket`);
    return parts.join(" · ");
  };
  if (!measured(h)) return <NoRows h={h} />;
  return (
    <>
      <Frame h={h} name="Ping" height={H} readout={readout} top={fmtMs(ceil)}
        legend={[["lc-line", "median"], ["lc-band", "up to the worst"], ["lc-lost", "unanswered"]]}>
        {(w) => {
          const step = w / h.bins.length;
          const y = (v: number) => H - Math.min(1, v / ceil) * (H - 2) - 1;
          const x = (i: number) => (i + 0.5) * step;
          const runs: string[] = [];
          let run: string[] = [];
          h.bins.forEach((b, i) => {
            if (b.med == null) { if (run.length) runs.push(run.join(" ")); run = []; return; }
            run.push(`${x(i).toFixed(1)},${y(b.med).toFixed(1)}`);
          });
          if (run.length) runs.push(run.join(" "));
          return (
            <>
              {h.bins.map((b, i) => (b.med != null && b.worst != null
                ? <rect key={`b${i}`} x={i * step} width={step + 0.5} y={y(b.worst)} height={Math.max(0, y(b.med) - y(b.worst))} className="lc-band" />
                : null))}
              {h.bins.map((b, i) => (b.miss + b.off > 0
                ? <rect key={`l${i}`} x={i * step} width={Math.max(1.5, step)} y={0} height={Math.max(3, lostShare(b) * H)} className="lc-lost" />
                : null))}
              {runs.map((p, i) => (p.includes(" ")
                ? <polyline key={i} points={p} className="lc-line" />
                : <circle key={i} cx={p.split(",")[0]} cy={p.split(",")[1]} r={1.6} className="lc-dot" />))}
            </>
          );
        }}
      </Frame>
      <Tiles tiles={[
        [`median in ${h.range.id}`, fmtMs(s.median ?? undefined), `over ${spanText(s.measuredMin * 60)} measured`],
        [`worst in ${h.range.id}`, fmtMs(s.worst ?? undefined)],
        [`unanswered in ${h.range.id}`, s.probes ? `${((lost / s.probes) * 100).toFixed(lost && lost / s.probes < 0.1 ? 1 : 0)}%` : "—", s.probes ? `${lost} of ${s.probes} probes` : undefined],
      ]} />
    </>
  );
}

/** A row of coloured stretches: which of a few states each bin was in. */
function Band({ h, name, legend, readout, cls }: {
  h: LinkHistory; name: string; legend: readonly (readonly [string, string])[];
  readout: (b: LinkBin) => string; cls: (b: LinkBin) => string | null;
}) {
  const H = 26;
  return (
    <Frame h={h} name={name} bare height={H} readout={readout} legend={legend}>
      {(w) => {
        const step = w / h.bins.length;
        return h.bins.map((b, i) => {
          const c = b.measured ? cls(b) : null;
          return c ? <rect key={i} x={i * step} y={0} width={step + 0.5} height={H} className={c} /> : null;
        });
      }}
    </Frame>
  );
}

/** Which way the desktop was reached, and every move between the two. */
export function RouteHistory({ h }: { h: LinkHistory }) {
  if (!measured(h)) return <NoRows h={h} />;
  const s = sumBins(h.bins);
  const known = s.lanMin + s.tailMin;
  const moves = routeChanges((h.rows ?? []).filter((r) => r.t * 60_000 >= h.bins[0].from));
  return (
    <>
      <Band h={h} name="Route over time" legend={[["lc-tail", "tailnet"], ["lc-lan", "LAN"]]}
        cls={(b) => (b.lanMin + b.tailMin === 0 ? null : b.lanMin >= b.tailMin ? "lc-lan" : "lc-tail")}
        readout={(b) => `tailnet ${spanText(b.tailMin * 60)} · LAN ${spanText(b.lanMin * 60)}`} />
      {known > 0 && <Tiles tiles={[
        ["on the tailnet", `${Math.round((s.tailMin / known) * 100)}%`, spanText(s.tailMin * 60)],
        ["on the LAN", `${Math.round((s.lanMin / known) * 100)}%`, spanText(s.lanMin * 60)],
        [moves.length === 1 ? "route change" : "route changes", `${moves.length}`],
      ]} />}
      {moves.length > 0 && (
        <ul className="lc-list">
          {moves.slice(0, 8).map((m) => <li key={m.at}><span>{whenText(m.at)}</span><span>moved to the {m.to === "lan" ? "LAN" : "tailnet"}</span></li>)}
        </ul>
      )}
    </>
  );
}

/** When there was a socket, and every stretch without one. */
export function ConnectionHistory({ h }: { h: LinkHistory }) {
  if (!measured(h)) return <NoRows h={h} />;
  const s = sumBins(h.bins);
  const drops = dropsOf((h.rows ?? []).filter((r) => r.t * 60_000 >= h.bins[0].from));
  const longest = drops.reduce((m, d) => Math.max(m, d.offSec), 0);
  return (
    <>
      <Band h={h} name="Connected" legend={[["lc-up", "connected"], ["lc-part", "dropped for part of it"], ["lc-down", "no socket"]]}
        cls={(b) => (b.off === 0 ? "lc-up" : b.ok + b.miss === 0 ? "lc-down" : "lc-part")}
        readout={(b) => (b.off ? `${spanText(b.off * PROBE_SEC)} with no socket` : "connected throughout")} />
      <Tiles tiles={[
        [drops.length === 1 ? "drop" : "drops", `${drops.length}`],
        ["longest", drops.length ? spanText(longest) : "—"],
        ["time down", spanText(s.off * PROBE_SEC), `of ${spanText(s.measuredMin * 60)} measured`],
      ]} />
      {drops.length > 0 && (
        <ul className="lc-list">
          {drops.slice(0, 8).map((d) => <li key={d.from}><span>{whenText(d.from)}</span><span>down {spanText(d.offSec)}</span></li>)}
        </ul>
      )}
    </>
  );
}

function Bars({ h, name, bare, stacks, legend, readout, fmt }: {
  h: LinkHistory; name: string; bare?: boolean; stacks: readonly (readonly [string, (b: LinkBin) => number])[];
  legend: readonly (readonly [string, string])[]; readout: (b: LinkBin) => string; fmt: (n: number) => string;
}) {
  const H = 90;
  const total = (b: LinkBin) => stacks.reduce((n, [, v]) => n + v(b), 0);
  const max = Math.max(1, ...h.bins.map(total));
  return (
    <Frame h={h} name={name} bare={bare} height={H} readout={readout} legend={legend} top={fmt(max)}>
      {(w) => {
        const step = w / h.bins.length;
        const bw = Math.max(1, step - (step > 3 ? 1 : 0));
        return h.bins.flatMap((b, i) => {
          let base = H;
          return stacks.map(([cls, v]) => {
            const px = (v(b) / max) * (H - 1);
            if (px <= 0) return null;
            const hgt = Math.max(1, px);
            base -= hgt;
            return <rect key={`${i}${cls}`} x={i * step} y={base} width={bw} height={hgt} className={cls} />;
          });
        });
      }}
    </Frame>
  );
}

const VIA: readonly (readonly [string, string])[] = [["lc-s1", "terminal socket"], ["lc-s2", "requests"], ["lc-s3", "images and page loads"]];

/** What moved, when, and through what. A total is never printed without its split. */
export function DataHistory({ h }: { h: LinkHistory }) {
  if (!measured(h)) return <NoRows h={h} />;
  const s = sumBins(h.bins);
  const busiest = h.bins.reduce((m, b) => (binDown(b) + binUp(b) > binDown(m) + binUp(m) ? b : m), h.bins[0]);
  const split = (a: number, b: number, c?: number) => [
    `socket ${fmtTotal(a)}`, `requests ${fmtTotal(b)}`, ...(c != null ? [`pages ${fmtTotal(c)}`] : []),
  ].join(" · ");
  return (
    <>
      <Bars h={h} name="Downloaded" fmt={fmtTotal} legend={VIA}
        stacks={[["lc-s1", (b) => b.down.socket], ["lc-s2", (b) => b.down.request], ["lc-s3", (b) => b.down.page]]}
        readout={(b) => `${fmtTotal(binDown(b))}: ${split(b.down.socket, b.down.request, b.down.page)}`} />
      <Bars h={h} name="Uploaded" fmt={fmtTotal} legend={VIA.filter(([c]) => c !== "lc-s3")}
        stacks={[["lc-s1", (b) => b.up.socket], ["lc-s2", (b) => b.up.request]]}
        readout={(b) => `${fmtTotal(binUp(b))}: ${split(b.up.socket, b.up.request)}`} />
      <Tiles tiles={[
        [`down in ${h.range.id}`, fmtTotal(s.down.socket + s.down.request + s.down.page), split(s.down.socket, s.down.request, s.down.page)],
        [`up in ${h.range.id}`, fmtTotal(s.up.socket + s.up.request), split(s.up.socket, s.up.request)],
        ["busiest stretch", fmtTotal(binDown(busiest) + binUp(busiest)), stamp(busiest, h.range)],
      ]} />
    </>
  );
}

/** How much was waiting on this phone, over time. */
export function HeldHistory({ h }: { h: LinkHistory }) {
  if (!measured(h)) return <NoRows h={h} />;
  return (
    <Bars h={h} name="Not on the desktop yet" fmt={(n) => `${Math.round(n)}`} legend={[]}
      stacks={[["lc-s4", (b) => b.out]]}
      readout={(b) => (b.out ? `up to ${b.out} waiting` : "nothing waiting")} />
  );
}

/** Prompts through the queue: what arrived, what gave up, how long it took. */
export function SendsHistory({ h }: { h: LinkHistory }) {
  if (!measured(h)) return <NoRows h={h} />;
  const s = sumBins(h.bins);
  return (
    <>
      <Bars h={h} name="Sends over time" bare fmt={(n) => `${Math.round(n)}`} legend={[["lc-s1", "confirmed"], ["lc-fail", "gave up"]]}
        stacks={[["lc-s1", (b) => b.sent], ["lc-fail", (b) => b.fail]]}
        readout={(b) => `${b.sent} confirmed · ${b.fail} gave up${b.wait ? ` · longest wait ${fmtMs(b.wait)}` : ""}`} />
      <Tiles tiles={[
        ["confirmed", `${s.sent}`],
        ["gave up", `${s.fail}`],
        ["longest wait", s.wait ? fmtMs(s.wait) : "—", "queued to confirmed"],
      ]} />
    </>
  );
}
