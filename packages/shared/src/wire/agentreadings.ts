/**
 * Agent readings: what only this desktop can measure about a repo, because it
 * keeps every claude conversation that ran in it (`GET /api/repos/:id/agentreadings`,
 * host `agentreadings.ts`). Four readings, one row per ISO week (Monday, the
 * host's local day), oldest first:
 *
 *  - `start`   — what a fresh session's first request carried: median tokens,
 *    median chars per part, and the subagents' own start. MEASURED off the logs
 *    (never the skills screen's estimated weights; the two are never summed).
 *  - `explore` — "Before the first edit": input-side tokens AND look calls a
 *    fresh session spends before its first file edit, over one population.
 *  - `requests` — median requests of a fresh session that committed.
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
import type { SeriesValue } from "../agentseries/types.js";
import type { AgentMarker } from "../agentseries/types.js";

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
  /** Requests that session made before its first edit. Kept on the wire for older phones; not drawn
   *  (the look-call median says what it said, more tightly). */
  medianRequests: number;
  /** Median look calls before the first edit over the same sessions (`LOOK_RULE_TEXT`), the agent
   *  series' `look` reading. Absent FIELD on an older host. */
  looks?: SeriesValue;
}

/** What a fresh session's first request carried this week (agent series `start`, `parts`, `subStart`). */
export interface AgentStartReading {
  /** Fresh, non-subagent sessions that started this week (headless included). */
  fresh: number;
  /** Median first-request tokens (input + cache read + cache write), fresh interactive sessions. */
  tok: SeriesValue;
  /** Median chars per part over the same sessions, in `START_PARTS` order; a part no session measured is not listed. */
  parts: { id: StartPart; chars: SeriesValue }[];
  /** Median first-request tokens of the subagent logs that started this week. */
  sub: SeriesValue;
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

/**
 * What the week cost, off the token ledger's per-repo day rows (the same rows
 * the token-stats screen's *By repo* and the health score's context line read):
 * every request the repo's conversations made, subagents included.
 */
export interface AgentSpendReading {
  requests: number;
  /** Requests on a model with a list price: the denominator of a price per request. */
  pricedRequests: number;
  /** List-price dollars — a counterfactual off one dated table, never a bill. */
  usd: number;
  /** Input + cache read + cache write over `requests`: the context they sent. Absent on an older ledger. */
  ctxTok?: number;
}

/** Who did the week's work: the conversations and their subagents, off the same logs as `rework`. */
export interface AgentActivityReading {
  /** Conversations that spent tokens this week (a conversation over two weeks counts in both). */
  sessions: number;
  /** Of those, the ones that started this week. */
  started: number;
  /** Subagent logs that spent tokens this week. */
  agents: number;
  /** Tokens (all four kinds) in the conversations' own logs, and in their subagents' — the split of `rework.totalTok`. */
  mainTok: number;
  agentTok: number;
}

export interface AgentReadingsWeek {
  /** ISO week, its Monday as `YYYY-MM-DD` (host local day). */
  week: string;
  /** Absent FIELD on an older host; absent READING when the ledger has no row for the repo that week. */
  spend?: AgentSpendReading | AgentReadingAbsent;
  /** Absent FIELD on an older host. */
  activity?: AgentActivityReading | AgentReadingAbsent;
  /** Absent FIELD on an older host. */
  start?: AgentStartReading | AgentReadingAbsent;
  explore: AgentExploreReading | AgentReadingAbsent;
  /** Median requests of fresh sessions that committed, in the week they started. Absent FIELD on an older host. */
  requests?: SeriesValue;
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
  /** Absent on an older host. */
  spend?: string;
  activity?: string;
  start?: string;
  requests?: string;
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

// ── Session points ──────────────────────────────────────────────────────────
// One point per conversation (or subagent log): the raw material for scatter and
// distribution views, never an aggregate. Every field but the identity is
// optional where the log may not say: absent = not measured, never a zero.

/** What the first request carried, by part, in display order. Closed: a part not listed is `other`. */
export type StartPart = "system" | "tools" | "claudeMd" | "memory" | "skills" | "deferredTools" | "agents" | "hooks" | "session" | "other";

/**
 * The parts in display order, with the label a person reads — the SAME names the per-session
 * "what every turn carries" list uses (`alwaysonwords.ts` `carriedLabel`), so one part has one
 * name app-wide; `claudeMd` and `memory` are that list's "instruction files" cut by file type.
 */
export const START_PARTS: readonly { id: StartPart; label: string }[] = [
  { id: "system", label: "system prompt" },
  { id: "tools", label: "tool schemas" },
  { id: "claudeMd", label: "instruction files: CLAUDE.md" },
  { id: "memory", label: "instruction files: auto-memory" },
  { id: "skills", label: "skill listing" },
  { id: "deferredTools", label: "deferred tool names" },
  { id: "agents", label: "subagent listing" },
  { id: "hooks", label: "hook context" },
  { id: "session", label: "session context" },
  { id: "other", label: "MCP instructions and other" },
];

/** What counts as a look before the first edit, in a sentence the region's `?` quotes. */
export const LOOK_RULE_TEXT =
  "A look is a call that only reads: Read, Grep, Glob, LS or NotebookRead, or a shell command that starts with grep, rg, find, ls, cat, head, tail, sed -n, wc, jq, tree or git log, show, diff, grep, blame or status (a leading cd … && is ignored). Looks are counted up to the session's first file edit; a session that never edits has no count.";

export interface AgentPoint {
  /** The log's own id: the conversation's session id, or a subagent's path under it. */
  id: string;
  /** First record's time (ms). */
  t0: number;
  /** The repo the session ran in (worktrees folded in). */
  repo: string;
  /** Began as a new conversation: not a fork, a continuation or a headless run. */
  fresh: boolean;
  headless: boolean;
  /** A subagent's log. */
  sub?: boolean;
  /** Model of the first counted request, as logged. */
  model?: string;
  /** The CLI version that wrote the log. */
  cli?: string;
  /** Tokens the first request carried: input + cache read + cache write. */
  start?: number;
  /** Characters per part of that start context; a part never observed is absent. */
  parts?: Partial<Record<StartPart, number>>;
  /** Read-only calls before the first edit; absent when the session never edited. */
  look?: number;
  /** Counted requests (a streamed reply counted once). */
  req: number;
  /** A `git commit` succeeded in the session. Absent on a subagent (not read there). */
  commit?: boolean;
}

export interface AgentPointsDoc {
  ok: true;
  /** Newest first: at most `AGENT_POINTS_CAP` fresh conversations (a fork, a continuation or a headless run is no reading's session, so it is left off) and `AGENT_SUB_POINTS_CAP` subagent logs. */
  points: AgentPoint[];
  /** Points left off by the caps (the oldest of each kind), 0 when none. */
  cut: number;
  /** The repos asked about: one for a repo's route, every known one otherwise. */
  repos: string[];
  rules: { look: string };
  scannedAt: number;
  logs: number;
  reread: number;
}

export type AgentPointsResponse = AgentPointsDoc | { ok: false; error: string; pending?: true };

/** The window the points cover: the same weeks the readings do. */
export const AGENT_POINT_WEEKS = AGENT_READING_WEEKS;
/**
 * Caps, per kind. A point is ~300 bytes of JSON, so these keep a response near 1.5 MB, which a phone
 * parses without a stall. Subagent logs outnumber conversations ~5:1 on a busy repo (measured: 20,000
 * of 24,000 points in twelve weeks), so one shared cap would be all subagents of the last few days
 * and no conversation at all; each kind keeps its own newest.
 */
export const AGENT_POINTS_CAP = 3000;
export const AGENT_SUB_POINTS_CAP = 2000;

// ── Markers ─────────────────────────────────────────────────────────────────

/** What changed, drawn beside the readings (`GET /api/repos/:id/agentmarkers`). Markers say what changed, never whether it helped. */
export interface AgentMarkersDoc {
  ok: true;
  markers: AgentMarker[];
  /** One sentence per source that could not be read: a source missing here is unknown, not unchanged. */
  absent: string[];
}

export type AgentMarkersResponse = AgentMarkersDoc | { ok: false; error: string };
