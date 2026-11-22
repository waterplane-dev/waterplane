/**
 * Throughput of a transfer the native engine runs, from two readings of its
 * byte count. The service reports only `received`, so the rate is the growth
 * between two syncs over the time between them, smoothed like the range
 * engine's (`pullRange.ts`): a raw per-sync figure on a mobile link swings by
 * an order of magnitude and is unreadable.
 *
 * Degrades to ABSENT, never to a wrong number: no earlier reading, a reading
 * too old to be about this run (a pause, a frozen document), or no growth
 * since it — the row then shows its percent without a speed.
 */
export const RATE_SAMPLE_MAX_GAP_MS = 30_000;

export interface RateSample { received: number; at: number }

export function nextNativeRate(
  prevRate: number | undefined,
  prev: RateSample | undefined,
  received: number,
  now: number,
): number | undefined {
  if (!prev) return undefined;
  const dt = now - prev.at;
  if (dt <= 0 || dt > RATE_SAMPLE_MAX_GAP_MS) return undefined;
  const bytes = received - prev.received;
  if (bytes <= 0) return prevRate;
  const inst = bytes / (dt / 1000);
  return prevRate ? prevRate * 0.7 + inst * 0.3 : inst;
}
