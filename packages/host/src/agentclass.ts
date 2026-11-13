/**
 * Agent readings, the PURE half: how a conversation is classified, and how the
 * per-log summaries fold into one repo's weekly readings. No disk, no clock
 * (the caller passes `now`), so `packages/host/test/agentreadings.test.mjs`
 * pins every rule here on hand-built summaries. The disk half is
 * `agentscan.ts`; the store and the route's document `agentreadings.ts`.
 *
 * ── Rework classification (the rule the region's `?` quotes) ────────────────
 *
 * A conversation is REWORK when its first prompt (the person's own words, with
 * pasted blocks and command wrappers cut out) or its title says it is mending
 * something — the words in `REWORK_RE`. It is FEATURE only when the prompt
 * OPENS with a building verb (`FEATURE_RE`) and no rework word appears. Every
 * other conversation is UNKNOWN — never feature by default, because "the rest"
 * is mostly questions, reviews, plans and chores, and filing them as features
 * would make the rework share look small for no reason anyone measured.
 * The agents of a `review-repair` workflow run are rework whatever their
 * parent was; every other subagent is spent under its parent's class.
 *
 * ── What "fresh" means for exploration cost ─────────────────────────────────
 *
 * A log is FRESH when it began as a new conversation: not a fork (a copied
 * record still names another session in `session_id`/`sessionId`), not a
 * continuation (its first prompt is the CLI's "continued from a previous
 * conversation" summary) and not a headless `claude -p` run (`entrypoint`
 * `sdk-*`: the naming and review helpers, which never edit). A resume that
 * appends to the same log keeps the log's beginning, so its first edit is
 * still the session's first.
 */
import { carriedPartsOf } from "./ctxlog/ctxcursor.js";
import { LOOK_RULE_TEXT, SERIES_MIN_N, START_PARTS, isAgentAbsent, isoWeekOf, hourKey, seriesTooFewText, type AgentStartReading, type SeriesBucket, type SeriesValue, type AgentActivityReading, type AgentSpendReading, type RepoSpendWeek, type AgentCompactReading, type AgentEscapedReading, type AgentExploreReading,
  type AgentReadingAbsent, type AgentReadingRules, type AgentReadingsWeek, type StartPart, type AgentReworkReading, type ReworkClass,
  type TokenTotals } from "@waterplane/shared";

/** The four kinds + the 1-hour subset + requests, positional (as `tokenscan.ts`'s `Tally`). */
export type WeekTally = [input: number, output: number, cacheRead: number, cacheWrite: number, cacheWrite1h: number, requests: number];

/** One top-level conversation log, as `agentscan.ts` read it. */
export interface ConvSummary {
  /** mtime and size when read: together, "has this changed". */
  m: number;
  s: number;
  /** The worktree the conversation ran in (the records' own `cwd`). */
  w?: string;
  /** Why the log is not a fresh start; absent = fresh. */
  nf?: "fork" | "continued" | "headless";
  /** The class and the word that decided it (absent for unknown). */
  c: ReworkClass;
  cw?: string;
  /** First and last record timestamps (ms); absent when no record was dated. */
  t0?: number;
  t1?: number;
  /** Before the first Edit/Write/MultiEdit/NotebookEdit call: input, cache read, cache write, requests.
   *  Absent = the log never edited a file. */
  ex?: [input: number, cacheRead: number, cacheWrite: number, requests: number];
  /** Tokens by ISO week. */
  wk: Record<string, WeekTally>;
  /** Compaction boundaries in the log. */
  cp: number;
  /** A `git commit` Bash call whose result was not an error. */
  cm?: 1;
  /** Workflow run ids (`wf_…`) launched from a `review-repair` script. */
  rr?: string[];
  /** Start-of-session readings (`StartReading`): model, CLI version, first-request tokens, parts, looks, requests. */
  sr?: StartSummary;
}

/** What `agentscan.ts`'s `StartReading` leaves in a summary; every field absent where the log did not say. */
export interface StartSummary {
  /** Model of the first counted request. */
  md?: string;
  /** The `version` field of the first record that had one. */
  cli?: string;
  /** First request's input + cache read + cache write. */
  st?: number;
  /** Chars per start part, from the attachments before that request. */
  pt?: Partial<Record<StartPart, number>>;
  /** Looks before the first edit; absent = never edited. */
  lk?: number;
  /** Counted requests (not in a fork's copied prefix). */
  rq: number;
}

/** One subagent log (`<conv>/subagents/…/agent-*.jsonl`). */
export interface AgentLogSummary {
  m: number;
  s: number;
  /** The workflow run directory it sits in (`wf_…`), when it is a workflow's agent. */
  wf?: string;
  wk: Record<string, WeekTally>;
  /** First record's time (ms). */
  t0?: number;
  sr?: StartSummary;
}

export const EDIT_TOOLS: ReadonlySet<string> = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/** Tools that only read the local tree. WebFetch is not here: it reads the network, not the repo. Worded for people by shared `LOOK_RULE_TEXT`. */
export const LOOK_TOOLS: ReadonlySet<string> = new Set(["Read", "Grep", "Glob", "LS", "NotebookRead"]);
/** A leading `cd <dir> &&` (any number of them) is not the command. */
const CD_PREFIX_RE = /^\s*cd\s+(?:"[^"]*"|'[^']*'|[^&;|\s]+)\s*&&\s*/;
/** A Bash command that only looks, after its leading `cd … &&`. */
export const LOOK_CMD_RE = /^(?:grep|rg|find|ls|cat|head|tail|sed\s+-n|wc|jq|tree|git\s+(?:log|show|diff|grep|blame|status))(?![\w-])/;
/** Whether one tool call is a look (see `LOOK_RULE_TEXT`). */
export function isLookCall(name: string, command: unknown): boolean {
  if (LOOK_TOOLS.has(name)) return true;
  if (name !== "Bash" || typeof command !== "string") return false;
  let c = command;
  for (let i = 0; i < 4 && CD_PREFIX_RE.test(c); i++) c = c.replace(CD_PREFIX_RE, "");
  return LOOK_CMD_RE.test(c.trimStart());
}

const strLen = (v: unknown): number | null =>
  typeof v === "string" ? v.length : v && typeof v === "object" ? JSON.stringify(v).length : null;

/**
 * The start-context chars one `attachment` row adds, by part. A row that is not one, or whose shape
 * moved, yields nothing — never a zero. Instruction files split by their own `type`: `AutoMem` is
 * the auto-memory index, every other file (User, Project, Local, managed) is a CLAUDE.md.
 * The attachment shapes are `ctxlog/ctxcursor.ts`'s `carriedPartsOf`; this only regroups them.
 */
export function startPartsOf(row: Record<string, unknown>): [StartPart, number][] {
  const a = row.type === "attachment" ? row.attachment as Record<string, unknown> | undefined : undefined;
  if (!a || typeof a !== "object" || typeof a.type !== "string") return [];
  const out: [StartPart, number][] = [];
  switch (a.type) {
    case "hook_success": { const n = strLen(a.content ?? a.stdout); if (n !== null) out.push(["hooks", n]); return out; }
    case "session_context": { const n = strLen(a.context); if (n !== null) out.push(["session", n]); return out; }
    case "environment": { const n = strLen(a.snapshot); if (n !== null) out.push(["session", n]); return out; }
    case "date": { const n = strLen(a.date); if (n !== null) out.push(["session", n]); return out; }
    case "model": { const n = strLen(a.text); if (n !== null) out.push(["session", n]); return out; }
  }
  for (const p of carriedPartsOf(row)) {
    switch (p.kind) {
      case "system_prompt": out.push(["system", p.chars]); break;
      case "tool_schemas": out.push(["tools", p.chars]); break;
      case "instructions":
        for (const f of p.files ?? []) out.push([f.type === "AutoMem" ? "memory" : "claudeMd", f.chars]);
        break;
      case "skill_listing": out.push(["skills", p.chars]); break;
      case "deferred_tools": out.push(["deferredTools", p.chars]); break;
      case "agent_listing": out.push(["agents", p.chars]); break;
      case "hook_context": out.push(["hooks", p.chars]); break;
      case "mcp_instructions": out.push(["other", p.chars]); break;
    }
  }
  return out;
}

/** The words that make a conversation rework. Whole words, any case. */
export const REWORK_RE = /\b(fix(?:es|ed|ing)?|repair(?:s|ed|ing)?|broken|again|bugs?|regress(?:ion|ions|ed)?|revert(?:s|ed)?|(?:does ?n[o']t|not) work(?:ing)?)\b/i;
/** A prompt that OPENS with one of these (and has no rework word) is feature work. */
export const FEATURE_RE = /^(?:please\s+)?(add|build|implement|create|introduce|make|new|support|design|write)\b/i;

/** The region pools models; the token-stats card compares one at a time. Said on every pooled reading. */
export const POOLED_MODELS_TEXT = "Every model that ran is pooled in this week's median, so a switch of model moves it as well as an instruction edit does; the Agent readings over time card in the token stats takes one model at a time.";

export const RULES: AgentReadingRules = {
  start:
    `What a fresh session's first request carried, measured off this desktop's conversation logs (not estimated): the median of its tokens (fresh input + cache read + cache write) over fresh interactive sessions that started this week — forked, continued and headless (claude -p) logs left out. Under it, the median characters per part of that start (the parts the log records before the first request, named as in "what every turn carries"); a part's median is over the sessions that recorded it, and the part medians do not add up to the token figure. Subagent logs that started this week are their own line, never in the session median. A median needs at least ${SERIES_MIN_N} sessions; with fewer the reading is not taken. ${POOLED_MODELS_TEXT}`,
  explore:
    `Two medians over one set of sessions: fresh sessions that started this week and reached a first file edit (Edit, Write, MultiEdit or NotebookEdit). Tokens: the input side (fresh input + cache read + cache write) the session sent before that edit; the split under it is the median session's own. Looks: calls that only read before that edit. ${LOOK_RULE_TEXT} Forked, continued and headless (claude -p) logs are left out; sessions that never edited are counted beside it, not in it; the session's own subagents are in neither figure. A median needs at least ${SERIES_MIN_N} sessions; with fewer the reading is not taken. ${POOLED_MODELS_TEXT}`,
  requests:
    `Median requests (replies from the model, a streamed reply counted once) of a fresh session that ran a git commit that did not error, counted in the week the session STARTED — unlike Compactions, which counts a session in the week its log last moved. Forked, continued, headless and subagent logs are left out. A median needs at least ${SERIES_MIN_N} sessions; with fewer the reading is not taken. ${POOLED_MODELS_TEXT}`,
  rework:
    "Rework = a conversation whose first prompt or title says fix, repair, broken, again, bug, regression, revert or not working, plus every agent of a review-repair workflow run. Feature = a prompt that opens with add, build, implement, create, introduce, make, new, support, design or write and has none of those words. Everything else is unknown, never feature. Tokens are filed under the week they were spent; subagents under their conversation's class.",
  compact:
    "Compactions per session that ran a git commit that did not error, counted in the week the session's log last moved. The same count over every session that week stands beside it.",
  spend:
    "Requests and list-price dollars the token ledger filed under this repo (its worktrees folded in) on the days of this week, subagents included — the same rows as the token-stats screen's By repo. Dollars are a counterfactual off the ledger's one dated price table, not a bill; a request on a model with no price adds no dollars, so the price per request divides by priced requests only. Context per request is the input side (fresh input + cache read + cache write) over every request.",
  activity:
    "Conversations whose log spent tokens this week (one running over two weeks counts in both), how many of them started this week, and the subagent logs under them that spent tokens. The token split is the same total as Rework spend, cut by whose log it was in: the conversation's own, or its subagents'.",
  escaped:
    "Crash groups marked in the exposure watch's triage file (the week of the mark's latest change), and backlog items whose category is bug (the week they were added; items deleted from the backlog are gone from this count).",
};

/** The person's own words: pasted blocks, command wrappers and system reminders cut out. */
export function promptWords(text: string): string {
  return text
    .replace(/<pasted_content\b[^>]*>[\s\S]*?<\/pasted_content>/g, " ")
    .replace(/<(system-reminder|command-[a-z-]+|local-command-[a-z-]+)>[\s\S]*?<\/\1>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The rule above. `prompt` is the first prompt as written; `title` the conversation's title, if any. */
export function classifyRework(prompt: string | undefined, title: string | undefined): { c: ReworkClass; word?: string } {
  const words = promptWords(prompt ?? "");
  const hit = REWORK_RE.exec(words) ?? (title ? REWORK_RE.exec(title) : null);
  if (hit) return { c: "rework", word: hit[1]!.toLowerCase() };
  const f = FEATURE_RE.exec(words);
  if (f) return { c: "feature", word: f[1]!.toLowerCase() };
  return { c: "unknown" };
}

/** The CLI's opening line for a conversation carried over from one that ran out of context. */
export const CONTINUED_RE = /^This session is being continued from a previous conversation/;

/** ISO week (Monday, host-local day) of an instant. */
export function weekOfMs(ms: number): string | null {
  return Number.isFinite(ms) ? isoWeekOf(hourKey(ms).slice(0, 10)) : null;
}

/** The `count` weeks ending with the one `now` falls in, oldest first. */
export function lastWeeks(now: number, count: number): string[] {
  const cur = weekOfMs(now);
  if (!cur) return [];
  const base = Date.parse(`${cur}T00:00:00Z`);
  const out: string[] = [];
  for (let i = count - 1; i >= 0; i--) out.push(new Date(base - i * 7 * 86_400_000).toISOString().slice(0, 10));
  return out;
}

const totalsOf = (t: WeekTally): TokenTotals =>
  ({ input: t[0], output: t[1], cacheRead: t[2], cacheWrite: t[3], cacheWrite1h: t[4], turns: t[5] });
const addTally = (into: WeekTally, t: WeekTally): void => { for (let i = 0; i < into.length; i++) into[i] += t[i]!; };
const zeroTally = (): WeekTally => [0, 0, 0, 0, 0, 0];
const tallyTotal = (t: WeekTally): number => t[0] + t[1] + t[2] + t[3];

/** A conversation with its agents, resolved: the class each agent's spend goes under. */
export interface ResolvedConv {
  conv: ConvSummary;
  agents: AgentLogSummary[];
}

/** Whether a workflow agent's directory belongs to a review-repair run the parent launched. */
export function inRepairRun(wf: string | undefined, runs: readonly string[] | undefined): boolean {
  if (!wf || !runs?.length) return false;
  // The directory name has been seen shorter than the run id; match a prefix either way.
  return runs.some((r) => r === wf || r.startsWith(wf) || wf.startsWith(r));
}

/** Extra counts the route reads off other stores (exposure triage, backlog), week → count, or why none. */
export interface EscapedInputs {
  crash: Record<string, number> | AgentReadingAbsent;
  bugs: Record<string, number> | AgentReadingAbsent;
  /** The token ledger's rows for the repo, by week, or why there are none. */
  spend?: Record<string, RepoSpendWeek> | AgentReadingAbsent;
}

const absent = (why: string): AgentReadingAbsent => ({ absent: why });
const plural = (n: number, one: string): string => `${n} ${n === 1 ? one : `${one}s`}`;

/**
 * Fold one repo's conversations into its weekly readings for `weeks`
 * (oldest first). Pure: every number comes from the summaries handed in.
 */
export function foldAgentWeeks(convs: readonly ResolvedConv[], weeks: readonly string[], escaped: EscapedInputs,
  /** The agent series by week (`seriesOf(points, { grain: "week" })`) — the token-stats card's
   *  function too, so the two can never disagree. Omitted = no start/looks/requests readings. */
  series?: readonly SeriesBucket[]): AgentReadingsWeek[] {
  const byWeek = new Map((series ?? []).map((b) => [b.key, b]));
  return weeks.map((week) => ({
    week,
    ...(escaped.spend ? { spend: spendOf(escaped.spend, week) } : {}),
    activity: activityOf(convs, week),
    ...(series ? { start: startOf(byWeek.get(week)) } : {}),
    explore: exploreOf(convs, week, series ? (byWeek.get(week)?.look ?? absent(seriesTooFewText(0, "look"))) : undefined),
    ...(series ? { requests: byWeek.get(week)?.req ?? absent(seriesTooFewText(0, "req")) } : {}),
    rework: reworkOf(convs, week),
    compact: compactOf(convs, week),
    escaped: escapedOf(escaped, week),
  }));
}

function spendOf(s: Record<string, RepoSpendWeek> | AgentReadingAbsent, week: string): AgentSpendReading | AgentReadingAbsent {
  if (isAgentAbsent(s)) return s;
  return s[week] ?? absent("The token ledger has no request from this repo this week.");
}

function activityOf(convs: readonly ResolvedConv[], week: string): AgentActivityReading | AgentReadingAbsent {
  let sessions = 0, started = 0, agents = 0, mainTok = 0, agentTok = 0;
  for (const { conv, agents: subs } of convs) {
    const own = conv.wk[week];
    let spent = !!own && tallyTotal(own) > 0;
    if (own) mainTok += tallyTotal(own);
    for (const a of subs) {
      const t = a.wk[week];
      if (!t || !tallyTotal(t)) continue;
      agents++;
      agentTok += tallyTotal(t);
      spent = true;
    }
    if (!spent) continue;
    sessions++;
    if (conv.t0 !== undefined && weekOfMs(conv.t0) === week) started++;
  }
  if (!sessions) return absent("No conversation spent tokens in this repo this week.");
  return { sessions, started, agents, mainTok, agentTok };
}

function startOf(b: SeriesBucket | undefined): AgentStartReading | AgentReadingAbsent {
  if (!b) return absent("No session or subagent started in this repo this week.");
  const parts = START_PARTS.flatMap(({ id }) => (b.parts[id] ? [{ id, chars: b.parts[id]! }] : []));
  return { fresh: b.fresh, tok: b.start, parts, sub: b.subStart };
}

function exploreOf(convs: readonly ResolvedConv[], week: string, looks?: SeriesValue): AgentExploreReading | AgentReadingAbsent {
  const started = convs.filter(({ conv }) => conv.t0 !== undefined && weekOfMs(conv.t0) === week);
  if (!started.length) return absent("No session started in this repo this week.");
  const fresh = started.filter(({ conv }) => !conv.nf);
  const skipped = started.length - fresh.length;
  const edited = fresh.map(({ conv }) => conv.ex).filter((x): x is NonNullable<ConvSummary["ex"]> => !!x);
  const noEdit = fresh.length - edited.length;
  if (!edited.length) {
    return absent(fresh.length
      ? `None of the ${fresh.length} fresh session${fresh.length === 1 ? "" : "s"} this week edited a file.`
      : `All ${skipped} session${skipped === 1 ? "" : "s"} this week were forked, continued or headless.`);
  }
  // The look median is the series' (minimum SERIES_MIN_N); the token median follows the same
  // minimum so both figures stand over one set of sessions or neither is taken.
  if (looks && edited.length < SERIES_MIN_N) {
    return absent(`${seriesTooFewText(edited.length, "look")} ${plural(noEdit, "fresh session")} never edited; ${skipped} left out (forked, continued or headless).`);
  }
  const inputSide = (e: NonNullable<ConvSummary["ex"]>) => e[0] + e[1] + e[2];
  const sorted = [...edited].sort((a, b) => inputSide(a) - inputSide(b));
  // The LOWER middle: an even count would otherwise average two sessions into
  // a split no session had.
  const mid = sorted[Math.floor((sorted.length - 1) / 2)]!;
  return {
    sessions: edited.length, noEdit, skipped,
    medianTok: inputSide(mid),
    split: { input: mid[0], output: 0, cacheRead: mid[1], cacheWrite: mid[2], cacheWrite1h: 0, turns: mid[3] },
    medianRequests: mid[3],
    ...(looks ? { looks } : {}),
  };
}

function reworkOf(convs: readonly ResolvedConv[], week: string): AgentReworkReading | AgentReadingAbsent {
  const by: Record<ReworkClass, WeekTally> = { rework: zeroTally(), feature: zeroTally(), unknown: zeroTally() };
  const sessions: Record<ReworkClass, number> = { rework: 0, feature: 0, unknown: 0 };
  let repairRuns = 0;
  for (const { conv, agents } of convs) {
    const seen = new Set<ReworkClass>();
    const own = conv.wk[week];
    if (own && tallyTotal(own)) { addTally(by[conv.c], own); seen.add(conv.c); }
    const runs = new Set<string>();
    for (const a of agents) {
      const t = a.wk[week];
      if (!t || !tallyTotal(t)) continue;
      const repair = inRepairRun(a.wf, conv.rr);
      if (repair) runs.add(a.wf!);
      const c: ReworkClass = repair ? "rework" : conv.c;
      addTally(by[c], t);
      seen.add(c);
    }
    repairRuns += runs.size;
    for (const c of seen) sessions[c]++;
  }
  const totalTok = tallyTotal(by.rework) + tallyTotal(by.feature) + tallyTotal(by.unknown);
  if (!totalTok) return absent("No tokens were spent in this repo this week.");
  return {
    totalTok,
    byClass: { rework: totalsOf(by.rework), feature: totalsOf(by.feature), unknown: totalsOf(by.unknown) },
    sessions, repairRuns,
  };
}

function compactOf(convs: readonly ResolvedConv[], week: string): AgentCompactReading | AgentReadingAbsent {
  const ended = convs.filter(({ conv }) => conv.t1 !== undefined && weekOfMs(conv.t1) === week);
  if (!ended.length) return absent("No session in this repo ran this week.");
  const committed = ended.filter(({ conv }) => conv.cm);
  const sum = (xs: readonly ResolvedConv[]) => xs.reduce((n, { conv }) => n + conv.cp, 0);
  if (!committed.length) return absent(`None of the ${ended.length} session${ended.length === 1 ? "" : "s"} this week ran a git commit (${sum(ended)} compaction${sum(ended) === 1 ? "" : "s"} across them).`);
  return { committed: committed.length, compactions: sum(committed), sessionsAll: ended.length, compactionsAll: sum(ended) };
}

function escapedOf(e: EscapedInputs, week: string): AgentEscapedReading {
  const pick = (x: Record<string, number> | AgentReadingAbsent): number | AgentReadingAbsent =>
    isAgentAbsent(x) ? x : ((x as Record<string, number>)[week] ?? 0);
  return { crashMarks: pick(e.crash), bugItems: pick(e.bugs) };
}

/** Count instants into weeks. Undated entries (`NaN`) are dropped. */
export function countByWeek(instants: readonly number[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of instants) {
    const w = weekOfMs(t);
    if (w) out[w] = (out[w] ?? 0) + 1;
  }
  return out;
}
