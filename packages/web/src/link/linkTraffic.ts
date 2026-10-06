import type { LinkTraffic } from "./linkTypes";
import { doc, persist } from "./linkDoc";

/**
 * The two rates right now, and the two totals since the counter was last reset.
 *
 * Everything else in this file reports the link's *quality*: the pulse draws
 * round trips, the log keeps percentiles and delivery outcomes, the ops ledger
 * says something is in flight. None of them answers the question a metered SIM
 * asks, which is "what has this app cost me?", and none of them distinguishes a
 * link that is idle from one that is saturated — a 227 ms ping reads the same
 * while a 20 MB APK is coming down as it does on an empty socket, and the first
 * is why the second tap felt slow.
 *
 * Three things worth keeping:
 *
 *  • **It is measured by patching the transports, not by asking call sites.**
 *    Same reason as `hostUrl`, `settings` and `hints`: a helper everyone must
 *    remember to call is a helper that is wrong within a month, and the failure
 *    is silent — an under-count looks exactly like a quiet link. `fetch`, `XHR`
 *    and the WebSocket are how this app's own code moves bytes, so those three
 *    are wrapped; everything the BROWSER fetches on its behalf — every `<img>`
 *    in the gallery, which is most of what actually comes down — is picked up
 *    from Resource Timing, because there is no call site there to wrap.
 *
 *  • **What it counts is stated, not implied.** Requests are counted from
 *    `content-length` (the compressed size when the host gzipped it, i.e. real
 *    wire bytes; the host sets the header on every response path and exposes it
 *    through CORS, so the Android shell sees it too), page loads from what
 *    Resource Timing says came off the network — so a thumbnail served from the
 *    on-device cache costs nothing, which is right. The socket is counted as the
 *    JSON payload *before* permessage-deflate, so it over-states a chatty PTY
 *    stream. None of it includes headers, TLS or the Background Fetch download
 *    path, which the service worker performs outside the page. It is a usage
 *    readout, not an accounting ledger, and the health sheet says so.
 *
 *  • **Counting is an integer add.** A busy PTY session is thousands of frames
 *    a minute; anything per-frame that allocates, encodes or re-renders would
 *    make the readout itself a cost. Samples land in half-second buckets,
 *    `noteTraffic` emits NOTHING, and subscribers see the rate move on the
 *    once-a-second clock.
 */

export type TrafficDir = "up" | "down";

/** Buckets the rate is averaged over, and their width. Five seconds is long
 *  enough that a chunked download reads as one steady figure rather than
 *  flickering between 0 and a burst, and short enough that stopping a transfer
 *  shows up while you are still looking at the bar. */
const BUCKET_MS = 500;
const BUCKETS = 10;
const RATE_WINDOW_MS = BUCKET_MS * BUCKETS;

/** Ring of {slot, up, down}: `slot` is the epoch half-second the bucket holds,
 *  so a bucket from a minute ago is recognised as stale by its own index rather
 *  than having to be swept. */
export const buckets = Array.from({ length: BUCKETS }, () => ({ slot: -1, up: 0, down: 0 }));
const startedAt = Date.now();

/**
 * Record bytes. The one entry point, called from the transport patches below
 * and from `ws.ts` for socket frames.
 *
 * Deliberately tolerant: a transport that cannot say how much it moved passes
 * nothing rather than a guess, and a NaN from a malformed header must not turn
 * a total into `NaN` for the rest of the session.
 */
export function noteTraffic(dir: TrafficDir, bytes: number): void {
  if (!Number.isFinite(bytes) || bytes <= 0) return;
  const n = Math.round(bytes);
  if (dir === "up") doc.traffic.up += n; else doc.traffic.down += n;
  const slot = Math.floor(Date.now() / BUCKET_MS);
  const b = buckets[slot % BUCKETS];
  if (b.slot !== slot) { b.slot = slot; b.up = 0; b.down = 0; }
  if (dir === "up") b.up += n; else b.down += n;
  persist();
}

/** The two rates, from the buckets inside the window. Pure apart from the
 *  clock, so the drawing code stays a projection of it. */
function rates(now: number): { up: number; down: number } {
  const newest = Math.floor(now / BUCKET_MS);
  const oldest = newest - (BUCKETS - 1);
  let up = 0;
  let down = 0;
  for (const b of buckets) {
    if (b.slot < oldest || b.slot > newest) continue;
    up += b.up;
    down += b.down;
  }
  // Divide by the window actually covered: a phone one second into its session
  // has no five seconds of history, and reporting a fifth of the real rate for
  // the first few seconds of a download is the wrong kind of wrong.
  const span = Math.max(1000, Math.min(RATE_WINDOW_MS, now - startedAt));
  return { up: (up * 1000) / span, down: (down * 1000) / span };
}

export function trafficSnapshot(): LinkTraffic {
  const now = Date.now();
  const r = rates(now);
  return { since: doc.traffic.since, up: doc.traffic.up, down: doc.traffic.down, upRate: r.up, downRate: r.down };
}

/** Bytes as a total: goes all the way to GB, because on a phone left running
 *  for a week these do. */
export function fmtTotal(n: number): string {
  if (n < 1024) return `${Math.round(n)} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} kB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** Bytes per second. Anything under a kilobyte a second is drawn as idle: a
 *  heartbeat every fifteen seconds is not a transfer, and a bar that never
 *  reads zero cannot say "nothing is happening". */
export function fmtRate(bps: number): string | null {
  if (!Number.isFinite(bps) || bps < 1024) return null;
  if (bps < 1024 * 1024) return `${Math.round(bps / 1024)} kB/s`;
  return `${(bps / 1024 / 1024).toFixed(1)} MB/s`;
}
