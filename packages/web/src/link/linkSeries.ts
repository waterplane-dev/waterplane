/**
 * The connection strip's readings over TIME: the pure half (`linkSeriesStore.ts`
 * keeps the rows, `NetHealthCharts.tsx` draws them).
 *
 * The strip shows a moment and the link store keeps a window of 90 pings plus
 * running totals, so "2.73 GB" and "offline" could not be asked the next
 * question: when, how long, on what. One row per minute answers all of them.
 *
 * **A missing row is a fact of its own.** Nothing is measured on a phone in a
 * pocket, so a minute with no row is NOT MEASURED: never zero, never offline,
 * and never bridged by a line. Every chart draws it as its own mark.
 *
 * **Binned medians are medians of the minute medians**, the one figure a row can
 * carry without keeping every ping. The chart's note says so.
 */

/** Where the bytes went. `page` is what the browser fetched for the page (mostly
 *  images), `request` this app's own HTTP, `socket` the one WebSocket. */
export type TrafficVia = "socket" | "request" | "page";

export interface LinkMinute {
  /** Epoch minute. */
  t: number;
  /** Probes answered / unanswered on an open socket / taken with no socket. */
  ok: number;
  miss: number;
  off: number;
  /** Over the answered probes; absent when none was. */
  med?: number;
  worst?: number;
  /** Bytes down, by `TrafficVia`. */
  ds: number;
  dr: number;
  dp: number;
  /** Bytes up. A page load uploads nothing. */
  us: number;
  ur: number;
  /** The route, once one is known. */
  rt?: "lan" | "tailnet";
  /** Most things held on this phone during the minute. */
  out: number;
  /** Sends confirmed, sends that gave up, longest queue wait (ms). */
  sent: number;
  fail: number;
  wait: number;
}

export function blankMinute(t: number, out = 0, rt?: "lan" | "tailnet"): LinkMinute {
  return { t, ok: 0, miss: 0, off: 0, ds: 0, dr: 0, dp: 0, us: 0, ur: 0, out, sent: 0, fail: 0, wait: 0, ...(rt ? { rt } : {}) };
}

export function median(list: readonly number[]): number | null {
  if (!list.length) return null;
  const s = [...list].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export type RangeId = "1h" | "24h" | "7d" | "30d";
export interface LinkRange { id: RangeId; spanMin: number; binMin: number }

export const RANGES: readonly LinkRange[] = [
  { id: "1h", spanMin: 60, binMin: 1 },
  { id: "24h", spanMin: 1440, binMin: 15 },
  { id: "7d", spanMin: 10_080, binMin: 120 },
  { id: "30d", spanMin: 43_200, binMin: 720 },
];

/** How long rows are kept: the longest range, no more. */
export const KEEP_MIN = 43_200;

export interface LinkBin {
  /** Epoch ms. */
  from: number;
  to: number;
  /** Minutes in this bin with a row. Zero is NOT MEASURED. */
  measured: number;
  ok: number;
  miss: number;
  off: number;
  med: number | null;
  worst: number | null;
  down: Record<TrafficVia, number>;
  up: { socket: number; request: number };
  lanMin: number;
  tailMin: number;
  out: number;
  sent: number;
  fail: number;
  wait: number;
}

export function binSeries(rows: readonly LinkMinute[], range: LinkRange, nowMs: number): LinkBin[] {
  const { spanMin, binMin } = range;
  const end = (Math.floor(nowMs / 60_000 / binMin) + 1) * binMin;
  const start = end - spanMin;
  const bins: LinkBin[] = [];
  const meds: number[][] = [];
  for (let m = start; m < end; m += binMin) {
    bins.push({
      from: m * 60_000, to: (m + binMin) * 60_000, measured: 0, ok: 0, miss: 0, off: 0, med: null, worst: null,
      down: { socket: 0, request: 0, page: 0 }, up: { socket: 0, request: 0 },
      lanMin: 0, tailMin: 0, out: 0, sent: 0, fail: 0, wait: 0,
    });
    meds.push([]);
  }
  for (const r of rows) {
    if (r.t < start || r.t >= end) continue;
    const i = Math.floor((r.t - start) / binMin);
    const b = bins[i];
    b.measured++;
    b.ok += r.ok; b.miss += r.miss; b.off += r.off;
    if (r.med != null) meds[i].push(r.med);
    if (r.worst != null) b.worst = Math.max(b.worst ?? 0, r.worst);
    b.down.socket += r.ds; b.down.request += r.dr; b.down.page += r.dp;
    b.up.socket += r.us; b.up.request += r.ur;
    if (r.rt === "lan") b.lanMin++; else if (r.rt === "tailnet") b.tailMin++;
    b.out = Math.max(b.out, r.out);
    b.sent += r.sent; b.fail += r.fail; b.wait = Math.max(b.wait, r.wait);
  }
  bins.forEach((b, i) => { b.med = median(meds[i]); });
  return bins;
}

export const binDown = (b: LinkBin): number => b.down.socket + b.down.request + b.down.page;
export const binUp = (b: LinkBin): number => b.up.socket + b.up.request;

export interface LinkSum {
  /** Minutes with a row. */
  measuredMin: number;
  probes: number;
  /** Probes that got no answer, socket up. */
  miss: number;
  /** Probes taken with no socket. */
  off: number;
  median: number | null;
  worst: number | null;
  down: Record<TrafficVia, number>;
  up: { socket: number; request: number };
  lanMin: number;
  tailMin: number;
  sent: number;
  fail: number;
  wait: number;
  mostHeld: number;
}

export function sumBins(bins: readonly LinkBin[]): LinkSum {
  const s: LinkSum = {
    measuredMin: 0, probes: 0, miss: 0, off: 0, median: null, worst: null,
    down: { socket: 0, request: 0, page: 0 }, up: { socket: 0, request: 0 },
    lanMin: 0, tailMin: 0, sent: 0, fail: 0, wait: 0, mostHeld: 0,
  };
  const meds: number[] = [];
  for (const b of bins) {
    s.measuredMin += b.measured;
    s.probes += b.ok + b.miss + b.off;
    s.miss += b.miss; s.off += b.off;
    if (b.med != null) meds.push(b.med);
    if (b.worst != null) s.worst = Math.max(s.worst ?? 0, b.worst);
    s.down.socket += b.down.socket; s.down.request += b.down.request; s.down.page += b.down.page;
    s.up.socket += b.up.socket; s.up.request += b.up.request;
    s.lanMin += b.lanMin; s.tailMin += b.tailMin;
    s.sent += b.sent; s.fail += b.fail; s.wait = Math.max(s.wait, b.wait);
    s.mostHeld = Math.max(s.mostHeld, b.out);
  }
  s.median = median(meds);
  return s;
}

/** Probe cadence (`linkPulse.ts`): what turns a count of no-socket probes into time. */
export const PROBE_SEC = 3;

export interface LinkDrop {
  /** Epoch ms: the first and last minute of the run. */
  from: number;
  to: number;
  /** Time seen with no socket. Time out of sight is not in it. */
  offSec: number;
}

/**
 * The stretches with no socket, newest first: runs of adjacent minutes holding a
 * no-socket probe. A minute out of sight ends a run, because nobody saw what
 * happened in it, so one drop is never stretched across a pocket.
 */
export function dropsOf(rows: readonly LinkMinute[]): LinkDrop[] {
  const out: LinkDrop[] = [];
  let first = -1;
  let last = -1;
  let off = 0;
  const close = () => {
    if (first >= 0) out.push({ from: first * 60_000, to: (last + 1) * 60_000, offSec: off * PROBE_SEC });
    first = -1;
    off = 0;
  };
  for (const r of [...rows].sort((a, b) => a.t - b.t)) {
    if (r.off === 0) { close(); continue; }
    if (first < 0 || last !== r.t - 1) { close(); first = r.t; }
    last = r.t;
    off += r.off;
  }
  close();
  return out.reverse();
}

export interface RouteChange { at: number; to: "lan" | "tailnet" }

/** Every move between the LAN and the tailnet, newest first. */
export function routeChanges(rows: readonly LinkMinute[]): RouteChange[] {
  const out: RouteChange[] = [];
  let prev: "lan" | "tailnet" | undefined;
  for (const r of [...rows].sort((a, b) => a.t - b.t)) {
    if (!r.rt) continue;
    if (prev && r.rt !== prev) out.push({ at: r.t * 60_000, to: r.rt });
    prev = r.rt;
  }
  return out.reverse();
}

/** A length of time, in the two units that matter at that size. */
export function spanText(sec: number): string {
  const s = Math.round(sec);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m}m ${s % 60}s` : `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** The y ceiling for the ping chart: the worst ping, so a chart with one awful
 *  minute keeps its shape only as far as the 200 ms floor says it should. */
export function pingCeiling(bins: readonly LinkBin[], floorMs = 200): number {
  const w = bins.map((b) => b.worst).filter((v): v is number => v != null).sort((a, b) => a - b);
  if (!w.length) return floorMs;
  return Math.max(floorMs, w[Math.min(w.length - 1, Math.floor((w.length - 1) * 0.95))]);
}

/** The share of a bin's probes that came back with nothing. */
export function lostShare(b: LinkBin): number {
  const n = b.ok + b.miss + b.off;
  return n ? (b.miss + b.off) / n : 0;
}
