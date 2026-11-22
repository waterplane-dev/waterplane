/**
 * The speed test's live graph: throughput over the run, download then upload on one timeline
 * (they run one after the other, so that is how they are drawn). Drawn while the run is going
 * and kept until the next run, so a stall or a ramp-up is visible beside the one average the
 * result rows print. Numbers come from `speedSeries.ts`; this only draws.
 */
import { Download, Upload } from "lucide-react";
import { niceCeil, type SpeedPoint } from "./speedSeries";
import { polyline } from "./kit/chart/chartPath";
import { useBoxWidth } from "./kit/chart/useBoxWidth";
import { SERIES, SLOT } from "./kit/chart/TokenComposition";

export const DOWN_HUE = SERIES;
export const UP_HUE = SLOT[1];

const H = 120;
const PAD_L = 36;
const PAD_B = 18;
const PAD_T = 6;

/** `live`: the direction running now. Only download reads "now": upload progress counts bytes
 *  handed to the network stack, which runs ahead of the wire, so its live rate is not one to trust. */
export function SpeedGraph({ down, up, live }: { down: SpeedPoint[]; up: SpeedPoint[]; live?: "down" | "up" }) {
  const [width, box] = useBoxWidth();
  // One timeline: the upload ran after the download, so it is drawn after it, never on top of it.
  const upFrom = down.length ? down[down.length - 1].t : 0;
  const upShifted = up.map((p) => ({ t: p.t + upFrom, mbps: p.mbps }));
  const all = [...down, ...upShifted];
  const top = niceCeil(Math.max(0, ...all.map((p) => p.mbps)));
  const tMax = Math.max(1, ...all.map((p) => p.t));
  const plotW = Math.max(0, width - PAD_L - 4);
  const plotH = H - PAD_B - PAD_T;
  const x = (p: SpeedPoint) => PAD_L + (p.t / tMax) * plotW;
  const y = (p: SpeedPoint) => PAD_T + plotH - (Math.min(p.mbps, top) / top) * plotH;
  // A line starts at its first window; a single point is drawn as a dot so it is not invisible.
  const line = (pts: SpeedPoint[], hue: string) =>
    pts.length > 1 ? <path d={polyline(pts, x, y)} fill="none" stroke={hue} strokeWidth={2} strokeLinejoin="round" />
    : pts.length === 1 ? <circle cx={x(pts[0])} cy={y(pts[0])} r={2.5} fill={hue} />
    : null;
  const base = PAD_T + plotH;
  return (
    <div ref={box} style={{ marginTop: 8 }} role="img"
      aria-label={`Throughput over the run, up to ${top} Mbps over ${tMax.toFixed(1)} seconds`}>
      {width > 0 && (
        <svg width={width} height={H} style={{ display: "block" }}>
          {/* Solid hairlines: on these charts a dash means a threshold, never a grid. */}
          {[0, 0.5, 1].map((f) => {
            const yy = PAD_T + plotH - f * plotH;
            return (
              <g key={f}>
                <line x1={PAD_L} x2={width - 4} y1={yy} y2={yy} stroke="currentColor" strokeOpacity={f ? 0.12 : 0.3} />
                <text className="ctx-tick" x={PAD_L - 4} y={yy + 3} textAnchor="end">{fmtAxis(top * f)}</text>
              </g>
            );
          })}
          <text className="ctx-tick" x={PAD_L} y={base + 13}>0 s</text>
          <text className="ctx-tick" x={width - 4} y={base + 13} textAnchor="end">{tMax.toFixed(1)} s</text>
          {line(down, DOWN_HUE)}
          {line(upShifted, UP_HUE)}
        </svg>
      )}
      {/* The unit, and which line is which before the result rows exist to say it. */}
      {/* No side padding: the legend sits in a settings group, whose gutter is already the text's. */}
      <div className="ctx-legend" style={{ padding: "var(--sp-2) 0 0" }}>
        <span>Mbps over the run</span>
        {down.length > 0 && <span><Download size={12} color={DOWN_HUE} /> download{live === "down" && now(down)}</span>}
        {up.length > 0 && <span><Upload size={12} color={UP_HUE} /> upload</span>}
      </div>
    </div>
  );
}

/** The newest window's rate: what the line is doing right now. */
function now(pts: SpeedPoint[]): string {
  const v = pts[pts.length - 1].mbps;
  return ` · now ${v >= 100 ? v.toFixed(0) : v.toFixed(1)} Mbps`;
}

function fmtAxis(v: number): string {
  return v >= 10 || v === 0 ? v.toFixed(0) : v.toFixed(1);
}
