/**
 * The line beside the health score: what one Claude request in this repo
 * carried, per week (`shared/healthspend.ts` folds it on the host). Geometry
 * and sentences, pure (`healthSpendWords.test.mjs`); `HealthIndexChart.tsx`
 * paints them.
 *
 * Its own axis, fitted and PRINTED on the right — tokens are not points out of
 * 100, and an unlabelled fitted axis reads as a zero-based one. x is the
 * score's own point index, so a week the score has and the ledger does not is
 * a HOLE that cuts the line, never a zero and never interpolated. Dotted and in
 * a slot hue, so it is told from the score by pattern as well as by colour.
 */
import type { HealthSpendWeek } from "@waterplane/shared";
import { fmtTokens, fmtTokensFine } from "./kit/chart/chartFmt.ts";

export interface SpendLineGeom {
  /** Solid-run path through consecutive weeks that have a value. */
  d: string;
  /** Weeks with a value and no neighbour to join. */
  dots: { x: number; y: number }[];
  /** One per score point; null where the ledger has no request that week. */
  vals: (number | null)[];
  ys: (number | null)[];
  lo: number;
  hi: number;
  /** Where to print the two bounds (one label when flat). */
  hiY: number;
  loY: number;
  flat: boolean;
  /** Score weeks the line reaches, and the first of them. */
  covered: number;
  firstWeek: string | null;
}

/** Tokens per request for one week; null where nothing was requested. */
export function ctxPerRequest(w: Pick<HealthSpendWeek, "requests" | "ctxTok"> | null | undefined): number | null {
  return w && w.requests > 0 && Number.isFinite(w.ctxTok) ? w.ctxTok / w.requests : null;
}

/**
 * The line over the score's weeks. `px` must be the score's own x (the same
 * `i / (n − 1) · w`, `w` for a lone point) so a week reads at one x on both.
 * Null when no score week has a value — the caller says why, in words.
 */
export function spendLineGeom(
  weeks: readonly { week: string }[],
  spend: readonly HealthSpendWeek[] | undefined,
  w: number,
  h: number,
): SpendLineGeom | null {
  const n = weeks.length;
  if (!spend || n < 1 || !(w > 0) || !(h > 0)) return null;
  const byWeek = new Map(spend.map((s) => [s.week, ctxPerRequest(s)]));
  const vals = weeks.map((p) => byWeek.get(p.week) ?? null);
  const fit = fitSpend(vals, h);
  if (!fit) return null;
  const px = (i: number) => (n === 1 ? w : (i / (n - 1)) * w);
  const { ys } = fit;
  const runs: string[] = [];
  const dots: { x: number; y: number }[] = [];
  let run: number[] = [];
  const flush = () => {
    if (run.length > 1) runs.push(`M${run.map((k) => `${px(k).toFixed(1)},${ys[k]!.toFixed(1)}`).join("L")}`);
    else if (run.length === 1) dots.push({ x: px(run[0]), y: ys[run[0]]! });
    run = [];
  };
  for (let i = 0; i < n; i++) {
    if (ys[i] === null) flush(); else run.push(i);
  }
  flush();
  return { d: runs.join(""), dots, vals, ...fit, firstWeek: firstWeekOf(weeks, vals) };
}

/** The fitted y both spend geometries share: padded both ends, a flat series at mid-height. */
function fitSpend(vals: readonly (number | null)[], h: number): Omit<SpendLineGeom, "d" | "dots" | "vals" | "firstWeek"> | null {
  const have = vals.filter((v): v is number => v !== null);
  if (!have.length) return null;
  const lo = Math.min(...have);
  const hi = Math.max(...have);
  const flat = hi - lo <= 0;
  // A few pixels of headroom both ends so the line never sits on the frame.
  const pad = 6;
  const py = (v: number) => (flat ? h / 2 : pad + (1 - (v - lo) / (hi - lo)) * (h - 2 * pad));
  return { ys: vals.map((v) => (v === null ? null : py(v))), lo, hi, flat, hiY: py(hi), loY: py(lo), covered: have.length };
}

function firstWeekOf(points: readonly { week: string }[], vals: readonly (number | null)[]): string | null {
  const i = vals.findIndex((v) => v !== null);
  return i >= 0 ? points[i].week : null;
}

/**
 * The same figure in commits mode: every commit point takes its WEEK's
 * per-request value (the ledger is per week, never per commit), drawn as
 * horizontal steps — flat across a week's commits, a vertical where the week
 * changes, halfway between the last commit of one week and the first of the
 * next. A week with no ledger row is a hole that cuts the steps; a run of one
 * point is a dot. Same fitted y and printed bounds as `spendLineGeom`, and the
 * same x as the score (`i / (n − 1) · w`).
 */
export function spendStepGeom(
  points: readonly { week: string }[],
  spend: readonly HealthSpendWeek[] | undefined,
  w: number,
  h: number,
): SpendLineGeom | null {
  const n = points.length;
  if (!spend || n < 1 || !(w > 0) || !(h > 0)) return null;
  const byWeek = new Map(spend.map((s) => [s.week, ctxPerRequest(s)]));
  const vals = points.map((p) => byWeek.get(p.week) ?? null);
  const fit = fitSpend(vals, h);
  if (!fit) return null;
  const { ys } = fit;
  const px = (i: number) => (n === 1 ? w : (i / (n - 1)) * w);
  const runs: string[] = [];
  const dots: { x: number; y: number }[] = [];
  let run: number[] = [];
  const flush = () => {
    if (run.length > 1) {
      let d = `M${px(run[0]).toFixed(1)},${ys[run[0]]!.toFixed(1)}`;
      for (let j = 1; j < run.length; j++) {
        const a = run[j - 1];
        const b = run[j];
        if (ys[b] !== ys[a]) {
          const mid = (px(a) + px(b)) / 2;
          d += `H${mid.toFixed(1)}V${ys[b]!.toFixed(1)}`;
        }
      }
      d += `H${px(run[run.length - 1]).toFixed(1)}`;
      runs.push(d);
    } else if (run.length === 1) dots.push({ x: px(run[0]), y: ys[run[0]]! });
    run = [];
  };
  for (let i = 0; i < n; i++) {
    if (ys[i] === null) flush(); else run.push(i);
  }
  flush();
  return { d: runs.join(""), dots, vals, ...fit, firstWeek: firstWeekOf(points, vals) };
}

/** The caption clause under the step line. */
export const SPEND_STEP_WORDS = "one value per week, drawn across that week's commits";

/** An axis label: `84k`. */
export const spendTick = (v: number): string => fmtTokens(v);

/** The readout's clause for the picked week. */
export function spendReadoutWords(v: number | null): string {
  return v === null ? "no Claude request on record" : `${fmtTokensFine(v)} tokens per Claude request`;
}

/**
 * The words under the chart, cut in two: `lead` is the one open sentence (what
 * the dotted line is, and that it costs money AND wait); `more` folds — which
 * readings reach it directly. `contextChars` is the latest CLAUDE.md + skill
 * descriptions reading, named when it is on the wire.
 */
export function spendLeadWords(contextChars: number | null | undefined): { lead: string; more: string } {
  const chars = typeof contextChars === "number" && Number.isFinite(contextChars) && contextChars > 0
    ? ` (${Math.round(contextChars).toLocaleString("en-US")} chars now)` : "";
  return {
    lead: "Dotted line: tokens each Claude request here re-sent — paid in money and in wait time.",
    more:
      "Right axis, per week. It is paid twice because every request reads all of it again before the answer starts. " +
      `Of the five readings, CLAUDE.md + skill descriptions${chars} is in every request; ` +
      "file length, re-touched files, escape hatches and untested modules reach it only when the agent opens those files.",
  };
}

/** Where the line starts later than the score, and why — an absence, so it stays in the open. */
export function spendCoverageWords(g: SpendLineGeom | null, weeks: readonly { week: string }[], spend: readonly HealthSpendWeek[] | undefined): string | null {
  if (!spend) return null;
  if (!g) return "No Claude request in this repo is on record for the scored weeks, so there is no tokens-per-request line.";
  if (g.firstWeek && weeks[0] && g.firstWeek !== weeks[0].week) {
    return `Claude's logs on this desktop reach this repo from the week of ${g.firstWeek}; the weeks before it have no line.`;
  }
  return null;
}

/** The method, folded: how the figure is made and what moves it more than any reading. */
export const SPEND_METHOD_WORDS =
  "A week's context tokens divided by its requests — input, cache reads and cache writes, output left out — subagents included, read from the CLI's own logs on this desktop. " +
  "Which model ran and how long sessions grew move it more than any reading here, so it sits beside the score as context and is no part of it.";
