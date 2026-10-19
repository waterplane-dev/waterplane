/**
 * The shared marks of the repo-health charts: the curve's ink, the day axis, the
 * crosshair and the pointer arithmetic. Split out of `RepoHealthTiles.tsx`, which
 * re-exports all of it — see that file's header for the visual contract.
 */
import type { RepoHealthPoint } from "@waterplane/shared";
import { indexTicks, type Plotted } from "./repoHealthPlot";
import { axisDayWords } from "./repoHealthWords";

/** The curve's own weight of ink. Low enough that the VALUE stays the thing
 *  the eye lands on in a tile, high enough to read at 32 px tall. */
export const CURVE_OPACITY = 0.55;
export const DOT_R = 2.5;

export const values = (points: readonly RepoHealthPoint[]): (number | null)[] => points.map((p) => p.v);


/**
 * The strip under a plot where the day labels sit, and the tick baseline
 * inside it. Part of the SVG rather than a row of spans beneath it: the labels
 * have to line up with marks drawn in user units, and a flexbox row under the
 * box lines up with nothing.
 */
export const TICK_H = 15;
export const TICK_BASELINE = 11;
/** How many day labels a plot gets. Three — the two ends and the middle — is
 *  what fits at 10 px on a 360 px phone without the outer two colliding with
 *  their neighbour, and it is the same three `ContextChart` draws. */
const X_TICKS = 3;
/** The left gutter, sized to the LABELS rather than fixed: these series carry
 *  four magnitudes (`0.69`, `1,352`, `11,955`, `143,176`) and one width either
 *  clips the widest or wastes a third of the plot on the narrowest. */
const GUTTER_MIN = 26;
const GUTTER_MAX = 64;
const CHAR_PX = 6;
export const gutterFor = (labels: readonly string[]) => {
  let longest = 0;
  for (const t of labels) if (t.length > longest) longest = t.length;
  return Math.min(GUTTER_MAX, Math.max(GUTTER_MIN, longest * CHAR_PX + 8));
};

/**
 * Where a pointer landed, in the plot's own user units.
 *
 * The SVG is drawn at `width` user units and laid out at `box.width` CSS px,
 * and on a rotated phone those differ — mixing them puts the crosshair on the
 * wrong reading. `ContextChart` learnt this first; the arithmetic is the same
 * and is written once here.
 */
export function plotX(e: { clientX: number }, el: SVGSVGElement | null, width: number, gutter: number): number | null {
  const box = el?.getBoundingClientRect();
  if (!box || !box.width) return null;
  return ((e.clientX - box.left) / box.width) * width - gutter;
}

/** The day labels along the bottom, drawn from the points themselves. */
export function XAxis({ points, w, y, gutter }: {
  points: readonly RepoHealthPoint[];
  w: number;
  y: number;
  gutter: number;
}) {
  const ticks = indexTicks(points.length, w, X_TICKS);
  if (ticks.length < 2) return null;
  return (
    <>
      {ticks.map((t, k) => (
        <text key={t.i} className="rh-tick" x={gutter + t.x} y={y}
          textAnchor={k === 0 ? "start" : k === ticks.length - 1 ? "end" : "middle"}>
          {axisDayWords(points[t.i]?.day)}
        </text>
      ))}
    </>
  );
}

/**
 * Whether lifting the pointer should clear the readout.
 *
 * It should for a MOUSE and must not for a finger, and getting this backwards
 * is invisible on a desktop. `pointerleave` fires when a touch pointer is
 * destroyed, i.e. the instant you lift — so a shared handler wipes the answer
 * exactly when the finger stops covering it and the reader finally looks. A
 * mouse has hover, so leaving the box genuinely means "not pointing at
 * anything"; a touch has no hover, so the last thing touched IS the selection
 * and stays until something else is.
 */
export const clearsOnLeave = (e: { pointerType?: string }) => e.pointerType === "mouse";

/** The crosshair: a rule at the reading, and a ring on it. Ink, never the
 *  accent — the accent is reserved for WHERE the series ends, and two accents
 *  on one curve is two claims about which point matters. */
export function Crosshair({ at, h, gutter }: { at: Plotted; h: number; gutter: number }) {
  return (
    <g pointerEvents="none">
      <line x1={gutter + at.x} x2={gutter + at.x} y1={0} y2={h}
        stroke="currentColor" strokeOpacity={0.35} strokeWidth={1} />
      <circle cx={gutter + at.x} cy={at.y} r={4} fill="var(--panel)"
        stroke="currentColor" strokeOpacity={0.7} strokeWidth={2} />
    </g>
  );
}
