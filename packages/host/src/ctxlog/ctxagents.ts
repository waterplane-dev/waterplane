/** What the Task tool's subagents spent: agentUsage and its roster, cumulative and live folds. Moved from ctxlog.ts. */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { AgentRun, CostBreakdown, SkillLoad, TokenTotals } from "@waterplane/shared";
import { AGENT_CTX_POINTS, AGENT_CUM_POINTS, AGENT_LIVE_MS, addCost, addTotals, costOf, normalizeModel, tokenTotal, zeroCost, zeroTotals } from "@waterplane/shared";
import { localDay, stamp, toMs } from "../convlog.js";
import { readMeta } from "../agents.js";
import { SEEN_CAP, SKILL_BODY, readRange, pushSkill, skillLoadOf } from "./ctxcursor.js";
import { usageRecordOf } from "./usagerecord.js";

// ── What the subagents spent ──────────────────────────────────────────────

/**
 * The Task tool's agents, as a token total.
 *
 * They are the reason a session's spend and its context window can be two
 * wildly different numbers: a fan-out turn carries 30k in its own window and
 * pays for eight conversations nobody can see from the launcher row. The CLI
 * writes each of them to `<conversation>/subagents/agent-<id>.jsonl`
 * (`agents.ts` reads the same directory for what they are DOING), and those
 * files are `isSidechain` records — the same shape, same `message.usage`, a
 * different conversation.
 *
 * Measured on this desktop: 0 of 7,761 logs in this repo carry an inline
 * `isSidechain` row, and 27 conversations have a `subagents/` directory. So
 * this is where the agents' tokens are, and `updateContextLog`'s sidechain
 * guard stays exactly as it was — on a CLI that writes both shapes, adding the
 * inline one as well would count the same agent twice.
 *
 * Incremental for the same reason the series is: an agent's log grows while it
 * runs, and this is asked once a minute per live session.
 */
/**
 * An agent run as this file knows it: the model by ID, not by index.
 *
 * The wire form carries an INDEX into the document's model table, and that
 * table is the conversation's — which an agent's model need not be in at all (a
 * haiku worker under an opus parent is the ordinary shape). So the index can
 * only be assigned where both halves are in hand, which is `withAgentRuns`, and
 * until then the id travels whole.
 */
export interface AgentRunRaw extends Omit<AgentRun, "model"> {
  modelId?: string;
}

/**
 * The roster on the wire: agent models folded INTO the document's model table.
 *
 * A model only an agent ever ran is appended rather than dropped — the bars
 * would otherwise be a stack of "unknown" on a fan-out, which is most of the
 * chart on the session this exists for. It goes after the conversation's own
 * models because that table is ordered by the volume the CONVERSATION spent,
 * and an appended entry has no place in that ordering to claim; the phone caps
 * the palette at its validated slots either way.
 */
export function withAgentRuns(models: string[], runs: AgentRunRaw[]): { models: string[]; agents: AgentRun[] } {
  const table = models.slice();
  const agents = runs.map(({ modelId, ...rest }) => {
    if (!modelId) return rest;
    // By ALIAS, like the table itself — an agent on a dated snapshot of the
    // model its parent ran is that model, not a second one.
    const alias = normalizeModel(modelId) ?? modelId;
    let i = table.indexOf(alias);
    if (i < 0) { i = table.length; table.push(alias); }
    return { ...rest, model: i };
  });
  return { models: table, agents };
}

export interface AgentUsage {
  dir: string;
  /** Every agent log's input + cache + output, summed. Each log is read WHOLE
   *  (forward, in `MAX_READ` chunks); still a FLOOR only in that a log that has
   *  been cleaned up is one nobody can add. */
  tok: number;
  /** The same tokens by kind, so the agents' share can be shown the way the
   *  main conversation's is rather than as one opaque figure — a fan-out
   *  session is mostly this, and "1.1M in agents" says nothing about whether
   *  that was eight fresh prompts or one window re-read eighty times.
   *  `tokenTotal(split)` is `tok` exactly. */
  split: TokenTotals;
  /** What the agents' tokens would have cost at list prices, priced per record
   *  on that record's own model and day — the same rule as the parent
   *  conversation's, because a fan-out session is mostly this and the two
   *  halves of one figure must not be computed two ways. */
  cost: CostBreakdown;
  /** Agent tokens on a model with no published rate. */
  unpriced: number;
  /** Agent logs it was read from. */
  logs: number;
  /**
   * One entry per agent log, oldest first — the ROSTER behind the total.
   *
   * `tok` says the agents spent 355M and stops there. How many there were, WHEN
   * each started and which model ran it are three separate questions, all three
   * already on disk, and none of them answerable from a sum. The per-file
   * cursors hold every one of those facts already; this is them, projected.
   */
  runs: AgentRunRaw[];
  files: Map<string, AgentFile>;
}

export interface AgentFile {
  consumed: number;
  size: number;
  mtime: number;
  tok: number;
  split: TokenTotals;
  cost: CostBreakdown;
  unpriced: number;
  /** The newest model this log named. One agent runs one model in every log
   *  seen here; newest-wins is the same rule the parent series uses. */
  model?: string;
  /** Its first and last dated record — when the agent started and stopped
   *  writing. 0 until one arrives; a log whose records carry no usable stamp
   *  keeps 0 and is left OUT of the roster rather than placed at the epoch. */
  firstAt: number;
  lastAt: number;
  /** Every request's context `[t, tok]`, halved (max kept per pair) past
   *  `AGENT_CTX_RAW`, so a long agent is bounded and its peak survives. */
  ctx: [number, number][];
  peak: number;
  /** The window its NEWEST dated request carried, and when — what it re-reads
   *  on its next step if it is still running (`liveAgentOf`). 0 until one. */
  curTok: number;
  curAt: number;
  /** The running `tok` at each dated request, `[t, tok]` — the log's own
   *  spend curve. An undated record's spend rides into the NEXT dated point
   *  (the counter is running), and `agentCumOf` closes the curve at `tok`.
   *  Halved past `AGENT_CTX_RAW` keeping the LATER of each pair, which is
   *  still a true value of the running total. */
  cum: [number, number][];
  /** Skill bodies this agent loaded, oldest first — see `SkillLoad`. */
  skills: SkillLoad[];
  seen: Set<string>;
  seenOrder: string[];
}

/** Raw context points kept per agent before halving. */
const AGENT_CTX_RAW = 2_000;

/** Pairs merged, the larger kept — a thinning that can never lose the peak. */
function halveMax(pts: [number, number][]): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < pts.length; i += 2) {
    const b = pts[i + 1];
    out.push(b && b[1] > pts[i][1] ? b : pts[i]);
  }
  return out;
}

/** Pairs merged, the later kept — for a RUNNING total, whose later point
 *  already contains the earlier one's spend. */
function halveLast(pts: [number, number][]): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < pts.length; i += 2) out.push(pts[i + 1] ?? pts[i]);
  return out;
}

/** At most `max` points, one per equal-count bucket, each bucket's largest. */
export function thinMax(pts: [number, number][], max: number): [number, number][] {
  if (pts.length <= max) return pts.slice();
  const out: [number, number][] = [];
  for (let b = 0; b < max; b++) {
    const lo = Math.floor((b * pts.length) / max);
    const hi = Math.floor(((b + 1) * pts.length) / max);
    let best = pts[lo];
    for (let i = lo + 1; i < hi; i++) if (pts[i][1] > best[1]) best = pts[i];
    out.push(best);
  }
  return out;
}

/** One agent log's own dedupe memory. Bounded like the series' — streaming
 *  duplicates are adjacent, and an unbounded Set per agent is a leak. */
function rememberIn(f: AgentFile, id: string): boolean {
  if (f.seen.has(id)) return false;
  f.seen.add(id);
  f.seenOrder.push(id);
  if (f.seenOrder.length > SEEN_CAP) {
    const gone = f.seenOrder.shift();
    if (gone !== undefined) f.seen.delete(gone);
  }
  return true;
}

/** Add what one agent log has spent since it was last read. */
function readAgentFile(path: string, f: AgentFile): void {
  // FORWARD, to the end, never a tail: an agent's log is its whole bill, and
  // one implementer's 246 MB log read from its last 24 MB put 307M on the
  // screen for 786M spent — a total that looks complete and is 40% of one.
  // Incremental after the first pass, so the whole-file read happens once.
  for (;;) {
    const read = readRange(path, f.consumed);
    if (!read) return;
    readAgentLines(read.lines, f);
    const moved = read.consumed > f.consumed;
    f.consumed = read.consumed;
    f.size = read.size;
    f.mtime = read.mtime;
    if (!moved || f.consumed >= read.size) return;
  }
}

function readAgentLines(lines: string[], f: AgentFile): void {
  for (const line of lines) {
    if (!line || line.charCodeAt(0) !== 123 /* { */) continue;
    const skill = line.includes(SKILL_BODY);
    if (!skill && !line.includes('"usage"')) continue;
    let row: Record<string, unknown>;
    try { row = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    if (skill) {
      const sk = skillLoadOf(row, stamp(row));
      if (sk) { pushSkill(f.skills, sk); continue; }
    }
    // The usage-limit rejection's zero-usage turn and a streamed reply's
    // repeats are dropped by `usageRecordOf`, the same record as in the series.
    const rec = usageRecordOf(row, (id) => rememberIn(f, id));
    if (!rec) continue;
    if (rec.model !== null) f.model = rec.model;   // newest wins
    // When this agent ran. `stamp` is the series' own reader, so an agent and a
    // turn cannot end up on two different clocks; an undated record simply does
    // not move the window, and a log with none at all stays at 0 and is left
    // off the roster rather than drawn at the epoch.
    const at = stamp(row);
    if (at != null) {
      if (!f.firstAt || at < f.firstAt) f.firstAt = at;
      if (at > f.lastAt) f.lastAt = at;
    }
    const spent = rec.carried + rec.output;
    f.tok += spent;
    // Same rule as the series: a record with nothing on it is not a request.
    if (spent <= 0) continue;
    // The agent's OWN window: what this request carried, output excluded (it
    // is not in the window until the next turn) — the parent's rule.
    const held = rec.carried;
    if (held > f.peak) f.peak = held;
    if (at != null && held > 0 && at >= f.curAt) { f.curTok = held; f.curAt = at; }
    if (at != null && held > 0) {
      f.ctx.push([at, held]);
      if (f.ctx.length > AGENT_CTX_RAW) f.ctx = halveMax(f.ctx);
    }
    // The spend curve: the RUNNING total at this dated request, so whatever an
    // undated record before it spent is inside this point rather than lost.
    if (at != null) {
      f.cum.push([at, f.tok]);
      if (f.cum.length > AGENT_CTX_RAW) f.cum = halveLast(f.cum);
    }
    const bag: TokenTotals = {
      input: rec.input,
      output: rec.output,
      cacheRead: rec.cacheRead,
      cacheWrite: rec.cacheWrite,
      cacheWrite1h: rec.cacheWrite1h,
      turns: 1,
    };
    addTotals(f.split, bag);
    // An agent picks its own model — a fan-out that runs haiku workers under an
    // opus parent is the ordinary case — so the record's model is asked here
    // too, never the parent's. The agent log has no `timestamp` guarantee this
    // fold depends on, so an unstamped record is priced at TODAY's rate, which
    // only differs on a day a price moved.
    const c = costOf(bag, rec.model,
      typeof row.timestamp === "string" ? localDay(toMs(row.timestamp) ?? Date.now()) : undefined);
    if (c) addCost(f.cost, c);
    else f.unpriced += tokenTotal(bag);
  }
}

/**
 * Re-read a session's subagent directory — or build the cursor from scratch.
 *
 * A directory that is not there is a MEASUREMENT, not a failure: the CLI
 * creates it when the first agent runs, so its absence is "this session has
 * spawned none" and the answer is a total of zero. Anything else that goes
 * wrong answers null, and then nothing on any screen claims a total at all —
 * `sparkOf` leaves the field off rather than publishing the main conversation's
 * spend under a name that promises the agents are in it.
 *
 * A file that vanished keeps its tally. Those tokens were spent, and a number
 * that goes DOWN while you watch reads as a bug in the readout rather than as
 * housekeeping in a directory nobody is looking at.
 */
export function agentUsage(dir: string, prev?: AgentUsage | null): AgentUsage | null {
  const cur: AgentUsage = prev && prev.dir === dir
    ? prev
    : { dir, tok: 0, split: zeroTotals(), cost: zeroCost(), unpriced: 0, logs: 0, runs: [], files: new Map() };
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { dir, tok: 0, split: zeroTotals(), cost: zeroCost(), unpriced: 0, logs: 0, runs: [], files: new Map() };
    return null;
  }
  for (const name of names) {
    if (!name.startsWith("agent-") || !name.endsWith(".jsonl")) continue;
    const path = join(dir, name);
    let st;
    try { st = statSync(path); } catch { continue; }
    let f = cur.files.get(name);
    // A shrunken or rewound file is not the one we were reading; start it over
    // rather than appending to a tally whose records are gone.
    if (f && (st.size < f.size || st.mtimeMs < f.mtime)) f = undefined;
    else if (f && st.size === f.size && st.mtimeMs === f.mtime) continue;
    if (!f) {
      f = { consumed: 0, size: 0, mtime: 0, tok: 0, split: zeroTotals(), cost: zeroCost(), unpriced: 0, firstAt: 0, lastAt: 0, ctx: [], peak: 0, curTok: 0, curAt: 0, cum: [], skills: [], seen: new Set(), seenOrder: [] };
      cur.files.set(name, f);
    }
    readAgentFile(path, f);
  }
  // Re-summed from the files rather than incremented, for the reason the
  // total is: a file that vanished keeps its tally, and a running counter
  // would double whatever a re-read of a rewound file added back.
  cur.tok = 0;
  cur.split = zeroTotals();
  cur.cost = zeroCost();
  cur.unpriced = 0;
  const runs: AgentRunRaw[] = [];
  for (const [name, f] of cur.files) {
    cur.tok += f.tok;
    addTotals(cur.split, f.split);
    addCost(cur.cost, f.cost);
    cur.unpriced += f.unpriced;
    // An agent whose log carried no usable timestamp is left OUT of the roster
    // and stays IN the total. It was real spend; it is not a dated event, and
    // the chart it would join has a time axis. Absent beats placed wrongly.
    if (!f.firstAt) continue;
    const id = name.slice("agent-".length, -".jsonl".length);
    const type = readMeta(join(dir, `${name.slice(0, -".jsonl".length)}.meta.json`)).agentType;
    runs.push({
      id, at: f.firstAt, endAt: f.lastAt || f.firstAt, tok: f.tok,
      ...(f.model ? { modelId: f.model } : {}),
      ...(type ? { type } : {}),
      // Absent, never 0: an agent on a model with no published rate has an
      // unknown cost, and a bar labelled $0 claims it was free.
      ...(f.cost.total > 0 ? { costUsd: f.cost.total } : {}),
      ...(f.peak > 0 ? { peakTok: f.peak } : {}),
      ...(f.split.turns > 0 ? { turns: f.split.turns } : {}),
      ...(f.ctx.length ? { ctx: thinMax(f.ctx, AGENT_CTX_POINTS) } : {}),
      ...(f.skills.length ? { skills: f.skills } : {}),
    });
  }
  runs.sort((a, b) => a.at - b.at);
  cur.runs = runs;
  cur.logs = cur.files.size;
  return cur;
}

/**
 * Every agent's spend over time, merged: what ALL the subagents had spent by
 * each instant (`ContextSeriesDoc.agentCum`).
 *
 * Built from each log's own running curve as DELTAS, so agents that overlap in
 * time add up rather than one hiding another, then re-cumulated in time order.
 * The last point equals `use.tok` exactly — the same records, the same dedupe:
 * a log's undated tail closes its curve at its last dated instant, and a log
 * with no dated record at all lands on the final point (spend that cannot be
 * placed is still spend, and it goes where it changes the least: the end).
 * Thinned to `max` points keeping each equal-count bucket's LAST point, so
 * every point is a true value of the running total. Null when no log carried a
 * dated record or nothing was spent.
 */
export function agentCumOf(use: AgentUsage, max = AGENT_CUM_POINTS): [number, number][] | null {
  const deltas: [number, number][] = [];
  let undated = 0;
  for (const f of use.files.values()) {
    if (!f.firstAt || !f.cum.length) { undated += f.tok; continue; }
    let prev = 0;
    for (const [t, v] of f.cum) {
      if (v > prev) deltas.push([t, v - prev]);
      prev = Math.max(prev, v);
    }
    if (f.tok > prev) deltas.push([f.lastAt || f.firstAt, f.tok - prev]);
  }
  if (!deltas.length) return null;
  deltas.sort((a, b) => a[0] - b[0]);
  const pts: [number, number][] = [];
  let run = 0;
  for (const [t, d] of deltas) {
    run += d;
    const last = pts[pts.length - 1];
    if (last && last[0] === t) last[1] = run;
    else pts.push([t, run]);
  }
  if (undated > 0) pts[pts.length - 1][1] += undated;
  if (pts[pts.length - 1][1] <= 0) return null;
  if (pts.length <= max) return pts;
  const out: [number, number][] = [];
  for (let b = 0; b < max; b++) {
    const hi = Math.floor(((b + 1) * pts.length) / max);
    out.push(pts[hi - 1]);
  }
  return out;
}

/**
 * The agents' spend placed on a spark's readings (`ContextSpark.agentUsedPts`):
 * what ALL the subagents had spent by each reading's instant, index-for-index
 * with `times`, off the same merged running total as `agentCumOf` (unthinned).
 * The LAST reading carries `use.tok` exactly — spend after the parent's newest
 * reading, and spend no record dated, still belongs to the session, and the
 * miniature's top edge must be the total printed beside it. Null when no agent
 * spent anything.
 */
export function agentSpendAt(times: number[], use: AgentUsage): number[] | null {
  if (!times.length || !(use.tok > 0)) return null;
  const cum = agentCumOf(use, Number.POSITIVE_INFINITY) ?? [];
  const out: number[] = [];
  let j = 0;
  let run = 0;
  for (const t of times) {
    while (j < cum.length && cum[j][0] <= t) run = cum[j++][1];
    out.push(run);
  }
  out[out.length - 1] = use.tok;
  return out;
}

/**
 * The RUNNING agent with the largest current window (`ContextSpark.liveAgentTok`):
 * among the logs whose newest dated request is within `AGENT_LIVE_MS` of `now`,
 * the one whose newest request carried the most. Current, not peak — an agent
 * that compacted its own window is re-reading what it holds NOW. Null when no
 * agent is live; an undated log is never live (nothing says when it ran).
 */
export function liveAgentOf(use: AgentUsage, now: number): { tok: number; at: number; id: string; type?: string } | null {
  let best: { tok: number; at: number; name: string } | null = null;
  for (const [name, f] of use.files) {
    if (!f.curAt || !(f.curTok > 0) || now - f.curAt > AGENT_LIVE_MS || f.curAt - now > AGENT_LIVE_MS) continue;
    if (!best || f.curTok > best.tok) best = { tok: f.curTok, at: f.curAt, name };
  }
  if (!best) return null;
  const base = best.name.slice(0, -".jsonl".length);
  const type = readMeta(join(use.dir, `${base}.meta.json`)).agentType;
  return { tok: best.tok, at: best.at, id: base.slice("agent-".length), ...(type ? { type } : {}) };
}

/**
 * The agents' windows folded onto a spark's readings: for each reading, the
 * largest context any agent held in that reading's stretch of time — half-way
 * to each neighbour, the first and last stretches open-ended so nothing an
 * agent did falls off either side (`ContextSpark.agentEnv`). Null when no agent
 * reported a dated window.
 */
export function agentEnvelope(times: number[], runs: { ctx?: [number, number][] }[]): number[] | null {
  if (!times.length) return null;
  const env = times.map(() => 0);
  const mids = times.slice(1).map((t, i) => (times[i] + t) / 2);
  let any = false;
  for (const r of runs) {
    for (const [t, v] of r.ctx ?? []) {
      if (!(v > 0)) continue;
      // The first boundary past `t` is the bucket's index. Sixteen readings:
      // a linear walk is cheaper than being clever.
      let i = 0;
      while (i < mids.length && t >= mids[i]) i++;
      if (v > env[i]) env[i] = v;
      any = true;
    }
  }
  return any ? env : null;
}
