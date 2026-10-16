import { LS, lsBool, lsSetBool } from "../storage";
import type { LinkStatus, PulseSample } from "./linkTypes";
import { noteLinkStatus, status } from "./linkStatus";
import { emit, invalidate } from "./linkBus";

/**
 * Round-trip time, sampled continuously and kept as a short rolling window so it
 * can be DRAWN.
 *
 * The `log` section already prices every heartbeat pong, but it is a statistics
 * window: it answers "what has this link been like for the last day" in
 * percentiles, on a sheet you have to go and open. That is the wrong shape for
 * the question this exists for — "is it bad *right now*, and was it bad ten
 * seconds ago when my tap did nothing?". Percentiles cannot answer that, and
 * neither can a single number: 250 ms steady and 30 ms with a dropped ping every
 * fourth try read identically as a mean, and feel nothing alike. A short series
 * with the misses drawn in is the smallest honest answer, which is why Tailscale
 * draws one too, and why this is a graph rather than a label.
 *
 * Three rules worth keeping:
 *
 *  • **It observes, it never steers.** A missed probe is drawn and nothing else:
 *    it does not force a reconnect, does not tear the socket down, does not
 *    touch the heartbeat's own liveness verdict. `ws.ts` owns when the socket is
 *    dead, and a display feature that could change that would make the bar's
 *    presence alter the behaviour it claims to be reporting.
 *
 *  • **Probe samples do NOT feed the `log` reservoir.** They are the same
 *    measurement, so it is tempting — but `rttP95()` sizes the send queue's
 *    receipt deadlines, and probing four times a minute rather than five times a
 *    minute would silently change how long a prompt waits before it is retried,
 *    as a side effect of a bar being switched on. A readout must not move the
 *    machinery. Consolidating the two populations into one store did not
 *    consolidate the populations: `noteRtt` (heartbeat, from `ws.ts`) and
 *    `push()` (probe, below) stay separate arrays, and nothing crosses.
 *
 *  • **Only while the page is visible.** The probe is an extra frame on the
 *    user's radio; a backgrounded phone must not pay for a graph nobody is
 *    looking at. A hidden stretch simply leaves no samples — the window is "the
 *    last N pings", never a time axis, and the strip says so.
 *
 * On by default (a new phone should see its link without hunting for a
 * switch), and per-device on purpose (see `shared/settings.ts`): whether
 * you want a permanent latency graph, and whether you want to spend the radio on
 * one, is a statement about the phone in your hand, not about you.
 */

/** How many probes the window keeps. At `PROBE_MS` this is a few minutes —
 *  long enough to cover "it was fine when I tapped", short enough that a bad
 *  stretch from before you moved rooms isn't still on screen. */
export const PULSE_CAP = 90;
/** Probe cadence while the page is visible. */
const PROBE_MS = 3000;
/** A probe with no answer in this long counts as a miss and is drawn as one.
 *  Deliberately well above any sane round trip and well under `PROBE_MS × 2`,
 *  so a miss lands in its own slot rather than swallowing the next probe. */
const PROBE_TIMEOUT_MS = 2500;

/** Anything that can be probed. Structural on purpose: this module has no
 *  business importing `ws.ts`, which imports half the app's transport. */
export interface PulseSource {
  status: LinkStatus;
  probe(timeoutMs: number): Promise<number | null>;
}

export let pulseOn = lsBool(LS.netPulse, true);
export let samples: PulseSample[] = [];

export function pulseEnabled(): boolean { return pulseOn; }

/** Flip the strip on/off. Persists immediately — the toggle is per device, so
 *  there is no push to wait for. */
export function setPulseEnabled(on: boolean): void {
  pulseOn = on;
  lsSetBool(LS.netPulse, on);
  // Turning it off drops the window rather than freezing it: the next time it
  // comes on, stale samples drawn as if they were current would be a lie about
  // a link nobody was measuring.
  if (!on) samples = [];
  invalidate("pulse");
  emit();
}

function push(s: PulseSample): void {
  samples.push(s);
  if (samples.length > PULSE_CAP) samples.splice(0, samples.length - PULSE_CAP);
  invalidate("pulse");
  emit();
}

let probeTimer: number | null = null;
let probeInFlight = false;
let probeSource: PulseSource | null = null;

/**
 * Start the probe loop. Idempotent; safe to call before the socket exists.
 *
 * The loop runs only while the bar is on AND the page is visible. It re-reads
 * the socket's status every tick rather than subscribing to it, because the
 * thing being drawn is a sample per tick either way: an interval with no socket
 * to probe over is exactly as much of a data point as one that timed out.
 */
export function startLinkProbes(src: PulseSource): void {
  probeSource = src;
  if (probeTimer != null) return;
  probeTimer = window.setInterval(probeTick, PROBE_MS);
  document.addEventListener("visibilitychange", () => {
    // Coming back to the foreground: take one immediately rather than making the
    // user look at a stale window for three seconds.
    if (document.visibilityState === "visible") void probeTick();
  });
}

async function probeTick(): Promise<void> {
  if (!pulseOn || !probeSource) return;
  if (document.visibilityState !== "visible") return;
  if (probeInFlight) return;            // a probe that outlived its slot; the timeout will land it
  // The source is the transport itself, so this doubles as the belt-and-braces
  // path for a status edge that never reached `noteLinkStatus`.
  noteLinkStatus(probeSource.status);
  if (status !== "open") { push({ at: Date.now(), ms: null }); return; }
  probeInFlight = true;
  try {
    push({ at: Date.now(), ms: await probeSource.probe(PROBE_TIMEOUT_MS) });
  } catch {
    push({ at: Date.now(), ms: null });
  } finally {
    probeInFlight = false;
  }
}

/** What the strip renders: the numbers, already reduced. Pure, so the drawing
 *  code stays a projection of it. */
export interface PulseSummary {
  /** Newest successful round trip, if the newest sample was one. */
  last: number | null;
  /** Median of the successful samples in the window. */
  median: number | null;
  /** Probes in the window that got no answer. */
  misses: number;
  /** Y-axis ceiling for the graph, with a floor so a good link stays flat
   *  instead of magnifying 8 ms of jitter into a mountain range. */
  ceiling: number;
}

export function summarize(list: readonly PulseSample[], floorMs = 200): PulseSummary {
  const good = list.filter((s) => s.ms != null).map((s) => s.ms as number);
  const sorted = [...good].sort((a, b) => a - b);
  const median = sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : null;
  const peak = sorted.length ? sorted[sorted.length - 1] : 0;
  const newest = list.length ? list[list.length - 1] : null;
  return {
    last: newest && newest.ms != null ? newest.ms : null,
    median,
    misses: list.length - good.length,
    ceiling: Math.max(floorMs, peak),
  };
}
