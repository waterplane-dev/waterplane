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

interface Block { before: boolean; vals: number[] }

const absent = (why: string): SeriesAbsent => ({ absent: why });

/** Pooled-median ratio after/before of a split of the blocks; null when the before median is 0 or a side is empty. */
function ratioOf(blocks: readonly Block[], isBefore: (i: number) => boolean): { before: number; after: number; ratio: number } | null {
  const b: number[] = [];
  const a: number[] = [];
  blocks.forEach((bl, i) => (isBefore(i) ? b : a).push(...bl.vals));
  const mb = medianOf(b);
  const ma = medianOf(a);
  if (mb === null || ma === null || mb <= 0) return null;
  return { before: mb, after: ma, ratio: ma / mb };
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

  const byKey = new Map<string, Block>();
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
  const seen = ratioOf(blocks, (i) => blocks[i]!.before);
  if (!seen) return absent("The median before is 0, so there is no ratio to take.");

  const rand = seededRandom(SEED);
  const order = blocks.map((_, i) => i);
  const ratios: number[] = [];
  for (let k = 0; k < COMPARE_PERMUTATIONS; k++) {
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [order[i], order[j]] = [order[j]!, order[i]!];
    }
    const sideOf = new Array<boolean>(blocks.length);
    order.forEach((blockIdx, pos) => { sideOf[blockIdx] = pos < daysBefore; });
    const r = ratioOf(blocks, (i) => sideOf[i]!);
    if (r) ratios.push(r.ratio);
  }
  if (ratios.length < COMPARE_PERMUTATIONS / 2) return absent("Too many shuffled splits had a median of 0 before to draw a band.");
  ratios.sort((x, y) => x - y);
  const band: [number, number] = [percentileSorted(ratios, 0.025)!, percentileSorted(ratios, 0.975)!];
  return {
    before: seen.before, after: seen.after, ratio: seen.ratio, band,
    inside: seen.ratio >= band[0] && seen.ratio <= band[1],
    nBefore, nAfter, daysBefore, daysAfter,
    ...(model !== undefined ? { model } : {}),
  };
}
