import { idbClearWhere, idbGetAll, idbSet } from "../idb";
import { KEEP_MIN, blankMinute, median, type LinkMinute, type TrafficVia } from "./linkSeries";

/**
 * The minute rows, on disk (`linkSeries.ts` is what they mean).
 *
 * **IndexedDB, never localStorage**: that is shared with the send outbox, and
 * `linkTypes.ts` says why a telemetry buffer must not be able to cost a prompt.
 * One key per minute, so a write is one small row and a reload never has to read
 * anything back first. It can drop the part of a minute written before a reload
 * in that same minute, which is less than the rounding on these charts.
 *
 * **It wakes nothing up.** No timer: the row rolls when something is noted, and
 * is written when the minute turns or the page goes out of sight. A note is an
 * integer add, because `noteTraffic` runs on every PTY frame.
 */

const STORE = "linkseries";

let cur: LinkMinute | null = null;
let pings: number[] = [];
let held = 0;
let route: "lan" | "tailnet" | undefined;
let wired = false;
let pruned = false;

function seal(r: LinkMinute): LinkMinute {
  const m = median(pings);
  return m == null ? r : { ...r, med: Math.round(m), worst: Math.round(Math.max(...pings)) };
}

function write(r: LinkMinute): void {
  void idbSet(STORE, String(r.t), seal(r));
  if (pruned) return;
  pruned = true;
  const cutoff = r.t - KEEP_MIN;
  void idbClearWhere(STORE, (k) => Number(k) < cutoff);
}

export function flushLinkSeries(): void { if (cur) write(cur); }

function wire(): void {
  wired = true;
  try {
    window.addEventListener("pagehide", flushLinkSeries);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") flushLinkSeries();
    });
  } catch { /* no DOM */ }
}

function row(): LinkMinute {
  const t = Math.floor(Date.now() / 60_000);
  if (cur && cur.t === t) return cur;
  if (!wired) wire();
  if (cur) write(cur);
  pings = [];
  cur = blankMinute(t, held, route);
  return cur;
}

/** A probe's outcome. `ms` null with a socket up is a miss; `open` false is no socket at all. */
export function seriesProbe(ms: number | null, open: boolean): void {
  const r = row();
  if (!open) r.off++;
  else if (ms == null) r.miss++;
  else { r.ok++; pings.push(ms); }
}

export function seriesBytes(dir: "up" | "down", via: TrafficVia, n: number): void {
  const r = row();
  if (dir === "up") { if (via === "socket") r.us += n; else r.ur += n; return; }
  if (via === "socket") r.ds += n; else if (via === "request") r.dr += n; else r.dp += n;
}

export function seriesHeld(n: number): void {
  held = n;
  const r = row();
  r.out = Math.max(r.out, n);
}

export function seriesSent(waitMs: number): void {
  const r = row();
  r.sent++;
  r.wait = Math.max(r.wait, Math.round(waitMs));
}

export function seriesGaveUp(): void { row().fail++; }

export function seriesRoute(next: "lan" | "tailnet" | undefined): void {
  route = next;
  if (cur && next) cur.rt = next;
}

/** Everything kept, the minute in progress included. */
export async function readLinkSeries(): Promise<LinkMinute[]> {
  const rows = await idbGetAll<LinkMinute>(STORE);
  if (!cur) return rows;
  const open = seal(cur);
  return [...rows.filter((r) => r.t !== open.t), open];
}
