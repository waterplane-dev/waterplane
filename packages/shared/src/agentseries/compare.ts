/**
 * `compareAround` — one reading `days` before an instant against `days` after it,
 * beside the band of ratios day-to-day variation alone produces.
 *
 * The band: every session keeps its value, but the DAY blocks of the window
 * (a day the instant splits is two blocks) are shuffled between the two sides,
 * keeping each side's block count, and the pooled-median ratio is taken again —
 * `COMPARE_PERMUTATIONS` times from a fixed seed, so the same data always gives
 * the same band. Days, not sessions, are shuffled because sessions on one day
 * are alike (same task, same cache), which a session shuffle would hide and
 * draw the band too narrow. The band is its 2.5–97.5 percentiles.
 *
 * `skills` compares MEANS (`CompareResult.mean`): most sessions load no skill, so a
 * pooled median is 0 and has no ratio. Every other reading compares medians.
 *
 * Same model only: a window whose sessions ran more than one model id (or do
 * not say which) is ABSENT unless a model is named — a model change moves these
 * readings more than any instruction edit does.
 */
import { addLocalDays } from "../calday.js";
import { seriesFilter, seriesReadingOf } from "./series.js";
import { localDayOf, medianOf, percentileSorted, seededRandom } from "./stats.js";
import type { CompareOpts, CompareResult, SeriesAbsent, SeriesPoint } from "./types.js";

export const COMPARE_DEFAULT_DAYS = 14;
/** Fewest day blocks on each side. */
export const COMPARE_MIN_DAYS = 4;
/** Fewest sessions on each side. */
export const COMPARE_MIN_N = 10;
export const COMPARE_PERMUTATIONS = 500;
const SEED = 0x5eed2a11;

/** One day's sessions on one side: `first` is the before side (or, by model, the first model). */
export interface DayBlock { first: boolean; vals: number[] }

const absent = (why: string): SeriesAbsent => ({ absent: why });

const meanOf = (xs: readonly number[]): number | null => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);

/** Pooled-median (or mean) ratio after/before of a split of the blocks; null when the before figure is 0 or a side is empty. */
function ratioOf(blocks: readonly DayBlock[], isBefore: (i: number) => boolean, mean = false): { before: number; after: number; ratio: number } | null {
  const b: number[] = [];
  const a: number[] = [];
  blocks.forEach((bl, i) => (isBefore(i) ? b : a).push(...bl.vals));
  const of = mean ? meanOf : medianOf;
  const mb = of(b);
  const ma = of(a);
  if (mb === null || ma === null || mb <= 0) return null;
  return { before: mb, after: ma, ratio: ma / mb };
}

/**
 * The day-shuffle band — the ONE implementation, used by the before/after and by the model
 * comparison: the measured second/first ratio of the pooled median (or mean), and the 2.5–97.5
 * percentiles of that ratio with whole day blocks shuffled between the two sides, keeping each
 * side's block count, `COMPARE_PERMUTATIONS` times from a fixed seed.
 */
export function dayShuffleBand(blocks: readonly DayBlock[], mean: boolean, firstWord = "before"):
  { seen: { before: number; after: number; ratio: number }; band: [number, number] } | SeriesAbsent {
  const firstCount = blocks.filter((b) => b.first).length;
  const seen = ratioOf(blocks, (i) => blocks[i]!.first, mean);
  if (!seen) return absent(`The ${mean ? "mean" : "median"} ${firstWord} is 0, so there is no ratio to take.`);
  const rand = seededRandom(SEED);
  const order = blocks.map((_, i) => i);
  const ratios: number[] = [];
  for (let k = 0; k < COMPARE_PERMUTATIONS; k++) {
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [order[i], order[j]] = [order[j]!, order[i]!];
    }
    const sideOf = new Array<boolean>(blocks.length);
    order.forEach((blockIdx, pos) => { sideOf[blockIdx] = pos < firstCount; });
    const r = ratioOf(blocks, (i) => sideOf[i]!, mean);
    if (r) ratios.push(r.ratio);
  }
  if (ratios.length < COMPARE_PERMUTATIONS / 2) return absent(`Too many shuffled splits had a ${mean ? "mean" : "median"} of 0 ${firstWord} to draw a band.`);
  ratios.sort((x, y) => x - y);
  return { seen, band: [percentileSorted(ratios, 0.025)!, percentileSorted(ratios, 0.975)!] };
}

export function compareAround(points: readonly SeriesPoint[], atMs: number, opts: CompareOpts): CompareResult | SeriesAbsent {
  if (!Number.isFinite(atMs)) return absent("No instant to compare around.");
  const days = Math.max(1, Math.min(90, Math.floor(opts.days ?? COMPARE_DEFAULT_DAYS)));
  const lo = addLocalDays(atMs, -days);
  const hi = addLocalDays(atMs, days);
  const inWin = seriesFilter(points, opts)
    .filter((p) => p.t0 >= lo && p.t0 < hi && seriesReadingOf(p, opts.reading) !== undefined);

  let model = opts.model;
  if (model === undefined) {
    const models = new Set(inWin.map((p) => p.model ?? ""));
    if (models.has("")) return absent("Some of these sessions do not record their model, so a model change in the window cannot be ruled out.");
    if (models.size > 1) return absent(`More than one model ran in this window (${[...models].sort().join(", ")}); compare one model at a time.`);
    model = models.size === 1 ? [...models][0] : undefined;
  }

  const byKey = new Map<string, { before: boolean; vals: number[] }>();
  for (const p of inWin) {
    const before = p.t0 < atMs;
    const key = `${localDayOf(p.t0)}|${before ? "b" : "a"}`;
    const bl = byKey.get(key) ?? { before, vals: [] };
    bl.vals.push(seriesReadingOf(p, opts.reading)!);
    byKey.set(key, bl);
  }
  const blocks = [...byKey.keys()].sort().map((k) => byKey.get(k)!);
  const daysBefore = blocks.filter((b) => b.before).length;
  const daysAfter = blocks.length - daysBefore;
  const nBefore = blocks.filter((b) => b.before).reduce((s, b) => s + b.vals.length, 0);
  const nAfter = inWin.length - nBefore;
  if (daysBefore < COMPARE_MIN_DAYS || daysAfter < COMPARE_MIN_DAYS) {
    return absent(`${daysBefore} days with sessions before and ${daysAfter} after; a comparison needs at least ${COMPARE_MIN_DAYS} on each side.`);
  }
  if (nBefore < COMPARE_MIN_N || nAfter < COMPARE_MIN_N) {
    return absent(`${nBefore} sessions before and ${nAfter} after; a comparison needs at least ${COMPARE_MIN_N} on each side.`);
  }
  const mean = opts.reading === "skills";
  const shuffled = dayShuffleBand(blocks.map((b) => ({ first: b.before, vals: b.vals })), mean);
  if ("absent" in shuffled) return shuffled;
  const { seen, band } = shuffled;
  return {
    before: seen.before, after: seen.after, ratio: seen.ratio, band,
    inside: seen.ratio >= band[0] && seen.ratio <= band[1],
    nBefore, nAfter, daysBefore, daysAfter,
    ...(model !== undefined ? { model } : {}),
    ...(mean ? { mean: true as const } : {}),
  };
}
