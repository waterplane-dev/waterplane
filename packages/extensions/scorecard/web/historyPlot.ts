/**
 * The score-over-time chart's geometry and words, pure (node-tested, no DOM). The y axis is FIXED,
 * 0 to 10, labelled on every rule — never fitted, so a move from 7.4 to 7.7 looks as small as it is.
 * x is the READING INDEX, not the calendar: runs bunch on busy days, and a calendar axis would draw
 * them as one tick. Dates are printed at three positions in reading order.
 */
import type { ScorePoint } from "../shared/wire.mts";

export const PLOT_H = 120;
export const PAD = { top: 8, right: 10, bottom: 18, left: 24 };
export const Y_RULES = [0, 5, 10] as const;

export interface Geom {
  w: number;
  pts: { x: number; y: number }[];
  d: string;
  rules: { v: number; y: number }[];
  ticks: { x: number; label: string; anchor: "start" | "middle" | "end" }[];
}

const f1 = (v: number) => v.toFixed(1);
const day = (iso: string) => iso.slice(0, 10);

/** Null below two points: one reading is a sentence, never a line. */
export function geom(points: readonly ScorePoint[], width: number): Geom | null {
  const n = points.length;
  if (n < 2 || !(width > PAD.left + PAD.right + 10)) return null;
  const w = width - PAD.left - PAD.right;
  const h = PLOT_H - PAD.top - PAD.bottom;
  const y = (v: number) => PAD.top + h - (Math.max(0, Math.min(10, v)) / 10) * h;
  const x = (i: number) => PAD.left + (i * w) / (n - 1);
  const pts = points.map((p, i) => ({ x: x(i), y: y(p.score) }));
  const at = [...new Set([0, Math.round((n - 1) / 2), n - 1])];
  return {
    w: width,
    pts,
    d: pts.map((p, i) => `${i ? "L" : "M"}${f1(p.x)},${f1(p.y)}`).join(""),
    rules: Y_RULES.map((v) => ({ v, y: y(v) })),
    ticks: at.map((i) => ({ x: x(i), label: day(points[i]!.date).slice(5), anchor: i === 0 ? "start" : i === n - 1 ? "end" : "middle" })),
  };
}

/** The index nearest an x pixel (the pointer), in reading order. */
export function pickIndex(g: Geom, px: number): number {
  let best = 0;
  for (let i = 1; i < g.pts.length; i++) if (Math.abs(g.pts[i]!.x - px) < Math.abs(g.pts[best]!.x - px)) best = i;
  return best;
}

const sc = (v: number | undefined) => (v === undefined ? "absent" : v < 0 ? "n/a" : String(v));

/** What moved between two runs: each check whose score differs, "Name a→b". */
export function changes(prev: ScorePoint, cur: ScorePoint): string[] {
  const names = [...new Set([...Object.keys(prev.checks), ...Object.keys(cur.checks)])].sort();
  return names.filter((k) => prev.checks[k] !== cur.checks[k]).map((k) => `${k} ${sc(prev.checks[k])}→${sc(cur.checks[k])}`);
}

const signed = (v: number) => `${v > 0 ? "+" : v < 0 ? "−" : "±"}${Math.abs(Math.round(v * 10) / 10)}`;

/** The text line under the chart for reading `i`: day · score · commit, then what moved since the run before. */
export function readout(points: readonly ScorePoint[], i: number): { head: string; moved: string | null } {
  const p = points[i]!;
  const head = `${day(p.date)} · ${p.score}/10${p.commit ? ` · ${p.commit.slice(0, 7)}` : ""}`;
  if (i === 0) return { head, moved: "the first run kept" };
  const prev = points[i - 1]!;
  const ch = changes(prev, p);
  // Two runs on one day: the date would name itself, so the run before is named by its commit.
  const before = day(prev.date) === day(p.date) && prev.commit ? `the run before (${prev.commit.slice(0, 7)})` : day(prev.date);
  const lead = `${signed(p.score - prev.score)} since ${before}`;
  return { head, moved: ch.length ? `${lead}: ${ch.join(", ")}` : `${lead}; no check changed` };
}

/** The sentence standing where a line cannot be drawn, or null when there is a line. */
export function absentWords(n: number, pending: boolean, first?: ScorePoint): string | null {
  if (n >= 2) return null;
  if (pending) return "Reading past runs back from the Scorecard API…";
  if (n === 1 && first) return `One run kept so far (${day(first.date)}, ${first.score}/10) — a line needs two.`;
  return "No run kept yet.";
}

/** The caption: how many runs, and whose score it is. The span is on the x axis; the method is in the Explain. */
export function spanWords(n: number, local: boolean): string {
  return `${n} run${n === 1 ? "" : "s"}${local ? " · scored locally (private repo), not the public score" : ""}`;
}

/** The Explain under the section's `?`: how the axis is laid out. */
export const AXIS_WORDS = "One point per Scorecard run, evenly spaced in the order they ran — not by date, so a busy day does not crush its runs into one spot. The dates under the chart are the first run, the middle run and the latest, not the middle of the calendar span.";
