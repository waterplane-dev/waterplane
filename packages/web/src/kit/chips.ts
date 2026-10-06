/**
 * The pure half of `CountChips`: what a chip SAYS and what a tap does.
 *
 * A chip's number and the cut it opens must come from ONE bucketing function
 * per sheet (CLAUDE.md: a count on a control is a filter). `chipRows` is where
 * that function is called, once per key, and its result feeds the text drawn
 * here — the sheet then uses the same function's rows for the list.
 */

/** What one bucket answers: how many, and optionally what else to say beside it (bytes, ...). */
export interface Bucket { count: number; detail?: string }

/** "label · 27 · 3.9 GB" — an empty bucket is still a chip ("none older than a year" is an answer). */
export function chipText(label: string, b: Bucket): string {
  return b.detail ? `${label} · ${b.count} · ${b.detail}` : `${label} · ${b.count}`;
}

/** A tap on the active chip clears the cut; a tap on another moves it. */
export function toggleChip<K extends string | number>(active: K | null, key: K): K | null {
  return active === key ? null : key;
}

/** One bucketing call per key, in order. */
export function chipRows<K extends string | number>(
  keys: readonly K[],
  bucket: (k: K) => Bucket,
  label: (k: K) => string,
): { key: K; text: string; count: number }[] {
  return keys.map((key) => {
    const b = bucket(key);
    return { key, text: chipText(label(key), b), count: b.count };
  });
}
