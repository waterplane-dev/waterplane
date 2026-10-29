/**
 * The choice box slices' shared small tools (`sessions/boxes.ts`, `sessions/boxread.ts`):
 * the health sample tail (taking its row count: knobs are a slice import), the one wait a box walk makes and the guard around a
 * contributed reader. A flat leaf rather than a slice, because a slice reaches
 * another slice only through `core`.
 */
/**
 * The tail of a screen ending at the row a matcher was looking for.
 *
 * Anchored on the MATCHED row rather than sliced off the bottom, for the same
 * reason `deliver.ts` places its echo instead of taking the last N rows: the
 * bottom of a claude screen is the composer and the working line, and a sample
 * that shows those says nothing about the box above them.
 */
export function healthTail(screen: string, anchor: (line: string) => boolean, sampleRows: number): string {
  const rows = screen.split("\n");
  let hit = -1;
  for (let i = rows.length - 1; i >= 0; i--) if (anchor(rows[i])) { hit = i; break; }
  if (hit < 0) hit = rows.length - 1;
  return rows.slice(Math.max(0, hit - sampleRows + 1), hit + 1).join("\n");
}

/** A settle between a walk's keystroke and its re-read — the box walks' one wait. */
export const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** A contributed reader's answer, or `fallback` when it threw: a throw reads as "no box". */
export function safe<T>(fn: () => T, fallback: T): T {
  try { return fn(); } catch { return fallback; }
}

