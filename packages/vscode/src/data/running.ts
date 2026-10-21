/**
 * Is a prompt still running, and how old is a log — the pure words both the extension and the
 * webview print, so the two never disagree.
 *
 * The heuristic is a claim about the present from a file, so it degrades to ABSENT: a turn counts
 * as running only when the log ENDS mid-turn (`TurnCost.open`: an unanswered prompt, or a reply
 * whose `stop_reason` is `tool_use` / still null — see `turns.ts`) AND the log was written in the
 * last `RUNNING_FRESH_MS`. A session killed mid-turn, or interrupted, stops being "running" ten
 * minutes after its last write; a long tool call with nothing written for longer than that is
 * called not running, which is the cheaper mistake than a stuck "running" marker.
 * Pure: imported by the data layer and the webview alike.
 */
import { fmtUsd } from "@waterplane/shared";
import type { SessionSummary, TurnCost } from "../protocol.js";

/** A log written this recently with an open last turn is running. */
export const RUNNING_FRESH_MS = 10 * 60_000;
/** A log written this recently is "live" even between turns (the user is at the keyboard). */
export const LIVE_MS = 2 * 60_000;
/** A log written this recently counts as "recent": the session is likely still the thing being worked on. */
export const RECENT_MS = 30 * 60_000;

/** The log ends mid-turn and was written recently. `mtime` is the log's last write, `now` the reader's clock. */
export const isRunning = (open: boolean, mtime: number, now: number): boolean => open && mtime > 0 && now - mtime < RUNNING_FRESH_MS;

/** The running turn, or null. */
export function runningTurn(turns: TurnCost[], mtime: number, now: number): TurnCost | null {
  const last = turns[turns.length - 1];
  return last && isRunning(last.open === true, mtime, now) ? last : null;
}

/** Written in the last two minutes, or a prompt is running. */
export const isLive = (mtime: number, running: boolean, now: number): boolean => running || (mtime > 0 && now - mtime < LIVE_MS);

/** Written in the last `RECENT_MS`. */
export const isRecent = (mtime: number, now: number): boolean => mtime > 0 && now - mtime < RECENT_MS;

/**
 * Is anything being worked on right now: some row written in the last `RECENT_MS` (a running turn
 * is always that: `RUNNING_FRESH_MS` is the shorter). The ONE predicate behind tree order, the
 * Sessions collapse default, the panel's default view and the status bar's mode.
 */
export const anyLive = (rows: readonly Pick<SessionSummary, "mtime">[], now: number): boolean =>
  rows.some((r) => isRecent(r.mtime, now));

/** "42s", "1m 20s", "1h 05m". */
export function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

/** "just now", "2 min ago", "3 h ago", "2 d ago". */
export function fmtAge(ms: number): string {
  const m = Math.floor(Math.max(0, ms) / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  if (m < 48 * 60) return `${Math.floor(m / 60)} h ago`;
  return `${Math.floor(m / 1440)} d ago`;
}

/**
 * "running · $0.42 so far · 7 requests · 1m 20s". Before the first reply there is no cost to
 * state ("waiting for the first reply", never $0); an unpriced model has requests but no dollars.
 * `at` of 0 (undated) drops the clock.
 */
export function runningWords(t: Pick<TurnCost, "costUsd" | "requests" | "at">, now: number): string {
  const parts = ["running"];
  if (t.requests === 0) parts.push("waiting for the first reply");
  else {
    parts.push(t.costUsd != null && t.costUsd > 0 ? `${fmtUsd(t.costUsd)} so far` : "no dollar figure");
    parts.push(`${t.requests} ${t.requests === 1 ? "request" : "requests"}`);
  }
  if (t.at > 0) parts.push(fmtElapsed(now - t.at));
  return parts.join(" · ");
}
