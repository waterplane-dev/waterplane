/**
 * The speed test's live graph, as numbers: raw progress callbacks (elapsed ms, bytes so far)
 * turned into a throughput-over-time series.
 *
 * Progress events arrive at whatever pace the network stack hands out chunks — hundreds a
 * second on a LAN, a few bursts on a relayed tunnel — so a rate between two neighbouring
 * events is noise. Each point is the rate over a window of at least `binMs`; the last,
 * shorter window is kept so the line reaches the moment the transfer ended.
 *
 * Pure: no DOM, no clock. `SpeedTestSheet.tsx` draws it.
 */

/** One progress callback: ms since the transfer started, bytes moved so far. */
export interface SpeedSample { ms: number; bytes: number }
/** One point of the graph: seconds since start (window end), megabits per second over the window. */
export interface SpeedPoint { t: number; mbps: number }

/** Window width: a 32 MB run over a 20 Mbps tunnel gives ~50 points, over a LAN still a handful. */
export const SPEED_BIN_MS = 250;

const mbpsOf = (bytes: number, ms: number): number => (bytes * 8) / (ms / 1000) / 1e6;

export function rateSeries(samples: readonly SpeedSample[], binMs = SPEED_BIN_MS): SpeedPoint[] {
  const out: SpeedPoint[] = [];
  let from: SpeedSample = { ms: 0, bytes: 0 };
  let last: SpeedSample | null = null;
  for (const s of samples) {
    if (s.ms < from.ms || s.bytes < from.bytes) continue; // out of order: never a negative rate
    last = s;
    if (s.ms - from.ms >= binMs) {
      out.push({ t: s.ms / 1000, mbps: mbpsOf(s.bytes - from.bytes, s.ms - from.ms) });
      from = s;
    }
  }
  // The tail window, if it moved bytes — short, but it is where the transfer ended.
  if (last && last !== from && last.ms > from.ms && last.bytes > from.bytes) {
    out.push({ t: last.ms / 1000, mbps: mbpsOf(last.bytes - from.bytes, last.ms - from.ms) });
  }
  return out;
}

/** A y-axis top that is a round number at or above the peak: 1, 2, 5 × 10ⁿ. */
export function niceCeil(v: number): number {
  if (!(v > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}
