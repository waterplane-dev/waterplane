/**
 * `api.screen` — the host's own reading of a session's screen, so a plugin stops copying regexes
 * over raw bytes: the LIVE grid (`sessions.liveGrid`, the recorder's VT — synchronous, no replay)
 * as rows, plus `squash` (`echo.ts`: whitespace gone, lower-cased), the form every host match uses.
 * An unknown session is null. An empty grid is an empty list, which a caller reads as "unknown".
 */
import { squash } from "../../echo.js";

export interface ScreenSessions {
  get(id: string): unknown;
  liveGrid(id: string): string;
}

export interface PluginScreen {
  rows(lines?: number): string[];
  squashed(lines?: number): string;
}

const MAX_LINES = 500;

export function screenOf(sessions: ScreenSessions, sessionId: string): PluginScreen | null {
  if (typeof sessionId !== "string" || !sessions.get(sessionId)) return null;
  const rows = (lines = 40): string[] => {
    const all = sessions.liveGrid(sessionId).replace(/\r/g, "").split("\n").map((r) => r.replace(/\s+$/, ""));
    while (all.length && all[all.length - 1] === "") all.pop();
    const n = Math.max(1, Math.min(MAX_LINES, Math.floor(Number(lines)) || 40));
    return all.slice(-n);
  };
  return { rows, squashed: (lines) => squash(rows(lines).join("\n")) };
}
