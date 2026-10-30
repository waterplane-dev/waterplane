// healthindex/words: One wording of a move for the phone and VS Code. Barrel: ../healthindex.ts (read the header there).
import { HEALTH_ENTRIES, type HealthEntry, HEALTH_INDEX_MONTH_WEEKS, type HealthIndexPoint } from "./types.js";
import { type HealthMove } from "./move.js";
import { HEALTH_ENTRY_LABEL } from "./score.js";

const ENTRY_WORDS: Record<HealthEntry, [string, string]> = {
  size: ["files grew longer", "files got shorter"],
  retouch: ["more re-touched files", "fewer re-touched files"],
  hatches: ["more escape hatches", "fewer escape hatches"],
  context: ["CLAUDE.md + skill descriptions grew", "CLAUDE.md + skill descriptions shrank"],
  untested: ["more untested modules", "fewer untested modules"],
};

/** A signed whole number with a real minus sign: `−4`, `+3`, `±0`. */
export function signedPoints(n: number): string {
  const r = Math.round(n);
  if (r === 0) return "±0";
  return r < 0 ? `−${-r}` : `+${r}`;
}

export interface HealthWords {
  /** Short label for the repo row: `Health 94 −4`. */
  chip: string;
  /** `Health score 94 (−4 this week)`. */
  title: string;
  /** Names the (at most two) metrics — or the cap — that carried the move, plus a split-up note where a rise is mostly files multiplying; "" when none can be named. */
  body: string;
}

/**
 * When the latest measured week happened, worded against the week it is now:
 * `this week` only when they are the same ISO week — a week with no commit has
 * no point, so the newest one can be months old — else `in the week of <Monday>`.
 * `currentWeek` absent = the caller did not say, and the claim falls back to
 * naming the week (never a `this week` nobody checked).
 */
export function healthWeekWhen(week: string, currentWeek?: string | null): string {
  return currentWeek && week === currentWeek ? "this week" : `in the week of ${week}`;
}

/**
 * The notification and chip wording for a called move. `null` when there is
 * nothing to say (no move called, or no points) — a sentence is never written
 * around a null. `currentWeek` (the ISO week's Monday, `isoWeekOf(today)`)
 * decides whether the latest point may be called "this week".
 */
export function healthMoveWords(points: readonly HealthIndexPoint[], move: HealthMove, currentWeek?: string | null): HealthWords | null {
  const last = points[points.length - 1];
  if (!last || !move.kind || !move.horizon || move.delta === null) return null;
  const value = Math.round(last.index);
  const span = move.horizon === "week" ? 1 : HEALTH_INDEX_MONTH_WEEKS;
  const latest = currentWeek && last.week === currentWeek;
  const when = move.horizon === "week"
    ? healthWeekWhen(last.week, currentWeek)
    : latest ? "over four weeks" : `over the four weeks to ${last.week}`;
  // Each comparable week's move, split exactly. The entries' log contributions
  // sum to prev.mean·Δln(mean) (a geomean), so scaling them by (eˣ−1)/x makes
  // them sum to Δmean; what is left of Δindex is the cap tightening or easing.
  const sums: Partial<Record<HealthEntry, number>> = {};
  let capSum = 0;
  let capEntry: HealthEntry | null = null;
  let capFrom: HealthEntry | null = null;
  let capTo: HealthEntry | null = null;
  let capBiggest = 0;
  for (let i = Math.max(1, points.length - span); i < points.length; i++) {
    const p = points[i];
    const prev = points[i - 1];
    if (p.gap) continue;
    const x = Math.log(p.mean / prev.mean);
    const k = Math.abs(x) < 1e-12 ? 1 : Math.expm1(x) / x;
    for (const e of HEALTH_ENTRIES) {
      const c = p.contributions[e];
      if (c !== undefined) sums[e] = (sums[e] ?? 0) + c * k;
    }
    const cap = (p.index - prev.index) - (p.mean - prev.mean);
    capSum += cap;
    const by = cap > 0 ? prev.cappedBy : p.cappedBy;
    if (by && Math.abs(cap) > capBiggest) {
      capBiggest = Math.abs(cap);
      capEntry = by;
      capFrom = prev.cappedBy;
      capTo = p.cappedBy;
    }
  }
  const sign = move.kind === "drop" ? -1 : 1;
  const parts: { pts: number; words: string }[] = HEALTH_ENTRIES
    .filter((e) => (sums[e] ?? 0) * sign > 0)
    .map((e) => ({ pts: sums[e] ?? 0, words: ENTRY_WORDS[e][move.kind === "drop" ? 0 : 1] }));
  if (capEntry && capSum * sign > 0) {
    const label = HEALTH_ENTRY_LABEL[capEntry];
    const words = sign > 0
      ? capTo === capEntry ? `${label} holds the score down less` : `${label} no longer holds the score down`
      : capFrom === capEntry ? `${label} holds the score down more` : `${label} now holds the score down`;
    parts.push({ pts: capSum, words });
  }
  const top = parts
    .filter((x) => Math.round(x.pts) !== 0)
    .sort((a, b) => Math.abs(b.pts) - Math.abs(a.pts))
    .slice(0, 2)
    .map((x) => `${x.words} (${signedPoints(x.pts)})`);
  const split = move.kind === "rise" ? splitNote(points, span, (sums.size ?? 0) + (capEntry === "size" ? capSum : 0), move.delta) : null;
  const verb = move.kind === "drop" ? "slipped" : "rose";
  const pts = Math.abs(Math.round(move.delta));
  const body = top.length
    ? `The score ${verb} ${pts} point${pts === 1 ? "" : "s"} ${when}: ${top.join(", ")}.`
    : `The score ${verb} ${pts} point${pts === 1 ? "" : "s"} ${when}.`;
  return {
    chip: `Health ${value} ${signedPoints(move.delta)}`,
    title: `Health score ${value} (${signedPoints(move.delta)} ${when})`,
    body: split ? `${body} ${split}` : body,
  };
}

const commas = (n: number): string => Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/** A rise is "mostly files split up" when file length carried at least half of it and the tree gained this share of files. */
const HEALTH_SPLIT_FILES_RATIO = 1.5;

/**
 * The note for a rise carried by file length while the files multiplied and
 * the code did not shrink — the signature of splitting, which the score
 * rewards whether or not the design got better. Null where the tree was not
 * measured at either end, or the rise was not mostly file length.
 */
function splitNote(points: readonly HealthIndexPoint[], span: number, sizePts: number, delta: number): string | null {
  if (!(delta > 0) || sizePts < delta / 2) return null;
  const from = points[Math.max(0, points.length - span - 1)]?.tree;
  const to = points[points.length - 1]?.tree;
  if (!from || !to || from.files <= 0 || from.loc <= 0) return null;
  if (to.files < from.files * HEALTH_SPLIT_FILES_RATIO || to.loc < from.loc * 0.9) return null;
  return `Mostly files split up: ${commas(from.files)} → ${commas(to.files)} source files while the code went from ${commas(from.loc)} to ${commas(to.loc)} lines. The score cannot tell whether the design got better.`;
}

/** What `RepoTarget.healthIndex` carries. */
