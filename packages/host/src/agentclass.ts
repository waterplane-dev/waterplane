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
import { isAgentAbsent, isoWeekOf, hourKey, type AgentCompactReading, type AgentEscapedReading, type AgentExploreReading,
  type AgentReadingAbsent, type AgentReadingRules, type AgentReadingsWeek, type AgentReworkReading, type ReworkClass,
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
}

/** One subagent log (`<conv>/subagents/…/agent-*.jsonl`). */
export interface AgentLogSummary {
  m: number;
  s: number;
  /** The workflow run directory it sits in (`wf_…`), when it is a workflow's agent. */
  wf?: string;
  wk: Record<string, WeekTally>;
}

export const EDIT_TOOLS: ReadonlySet<string> = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/** The words that make a conversation rework. Whole words, any case. */
export const REWORK_RE = /\b(fix(?:es|ed|ing)?|repair(?:s|ed|ing)?|broken|again|bugs?|regress(?:ion|ions|ed)?|revert(?:s|ed)?|(?:does ?n[o']t|not) work(?:ing)?)\b/i;
/** A prompt that OPENS with one of these (and has no rework word) is feature work. */
export const FEATURE_RE = /^(?:please\s+)?(add|build|implement|create|introduce|make|new|support|design|write)\b/i;

export const RULES: AgentReadingRules = {
  explore:
    "Median input-side tokens (fresh input + cache read + cache write) a fresh session spent before its first file edit (Edit, Write, MultiEdit or NotebookEdit), counted in the week it started. Forked, continued and headless (claude -p) logs are left out; sessions that never edited are counted beside it, not in it. Tokens the session's own subagents spent are not in it. Lower is better: less reading before the work starts.",
  rework:
    "Rework = a conversation whose first prompt or title says fix, repair, broken, again, bug, regression, revert or not working, plus every agent of a review-repair workflow run. Feature = a prompt that opens with add, build, implement, create, introduce, make, new, support, design or write and has none of those words. Everything else is unknown, never feature. Tokens are filed under the week they were spent; subagents under their conversation's class.",
  compact:
    "Compactions per session that ran a git commit that did not error, counted in the week the session's log last moved. The same count over every session that week stands beside it.",
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
}

const absent = (why: string): AgentReadingAbsent => ({ absent: why });

/**
 * Fold one repo's conversations into its weekly readings for `weeks`
 * (oldest first). Pure: every number comes from the summaries handed in.
 */
export function foldAgentWeeks(convs: readonly ResolvedConv[], weeks: readonly string[], escaped: EscapedInputs): AgentReadingsWeek[] {
  return weeks.map((week) => ({
    week,
    explore: exploreOf(convs, week),
    rework: reworkOf(convs, week),
    compact: compactOf(convs, week),
    escaped: escapedOf(escaped, week),
  }));
}

function exploreOf(convs: readonly ResolvedConv[], week: string): AgentExploreReading | AgentReadingAbsent {
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
