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
import { BRAND } from "../brand.js";
import type { TokenTotals } from "./telemetry.js";
import type { SeriesLoadsValue, SeriesValue } from "../agentseries/types.js";
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
  /** Median chars per part over the same sessions, in `START_PARTS` order (a part the list does not name last); a part no session measured is not listed. Grouped by `startGroupOf`. */
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
  /** Mean skill loads per fresh session and the share that loaded one, in the week it started (`SeriesLoads`; never a median). Absent FIELD on an older host — one that sent `skills` as a median, which this app version no longer reads; absent READING when logs cannot say. */
  skillLoads?: SeriesLoadsValue;
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
  skills?: string;
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

/**
 * What the first request carried, by part. OPEN: a key is a string, so another backend's reader can
 * name its own parts and an older phone shows a part it cannot name as such (never drops it). The
 * ids this app version names are `START_PARTS`'.
 */
export type StartPart = string;

/**
 * Whose a part is — what makes start context comparable between two people on one repo:
 * `repo` is committed to the repo, so the same for everyone on it by construction; `yours` is this
 * person's own setup on this desktop; `cli` moves with the CLI version and model, not with anyone's
 * setup; `mixed` is a part the log does not split by source, said so in `START_GROUPS`, never guessed.
 */
export type StartGroup = "repo" | "yours" | "cli" | "mixed";

/** The groups in display order, each with its heading and the sentence a person reads under it. */
export const START_GROUPS: readonly { id: StartGroup; label: string; note: string }[] = [
  { id: "repo", label: "the repo's", note: "Instruction files the log types Project: normally committed to the repo, so the same for everyone who works on it. The log records the type, not the folder, so a CLAUDE.md in a parent folder of the repo is counted here too." },
  { id: "yours", label: "yours", note: "Your own setup on this desktop: global and local instruction files, memory and connector tools." },
  { id: "cli", label: "the CLI's", note: "The CLI's own, moving with its version and the model, the same for everyone on the same version." },
  { id: "mixed", label: "not split", note: "The log records each of these as one block without saying which file or setting each line came from, so the repo's and yours are counted together here." },
];

/**
 * The parts in display order, with the label a person reads (the per-session "what every turn
 * carries" list's names, `alwaysonwords.ts` `carriedLabel`, cut further by source where the log
 * says it) and the group it belongs to.
 *  - Instruction files split by the file `type` the log records: `Project` is the repo's
 *    (`projectMd`), `User`, `Local` and a managed policy file are yours (`userMd`), `AutoMem` is the
 *    memory index; a file type this list does not know goes to `other`.
 *  - Deferred tool names split by name: an `mcp__` tool is a connector's (`connectorTools`, a repo's
 *    `.mcp.json` server lands here too: the name does not say who configured it), the rest are the
 *    CLI's (`cliDeferred`).
 *  - The subagent listing splits by the log's own `builtInTypes`: the CLI's built-in agents
 *    (`cliAgents`) and the rest (`otherAgents`: the repo's, yours and plugins', not split). A record
 *    without `builtInTypes` cannot be split and stays whole as `agents`.
 *  - `claudeMd`, `deferredTools` and `agents` whole are what an older host sent: `mixed`.
 */
export const START_PARTS: readonly { id: StartPart; label: string; group: StartGroup }[] = [
  { id: "projectMd", label: "CLAUDE.md, project", group: "repo" },
  { id: "userMd", label: "CLAUDE.md, global and local", group: "yours" },
  { id: "memory", label: "instruction files: auto-memory", group: "yours" },
  { id: "connectorTools", label: "connector tool names (MCP)", group: "yours" },
  { id: "system", label: "system prompt", group: "cli" },
  { id: "tools", label: "tool schemas", group: "cli" },
  { id: "cliDeferred", label: "deferred tool names, built in", group: "cli" },
  { id: "cliAgents", label: "subagent listing, built in", group: "cli" },
  { id: "claudeMd", label: "instruction files: CLAUDE.md (project and yours, from an older host)", group: "mixed" },
  { id: "skills", label: "skill listing (the repo's and yours)", group: "mixed" },
  { id: "otherAgents", label: "subagent listing, not built in (the repo's, yours and plugins')", group: "mixed" },
  { id: "hooks", label: "hook context", group: "mixed" },
  { id: "session", label: "session context", group: "mixed" },
  { id: "other", label: "MCP instructions and other", group: "mixed" },
  // What an older host sent before the split: whole, so `mixed`, never relabelled as one side.
  { id: "deferredTools", label: "deferred tool names (built in and connectors, from an older host)", group: "mixed" },
  { id: "agents", label: "subagent listing, not split (no built-in list in the log, or an older host)", group: "mixed" },
];

/** The group of a part id; a part this app version cannot name is `mixed`, never assumed to be anyone's. */
export function startGroupOf(id: StartPart): StartGroup {
  return START_PARTS.find((p) => p.id === id)?.group ?? "mixed";
}

/** The parts of one group, in display order, out of a reading's list (same order as `START_PARTS`; unknown ids last in `mixed`). */
export function partsByGroup<T extends { id: StartPart }>(parts: readonly T[]): { group: (typeof START_GROUPS)[number]; parts: T[] }[] {
  return START_GROUPS.map((g) => ({ group: g, parts: parts.filter((p) => startGroupOf(p.id) === g.id) })).filter((x) => x.parts.length > 0);
}

/**
 * Where every agent reading comes from, in the ONE wording each card says once (R-metrics-069):
 * the phone's Agent readings region and the token-stats Agent readings over time card both quote it,
 * visibly and in their `?`. Never a badge per tile.
 */
export function agentSourceText(): string {
  return `From this desktop only: its own conversation logs, settings, memory, model and CLI version, so another desktop on the same repo reads differently. The health score and ${BRAND.displayName}'s readings are built only from checked-in git and read the same on every desktop.`;
}

/**
 * The same fact for an IMPORTED setup block (R-metrics-069, R-metrics-073): it names whose desktop
 * it came from, in the words `agentSourceText` uses for this one.
 */
export function shareSourceText(name: string, days: { from: string; to: string }): string {
  return `From ${name}'s desktop only, ${days.from} to ${days.to}: its own conversation logs, settings, memory, model and CLI version, as ${name} exported them. It is not built from git, and nothing in it is checked by this desktop.`;
}

/**
 * The same fact for ONE repo-declared reading that says `"backfill": false` (R-metrics-069): it
 * measures this desktop, not the commit. Said once on the tile's means line, never a badge.
 */
export function ownThisDesktopText(): string {
  return `Reads this desktop, not the commit: another desktop reads it differently, and it is not in the health score.`;
}

/** What a skill load is, in the sentence the weekly region's `?` and the token-stats card both quote. */
export const SKILLS_RULE_TEXT =
  "A skill load is one call of the Skill tool in a session's own log, the same count the Skills screen shows per skill (a streamed reply counted once). Per week: the mean loads per fresh session and the share of those sessions that loaded at least one (most sessions load none, so a median would read 0), in the week it started; forked and subagent logs are left out, and a log that cannot say has no count rather than a zero. A skill load is a measured thing, not a verdict: fewer loads after a trim can mean the skills were no longer needed or no longer found.";

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
  /** Characters per part of that start context (`START_PARTS` ids, open); a part never observed is absent. */
  parts?: Partial<Record<StartPart, number>>;
  /** Read-only calls before the first edit; absent when the session never edited. */
  look?: number;
  /** Skill calls the session made (the skills screen's own parser); absent when the log cannot say, never 0 for that. */
  skills?: number;
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
  /** The repo as two people on it both know it, for the setup block (R-metrics-073): the origin
   *  remote's name and a hash of its normalised URL, never a path. Repo route only; ABSENT on an
   *  older host or the all-repos route, `null` when the repo has no remote another machine shares. */
  share?: { name: string; key: string } | null;
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
