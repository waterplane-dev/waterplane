/**
 * The tabs list's highlight, held as the highlighted row's KEY and read back
 * as an index. A bare index drifted when a tab closed or the order changed
 * while the list was open: Return opened a different tab or nothing. A key
 * that has gone clamps `lastAt` into the list; an empty list is -1.
 */
export function highlightAt(keys: readonly string[], hl: string | null, lastAt: number): number {
  if (keys.length === 0) return -1;
  const i = hl === null ? -1 : keys.indexOf(hl);
  if (i >= 0) return i;
  return Math.min(Math.max(0, lastAt), keys.length - 1);
}

/** The key one step (wrapping) from the current highlight; null on an empty list. */
export function stepHighlight(keys: readonly string[], hl: string | null, lastAt: number, d: number): string | null {
  if (keys.length === 0) return null;
  const at = highlightAt(keys, hl, lastAt);
  return keys[(at + d + keys.length) % keys.length];
}

/**
 * The key to STORE for what is drawn. Once the highlighted tab has closed the
 * drawn row is the clamped neighbour; storing its key makes the highlight an
 * identity again, so a later reorder cannot hand Return a stranger.
 */
export function reanchor(keys: readonly string[], hl: string | null, lastAt: number): string | null {
  if (keys.length === 0) return hl;
  return keys[highlightAt(keys, hl, lastAt)];
}
