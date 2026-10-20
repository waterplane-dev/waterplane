import { lsJson, lsSetJson, LS } from "../storage.ts";

/**
 * "The desktop is restarting" — said, timed, and closed off.
 *
 * A restart (`npm run restart`, a crash, launchd) used to read as a tunnel
 * blip: the pulse graph is the last N pings, not a time axis, so half a minute
 * with no host left a strip that looked uninterrupted while every tap went
 * nowhere — and nothing said how long to wait, or whether it was broken.
 *
 * Three edges, each from the one place that knows it:
 *  - `host.restarting` (the host's SIGTERM handler): it SAID it is going.
 *  - the socket dropping (`noteLinkStatus`): the clock starts here if it did not say.
 *  - `welcome` with a different `bootId` than the last one this phone saw from
 *    that host: it is back. Same bootId ⇒ it was only the link.
 *
 * Times are this phone's clock throughout (receipt times), so host clock skew
 * never enters a duration. `usualMs` is the last restart's wait, remembered per
 * host, so the next one can say "usually ~30 s" and call a long one long.
 */

export interface RestartView {
  /** Waiting on a restart the host announced; epoch ms it started. */
  since?: number;
  /** Why, as the restarting caller told the host (`host.restarting.reason`); absent when nobody said. */
  reason?: string;
  /** The last restart's wait, if one was measured. */
  usualMs?: number;
  /** Just back: when, after how long, and whether it had announced itself. */
  back?: { at: number; downMs?: number; announced: boolean; reattachMs?: number; reason?: string };
}

/** How long the "back after …" line stays on the strip. */
export const BACK_SHOWN_MS = 120_000;
/** Past this multiple of the usual wait (or 2 min with no usual), say it is long. */
export const SLOW_FACTOR = 3;
const SLOW_DEFAULT_MS = 120_000;

type Boots = Record<string, { bootId: string; usualMs?: number }>;

let view: RestartView = {};
let downAt: number | null = null;
let hostKey = "default";
const subs = new Set<() => void>();

function set(next: RestartView): void { view = next; for (const f of subs) f(); }
export function subscribeRestart(f: () => void): () => void { subs.add(f); return () => { subs.delete(f); }; }
export function restartView(): RestartView { return view; }

export function noteHostRestarting(now = Date.now(), reason?: string): void {
  const usualMs = lsJson<Boots>(LS.hostBoots, {})[hostKey]?.usualMs;
  set({ since: now, usualMs, ...(reason ? { reason } : {}) });
}

export function noteSocketDown(now = Date.now()): void {
  if (downAt == null) downAt = now;
}

export function noteHostWelcome(
  msg: { bootId: string; hostId?: string; startedAt?: number; readyAt?: number },
  now = Date.now(),
): { downMs?: number; announced: boolean } | null {
  hostKey = msg.hostId ?? "default";
  const boots = lsJson<Boots>(LS.hostBoots, {});
  const prev = boots[hostKey];
  const start = view.since ?? downAt ?? undefined;
  const announced = view.since != null;
  downAt = null;
  if (!prev || prev.bootId === msg.bootId) {
    if (!prev) { boots[hostKey] = { bootId: msg.bootId }; lsSetJson(LS.hostBoots, boots); }
    if (view.since != null) set({});
    return null;
  }
  // Neither the announcement nor the drop was seen (the page loaded after
  // it): a restart happened, but nothing about it is known — say nothing
  // rather than call it a crash.
  if (start == null) {
    boots[hostKey] = { ...prev, bootId: msg.bootId };
    lsSetJson(LS.hostBoots, boots);
    return null;
  }
  const downMs = Math.max(0, now - start);
  const reattachMs = msg.startedAt != null && msg.readyAt != null ? Math.max(0, msg.readyAt - msg.startedAt) : undefined;
  boots[hostKey] = { bootId: msg.bootId, usualMs: downMs };
  lsSetJson(LS.hostBoots, boots);
  set({ back: { at: now, downMs, announced, reattachMs, ...(view.reason ? { reason: view.reason } : {}) } });
  return { downMs, announced };
}

export function fmtSecs(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 90 ? `${s} s` : `${Math.round(s / 60)} min`;
}

/** The strip's words for `v` at `now`, or null when there is nothing to say. */
export function restartLine(v: RestartView, now: number): { text: string; slow: boolean } | null {
  if (v.since != null) {
    const waited = now - v.since;
    const usual = v.usualMs != null ? ` · usually ~${fmtSecs(v.usualMs)}` : "";
    const slow = waited > (v.usualMs != null ? v.usualMs * SLOW_FACTOR : SLOW_DEFAULT_MS);
    const why = v.reason ? ` (${v.reason})` : "";
    return {
      text: slow
        ? `desktop restarting${why} ${fmtSecs(waited)} — longer than usual, it may have failed to start`
        : `desktop restarting${why} · ${fmtSecs(waited)}${usual}`,
      slow,
    };
  }
  if (v.back && now - v.back.at < BACK_SHOWN_MS) {
    const after = v.back.downMs != null ? ` after ${fmtSecs(v.back.downMs)}` : "";
    return {
      text: v.back.announced ? `desktop restarted${v.back.reason ? ` (${v.back.reason})` : ""} — back${after}` : `desktop restarted unannounced (crash?) — back${after}`,
      slow: !v.back.announced,
    };
  }
  return null;
}
