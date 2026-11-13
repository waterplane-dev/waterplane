/** Medians, percentiles and a seeded PRNG for the agent series — pure, no clock. */
import { hourKey } from "../costwindow.js";

/** Median of finite numbers; null for none. */
export function medianOf(xs: readonly number[]): number | null {
  const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const m = v.length >> 1;
  return v.length % 2 ? v[m]! : (v[m - 1]! + v[m]!) / 2;
}

/** Linear-interpolated percentile (`p` in 0..1) of an ascending array; null for none. */
export function percentileSorted(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const at = Math.min(1, Math.max(0, p)) * (sorted.length - 1);
  const lo = Math.floor(at);
  const hi = Math.ceil(at);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (at - lo);
}

/** mulberry32: a small deterministic PRNG, uniform in [0, 1). */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The local calendar day (`YYYY-MM-DD`) an instant falls in. */
export const localDayOf = (t: number): string => hourKey(t).slice(0, 10);
