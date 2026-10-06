/**
 * **What each reader turn's subagents spent, on the turn that started them.**
 *
 * The header's session total has always counted the subagents (`ctxlog.ts`'s
 * `agentUsage`); the reader's per-turn footer never did, so one prompt that fanned
 * out five agents read "$1.12 this prompt" under a header saying $9.22, and
 * nothing on screen said which one was wrong. Neither was — they were two
 * different sums with the same name.
 *
 * The CLI writes each agent's log beside the parent
 * (`<conversation>/subagents/agent-<id>.jsonl`) with a `.meta.json` naming the
 * `toolUseId` of the call that started it, and — for an agent an agent started —
 * the `parentAgentId`. So attribution is a lookup, never a guess by time: the
 * call's id is on exactly one turn's tool block, and a nested agent goes where
 * its root went.
 *
 * The spend is `agentUsage`'s per-file ledger, READ, never re-tallied: the same
 * records, dedupe and per-record pricing as the header, so the last turn's
 * running total and the header's total are one number.
 *
 * **An agent can still be running when the footer is drawn** — a background
 * agent's tool call returns at once and its turn "ends" long before it does. So
 * a turn also says how many of its agents are still running, and the figure is
 * then a floor that says so. Running = not retired: the parent wrote a
 * task-notification or hand-back for it after its last write (`agents.ts`'s
 * rule), or — a foreground call — its tool result came back. Past
 * `AGENT_LIVE_MS` of silence with neither, it is called ended: a killed CLI
 * writes no ending, and "still running" for ever is the worse lie.
 *
 * Degrades to ABSENT: a directory that could not be read publishes no agent
 * figure (and the footer keeps saying subagents are not included); one agent
 * that cannot be placed withholds every running total, because a total missing
 * it would read as complete.
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { AGENT_LIVE_MS, normalizeModel, type TranscriptTurn } from "@waterplane/shared";
import { agentUsage, type AgentUsage } from "./ctxlog.js";
import { readMeta } from "./agents.js";

/** Per-directory ledgers, kept so a poll re-reads only the agent logs that
 *  grew — `agentUsage` is incremental given its previous result. */
const cache = new Map<string, AgentUsage>();
const CACHE_MAX = 32;

/** `<conversation>.jsonl` → `<conversation>/subagents`. */
export function subagentsDirOf(logPath: string): string {
  return join(logPath.replace(/\.jsonl$/, ""), "subagents");
}

/** Newest write under the agent directory, 0 when there is none — what the
 *  reader's "unchanged" poll must also compare, since an agent writes while
 *  the parent log sleeps. */
export function agentsMtime(logPath: string): number {
  const dir = subagentsDirOf(logPath);
  let names: string[];
  try { names = readdirSync(dir); } catch { return 0; }
  let max = 0;
  for (const n of names) {
    if (!n.startsWith("agent-") || !n.endsWith(".jsonl")) continue;
    try { max = Math.max(max, statSync(join(dir, n)).mtimeMs); } catch { /* vanished */ }
  }
  return max;
}

const TASK_ID_RE = /<task-id>([A-Za-z0-9_-]+)<\/task-id>/g;
const HAND_BACK_RE = /<agent-message from=\\?"([A-Za-z0-9_-]+)\\?"/g;

/** The ids a raw parent-log line retires (a task-notification or a hand-back),
 *  folded into `into` as "latest mention wins". */
export function noteRetired(line: string, at: number, into: Map<string, number>): void {
  if (!line.includes("<task-id>") && !line.includes("<agent-message from=")) return;
  for (const re of [TASK_ID_RE, HAND_BACK_RE]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line))) {
      const prev = into.get(m[1]);
      if (prev === undefined || at > prev) into.set(m[1], at);
    }
  }
}

interface Meta { toolUseId?: string; parentAgentId?: string; requestShape?: string }

/**
 * Put each agent's spend on the turn that started it, in place.
 *
 * `partial`: the parent log was tail-read, so earlier turns — and the calls of
 * agents started there — are missing; no running total is published.
 */
export function attachAgentSpend(
  turns: TranscriptTurn[],
  logPath: string,
  retired: Map<string, number>,
  partial: boolean,
  now = Date.now(),
): void {
  const dir = subagentsDirOf(logPath);
  const use = agentUsage(dir, cache.get(dir) ?? null);
  if (!use) return; // unreadable — absent, and the footer keeps its caveat
  cache.delete(dir);
  cache.set(dir, use);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);

  // Which turn holds which call, and whether its result has come back.
  const turnOfCall = new Map<string, TranscriptTurn>();
  const answered = new Set<string>();
  for (const t of turns) {
    for (const b of t.blocks) {
      if (b.kind !== "tool") continue;
      if (b.name === "Task" || b.name === "Agent") turnOfCall.set(b.id, t);
      if (b.ok !== undefined) answered.add(b.id);
    }
  }

  const metas = new Map<string, Meta>();
  for (const name of use.files.keys()) {
    const id = name.slice("agent-".length, -".jsonl".length);
    metas.set(id, readMeta(join(dir, `agent-${id}.meta.json`)) as Meta);
  }
  /** The top-level agent an agent descends from; itself when it is one. Null
   *  on a broken or cyclic chain. */
  const rootOf = (id: string): string | null => {
    let cur = id;
    for (let i = 0; i < 8; i++) {
      const p = metas.get(cur)?.parentAgentId;
      if (!p) return cur;
      cur = p;
    }
    return null;
  };
  const runningTop = (id: string, lastWrite: number): boolean => {
    if (now - lastWrite > AGENT_LIVE_MS) return false;
    const stop = retired.get(id);
    if (stop !== undefined && stop >= lastWrite) return false;
    const m = metas.get(id);
    if (m?.requestShape !== "background" && m?.toolUseId && answered.has(m.toolUseId)) return false;
    return true;
  };

  let unplaced = false;
  const agentTurn = new Map<TranscriptTurn, number>(); // turn → index, for the running total
  turns.forEach((t, i) => agentTurn.set(t, i));
  const perTurn = new Array<number>(turns.length).fill(0);
  const seenCalls = new Set<string>();
  for (const [name, f] of use.files) {
    const id = name.slice("agent-".length, -".jsonl".length);
    const root = rootOf(id);
    const call = root ? metas.get(root)?.toolUseId : undefined;
    const t = call ? turnOfCall.get(call) : undefined;
    if (!t || !root) { if (f.tok > 0) unplaced = true; continue; }
    if (call) seenCalls.add(call);
    const rootFile = use.files.get(`agent-${root}.jsonl`);
    const live = root === id
      ? runningTop(id, f.mtime)
      : now - f.mtime <= AGENT_LIVE_MS && !!rootFile && runningTop(root, Math.max(rootFile.mtime, f.mtime));
    if (live) t.agentsRunning = (t.agentsRunning ?? 0) + 1;
    if (f.cost.total > 0) {
      t.agentCostUsd = (t.agentCostUsd ?? 0) + f.cost.total;
      perTurn[agentTurn.get(t)!] += f.cost.total;
    }
    if (f.unpriced > 0) t.agentUnpricedTok = (t.agentUnpricedTok ?? 0) + f.unpriced;
    if (f.tok > 0) {
      const mid = f.model ? normalizeModel(f.model) ?? f.model : "(unknown)";
      let m = (t.agentModels ??= []).find((x) => x.id === mid);
      if (!m) { m = { id: mid, tok: 0 }; t.agentModels.push(m); }
      m.tok += f.tok;
      if (f.cost.total > 0) m.costUsd = (m.costUsd ?? 0) + f.cost.total;
    }
  }
  // A call made moments ago whose log the CLI has not created yet is running
  // with nothing spent — counted, so the footer does not claim the turn is done.
  for (const [call, t] of turnOfCall) {
    if (seenCalls.has(call) || answered.has(call)) continue;
    // …but an old call with no log and no result (an interrupted turn, an
    // agent directory cleaned up) is history, not a running agent.
    if (now - (t.endedAt ?? t.sentAt ?? 0) > AGENT_LIVE_MS) continue;
    t.agentsRunning = (t.agentsRunning ?? 0) + 1;
  }

  if (partial || unplaced) return;
  let cum = 0;
  turns.forEach((t, i) => {
    cum += perTurn[i];
    if (t.cumCostUsd != null) t.cumAgentCostUsd = cum;
  });
}
