/**
 * The connection test's numbers and its one sentence (pure; `SpeedTestSheet.tsx`).
 *
 * A round trip that got no answer is `null` and is COUNTED, never averaged in —
 * the strip's rule (`link/linkPulse.ts`): one ping in four lost feels nothing
 * like a slow link, so the two are said apart.
 */

export interface LatencySummary {
  /** Round trips sent. */
  sent: number;
  /** Of those, how many got no answer in time. */
  lost: number;
  median: number | null;
  best: number | null;
  worst: number | null;
  /** Mean change between consecutive answered round trips: how much the delay wobbles. */
  jitter: number | null;
}

export function summarizeLatency(samples: readonly (number | null)[]): LatencySummary {
  const good = samples.filter((s): s is number => s != null);
  const sorted = [...good].sort((a, b) => a - b);
  let jitter: number | null = null;
  if (good.length >= 2) {
    let sum = 0;
    for (let i = 1; i < good.length; i++) sum += Math.abs(good[i] - good[i - 1]);
    jitter = sum / (good.length - 1);
  }
  return {
    sent: samples.length,
    lost: samples.length - good.length,
    median: sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : null,
    best: sorted.length ? sorted[0] : null,
    worst: sorted.length ? sorted[sorted.length - 1] : null,
    jitter,
  };
}

/** What the numbers mean for driving a session from the phone, in one sentence. */
export function latencyVerdict(s: LatencySummary): string {
  if (!s.sent) return "";
  if (s.median == null) return `None of ${s.sent} round trips got an answer — the desktop is not reachable on this address right now.`;
  const lossPart = s.lost ? ` ${s.lost} of ${s.sent} got no answer, so some sends will need a retry.` : "";
  const shaky = s.jitter != null && s.jitter > Math.max(50, s.median);
  const base = s.median < 60 ? "Fast: typing and taps feel immediate."
    : s.median < 200 ? "Usable: a short delay after each tap."
    : s.median < 600 ? "Slow: typing echoes with a visible lag."
    : "Very slow: expect seconds per tap.";
  return `${base}${shaky ? " The delay swings a lot between round trips." : ""}${lossPart}`;
}

/** "32 MB in 2.4 s" — the size and time a throughput figure was measured over. */
export function throughputBasis(bytes: number, ms: number): string {
  const mb = bytes / (1024 * 1024);
  const size = mb >= 1 ? `${mb >= 10 ? mb.toFixed(0) : mb.toFixed(1)} MB` : `${Math.round(bytes / 1024)} kB`;
  const t = ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`;
  return `${size} in ${t}`;
}
