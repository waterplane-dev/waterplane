/**
 * Agent readings: what only this desktop can measure about a repo, because it
 * keeps every claude conversation that ran in it (`GET /api/repos/:id/agentreadings`,
 * host `agentreadings.ts`). Four readings, one row per ISO week (Monday, the
 * host's local day), oldest first:
 *
 *  - `explore` — how many input-side tokens a FRESH session spends before its
 *    first file edit: how navigable the repo is for an agent. Lower is better.
 *  - `rework`  — the share of the week's tokens spent in sessions whose work
 *    was repairing earlier work, beside feature and UNKNOWN (never folded into
 *    feature).
 *  - `compact` — compactions per session that ran a successful `git commit`:
 *    context pressure on work that finished.
 *  - `escaped` — crash-triage marks and backlog items marked as a bug.
 *
 * READINGS, not index entries: nothing here is judged, ranked or coloured, and
 * nothing applies itself. Every reading is ABSENT with the sentence why rather
 * than a zero where it cannot be taken (no session that week, no ledger) —
 * `{ absent }`. A total always travels with its split (`TokenTotals`).
 */
import type { TokenTotals } from "./telemetry.js";

/** A reading that could not be taken this week, and why — never a zero. */
export interface AgentReadingAbsent {
  absent: string;
}

export interface AgentExploreReading {
  /** Fresh sessions this week that reached an edit (the median is over these). */
  sessions: number;
  /** Fresh sessions this week that never edited a file — not in the median, counted here. */
  noEdit: number;
  /** Sessions left out: resumed or forked logs, and headless `claude -p` runs. */
  skipped: number;
  /** Input + cache read + cache write before the first edit, of the median session
   *  (the lower middle one when the count is even, so the split below is a real session's). */
  medianTok: number;
  /** That same session's split: output is zero by construction (input-side only). */
  split: TokenTotals;
  /** Requests that session made before its first edit. */
  medianRequests: number;
}

/** Which bucket a session's tokens were filed under. */
export type ReworkClass = "rework" | "feature" | "unknown";

export interface AgentReworkReading {
  /** Every token of the week's sessions (all four kinds), the denominator. */
  totalTok: number;
  /** The week's tokens per class, each with its kind split. */
  byClass: Record<ReworkClass, TokenTotals>;
  /** Conversations per class that spent tokens this week. */
  sessions: Record<ReworkClass, number>;
  /** Review-repair workflow runs found this week (their agents are rework). */
  repairRuns: number;
}

export interface AgentCompactReading {
  /** Sessions that ended this week having run a `git commit` that did not error. */
  committed: number;
  /** Compactions in those sessions. */
  compactions: number;
  /** Every session that ended this week, and their compactions — the split around the ratio. */
  sessionsAll: number;
  compactionsAll: number;
}

export interface AgentEscapedReading {
  /** Crash groups a person or agent marked this week (`<name>.triage.json`), or why there is no count. */
  crashMarks: number | AgentReadingAbsent;
  /** Backlog items with category `bug` created this week that are still on the backlog. */
  bugItems: number | AgentReadingAbsent;
}

export interface AgentReadingsWeek {
  /** ISO week, its Monday as `YYYY-MM-DD` (host local day). */
  week: string;
  explore: AgentExploreReading | AgentReadingAbsent;
  rework: AgentReworkReading | AgentReadingAbsent;
  compact: AgentCompactReading | AgentReadingAbsent;
  escaped: AgentEscapedReading;
}

/** The rule each reading follows, worded by the host that applied it — the region's `?` quotes these. */
export interface AgentReadingRules {
  explore: string;
  rework: string;
  compact: string;
  escaped: string;
}

export interface AgentReadingsDoc {
  ok: true;
  /** The repo the logs were filed under (worktrees folded in). */
  repo: string;
  /** Oldest first, at most `AGENT_READING_WEEKS`, ending with the current week. */
  weeks: AgentReadingsWeek[];
  rules: AgentReadingRules;
  /** When the logs were last swept, and how many of this repo's were read again that sweep. */
  scannedAt: number;
  logs: number;
  reread: number;
}

/** `pending`: the first sweep of this repo's logs is still running (it carries on after the answer); ask again. */
export type AgentReadingsResponse = AgentReadingsDoc | { ok: false; error: string; pending?: true };

/** How many weeks the route answers. */
export const AGENT_READING_WEEKS = 12;

/** True when the reading is the absent sentence rather than a value. */
export function isAgentAbsent(x: unknown): x is AgentReadingAbsent {
  return typeof x === "object" && x !== null && typeof (x as AgentReadingAbsent).absent === "string";
}
