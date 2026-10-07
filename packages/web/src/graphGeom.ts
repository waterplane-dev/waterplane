/**
 * The geometry of the sheet's machine graphs (`SysGraph.tsx`), pure so it can
 * be pinned by `node --test`.
 *
 * The strip's spark (`HeldSpark`) lays its readings into a FIXED number of
 * slots and right-aligns them, which is right for 22 px and wrong for a sheet:
 * forty-seven readings in a 120-slot frame drew the line into the right third
 * of a 280 px box and left the rest of the section blank. Here the readings
 * span the width they are given, every graph carries its scale on the axis,
 * and the latest/lowest/highest are said in words — a line with no numbers
 * beside it is a shape, not a reading.
 *
 * The rules `HeldSpark` keeps are kept: a `null` is a stretch nobody watched
 * and is drawn as its own mark, never bridged; a lone reading between two gaps
 * is a dot, never dropped; values are CLAMPED to the frame, never drawn past it.
 */

export type Series = readonly (number | null)[];

export interface Frame {
  w: number;
  h: number;
  /** The value at the bottom edge. */
  lo: number;
  /** The value at the top edge. */
  hi: number;
}

export interface LineGeom {
  /** One polyline per unbroken run, as SVG `points`. */
  runs: string[];
  /** The same runs closed down to the bottom edge, for a faint fill. */
  areas: string[];
  /** Lone readings with a gap on both sides. */
  dots: { x: number; y: number }[];
}

/** The x of reading `i` of `n`, spread across the whole width. */
export function xAt(i: number, n: number, w: number): number {
  return n <= 1 ? w : (i * w) / (n - 1);
}

/** The y of `v`, clamped into the frame (a reading past the ceiling sits ON it). */
export function yAt(v: number, f: Frame): number {
  const span = f.hi - f.lo;
  const t = span > 0 ? Math.min(1, Math.max(0, (v - f.lo) / span)) : 0;
  return f.h - t * (f.h - 1) - 0.5;
}

export function lineGeom(series: Series, f: Frame): LineGeom {
  const n = series.length;
  const pt = (i: number, v: number) => ({ x: xAt(i, n, f.w), y: yAt(v, f) });
  const runs: string[] = [];
  const areas: string[] = [];
  let run: { x: number; y: number }[] = [];
  const close = () => {
    if (run.length > 1) {
      const pts = run.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
      runs.push(pts);
      areas.push(`${run[0].x.toFixed(1)},${f.h} ${pts} ${run[run.length - 1].x.toFixed(1)},${f.h}`);
    }
    run = [];
  };
  for (let i = 0; i < n; i++) {
    const v = series[i];
    if (v == null) { close(); continue; }
    run.push(pt(i, v));
  }
  close();
  const dots: { x: number; y: number }[] = [];
  for (let i = 0; i < n; i++) {
    const v = series[i];
    if (v != null && (i === 0 || series[i - 1] == null) && (i === n - 1 || series[i + 1] == null)) dots.push(pt(i, v));
  }
  return { runs, areas, dots };
}

/**
 * Where nobody was watching: the x of every index that is `null` in EVERY
 * line. A gap in one line only (a GPU reader that missed while the CPU did
 * not) is that line's break, not a stretch of the whole graph.
 */
export function gapXs(lines: readonly Series[], w: number): number[] {
  const n = Math.max(0, ...lines.map((s) => s.length));
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    if (lines.every((s) => s[i] == null)) out.push(xAt(i, n, w));
  }
  return out;
}

export interface Stats { last: number; min: number; max: number }

/** Latest, lowest and highest of what was actually read — null with no reading at all. */
export function seriesStats(series: Series): Stats | null {
  let last: number | null = null;
  let min = Infinity;
  let max = -Infinity;
  for (const v of series) {
    if (v == null) continue;
    last = v;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return last == null ? null : { last, min, max };
}

/** Three gridlines: the floor, the middle and the ceiling. */
export function ticks(lo: number, hi: number): number[] {
  return [hi, (lo + hi) / 2, lo];
}

/**
 * A ceiling for a reading with no known maximum (a fan's rpm): the peak with
 * a quarter's headroom, rounded up to `step`, never under `floor`. The one
 * fitted axis on the sheet, and the caption says so.
 */
export function roomyCeiling(series: Series, floor: number, step: number): number {
  let peak = 0;
  for (const v of series) if (v != null && v > peak) peak = v;
  return Math.max(floor, Math.ceil((peak * 1.25) / step) * step);
}
