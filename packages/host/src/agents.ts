/**
 * The agents a session has RUNNING under it — the CLI's Task/Agent tool, read
 * off the CLI's own logs.
 *
 * The failure this exists for: a session whose main loop has launched two
 * background agents and is waiting for them published `turnActive: false`, so
 * the reader — which has no terminal to look at — said "idle — nothing
 * running" while the terminal two taps away was counting "2 agents · 59s ·
 * ↓ 73.4k tokens". Nothing was idle. The Stop hook is honest about the thing it
 * reports (the MAIN loop's turn ended); it just is not the whole answer to "is
 * work happening here".
 *
 * Deliberately NOT scraped off the screen. The TUI's agent footer is a count
 * and a hint ("⏵⏵ 2 agents"), it is one repaint away from being gone, and the
 * descriptions only exist inside a panel you have to open. The CLI writes all
 * of it to disk instead:
 *
 *   <project>/<conversation>/subagents/agent-<id>.jsonl       the agent's transcript
 *   <project>/<conversation>/subagents/agent-<id>.meta.json   {agentType, description, model}
 *   <project>/<conversation>.jsonl                            the parent, which is
 *                                                             where the END lands
 *
 * so a `readdir` + a `stat` per agent answers "which agents exist", the meta
 * file answers "what is it doing there", and the parent's task-notification
 * record — `<task-id>…</task-id><status>completed</status>`, written when a
 * background agent stops — answers "has it finished". That last one is the
 * exact signal; freshness is only the backstop for the shapes that never emit
 * one (a foreground Task call, a daemon that restarted, a CLI that died).
 *
 * Heuristic like the rest of the log reading, and it degrades the same way: an
 * unreadable meta file costs a description and never a row, an unparseable
 * agent log costs the `doing` line and never the agent, and a missing directory
 * answers an EMPTY list — never a guess at a count.
 */
import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import type { SessionAgent, SourceAgent, SourceSession } from "@waterplane/shared";
import type { BackendDescriptor } from "./backends/types.js";
import { claudeConfigDir, claudeProjectDir } from "./claudeconfig.js";
import { env } from "./env.js";
import { pidAlive } from "./proc.js";

/**
 * How long an agent log may be quiet and still be called running, when no
 * task-notification has retired it.
 *
 * Generous on purpose: an agent sitting in a ten-minute `npm test` writes
 * nothing at all, and calling that finished is the exact lie this module was
 * written to stop telling. The cost of being generous is bounded the other way
 * — a notification retires a finished agent the moment the parent records one,
 * which is seconds, so this ceiling is only ever reached by an agent whose
 * ending was never written down (a killed CLI, a restarted daemon).
 */
const STALE_MS = Number(env("AGENT_STALE_MS") || 10 * 60_000);
/** Tail of the PARENT log scanned for task-notifications. The end of a
 *  still-running agent's life is by definition recent, so a bounded tail is
 *  enough and a full re-read of tens of MB is not on the table. */
const PARENT_TAIL = 256 * 1024;
/** Tail of an AGENT log scanned for what it is doing right now. */
const AGENT_TAIL = 24 * 1024;
/** A pathological fan-out must not turn a status update into a wall of rows. */
const MAX_AGENTS = 12;

/** `agent-a141a1e425712cd1b.jsonl` — the CLI's own file naming IS the id. */
const AGENT_FILE_RE = /^agent-([A-Za-z0-9_-]+)\.jsonl$/;
/** The parent's record of an agent stopping. Written for background agents; a
 *  foreground Task call never emits one (it is inside a turn that is busy). */
const NOTIFY_RE = /<task-id>([A-Za-z0-9_-]+)<\/task-id>/g;

export interface MetaFile { agentType?: string; description?: string; model?: string; finished?: boolean }

/** The CLI rewrites an agent's `.meta.json` with `finished: true` as it stops,
 *  a few tens of ms BEFORE the transcript's last line lands (measured −115…+6 ms
 *  over 61 agents, 2.1 on 2026-10-23). A write later than this slack is the
 *  agent resumed, so the flag no longer speaks for it. */
const FINISHED_SLACK_MS = 2_000;

/** Memo on (path, size, mtime): a meta file is written once and then read on
 *  every poll for the life of the agent. */
const metaCache = new Map<string, { key: string; meta: MetaFile }>();
const META_CACHE_MAX = 256;

/** Exported for `shells.ts`'s transcript join — the same tail-read, reused
 *  rather than re-implemented, so a truncated log degrades the same way in
 *  both readers. */
export function readTail(path: string, cap: number): string | null {
  let st;
  try { st = statSync(path); } catch { return null; }
  const len = Math.min(cap, st.size);
  if (!len) return "";
  const buf = Buffer.allocUnsafe(len);
  let fd;
  try {
    fd = openSync(path, "r");
    readSync(fd, buf, 0, len, st.size - len);
  } catch { return null; } finally { if (fd !== undefined) closeSync(fd); }
  return buf.toString("utf8");
}

/**
 * An agent's `.meta.json`, memoised on (size, mtime).
 *
 * Exported because `ctxlog.ts` wants the same three fields for the HISTORY of a
 * session's agents while this module answers what they are doing right NOW, and
 * a second reader would be a second cache, a second parse and a second opinion
 * about what an unreadable meta file means (it means `{}` — a lost label, never
 * a lost agent).
 */
export function readMeta(path: string): MetaFile {
  let st;
  try { st = statSync(path); } catch { return {}; }
  const key = `${st.size}:${st.mtimeMs}`;
  const hit = metaCache.get(path);
  if (hit && hit.key === key) return hit.meta;
  let meta: MetaFile = {};
  try {
    const raw = readTail(path, 8 * 1024);
    const parsed = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === "object") meta = parsed as MetaFile;
  } catch { meta = {}; }
  metaCache.set(path, { key, meta });
  if (metaCache.size > META_CACHE_MAX) {
    const oldest = metaCache.keys().next().value;
    if (oldest !== undefined) metaCache.delete(oldest);
  }
  return meta;
}

/**
 * When each agent was last told to STOP, by id, off the parent's tail.
 *
 * A time and not a flag: the CLI's own note says a notification "fires each
 * time this agent stops", and an agent resumed with `SendMessage` writes again
 * afterwards — so the comparison that survives a resume is "did it write after
 * it was last retired", not "was it ever retired".
 */
export function notifiedAt(parentTail: string | null): Map<string, number> {
  const out = new Map<string, number>();
  if (!parentTail) return out;
  for (const line of parentTail.split("\n")) {
    if (!line.includes("<task-id>")) continue;
    let at = NaN;
    try {
      const rec = JSON.parse(line) as { timestamp?: string };
      at = Date.parse(rec.timestamp || "");
    } catch { /* a half-written head line, or a shape we don't know */ }
    NOTIFY_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = NOTIFY_RE.exec(line))) {
      // No parseable timestamp still retires the agent — `0` compares as "older
      // than any write", which is the conservative half: it can only leave an
      // agent looking alive, never kill a live one off.
      const prev = out.get(m[1]);
      const val = Number.isFinite(at) ? at : 0;
      if (prev === undefined || val > prev) out.set(m[1], val);
    }
  }
  return out;
}

/**
 * One short line for what the agent is doing, off the tail of its own log —
 * the tool it last called, else the last thing it said.
 *
 * Null rather than a filler phrase: "working" under a row that already says the
 * agent is working is a line spent saying nothing, and inventing an activity
 * out of a record shape we did not recognise is the failure mode this whole
 * module is trying not to reproduce.
 */
export function lastActivity(tail: string | null): string | null {
  if (!tail) return null;
  const lines = tail.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line || !line.startsWith("{")) continue;
    let rec: { type?: string; message?: { content?: unknown } };
    try { rec = JSON.parse(line); } catch { continue; }
    if (rec.type !== "assistant") continue;
    const content = rec.message?.content;
    if (!Array.isArray(content)) continue;
    for (let j = content.length - 1; j >= 0; j--) {
      const block = content[j] as { type?: string; name?: string; text?: string };
      if (block?.type === "tool_use" && block.name) return cap(block.name, 40);
      if (block?.type === "text" && block.text?.trim()) return cap(block.text.trim().split("\n")[0], 80);
    }
  }
  return null;
}

function cap(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** Where the CLI keeps one conversation's agent transcripts. */
export function subagentsDir(cwd: string, conversationId: string): string {
  return join(claudeProjectDir(cwd), conversationId, "subagents");
}

/**
 * A dynamic workflow's agents and what ends them. The Workflow tool runs its
 * agents one level down, out of reach of a reader that only lists `subagents/`:
 *
 *   <conversation>/subagents/workflows/<wf_…>/agent-<id>.jsonl + .meta.json
 *   <conversation>/subagents/workflows/<wf_…>/journal.jsonl
 *
 * and no agent there ever gets a task-notification of its own — only the
 * workflow does, once, at the very end. Missing them, a session whose main loop
 * was "Waiting for 1 dynamic workflow to finish" with three agents at work read
 * as "idle — nothing running" (CLI 2.1.308). The journal is the exact per-agent
 * signal: `started` names an agent against a key, and a record for that key that
 * is not `started` — `result`, or a type that says it failed — is its end.
 */
const WORKFLOW_DIR_RE = /^wf_[A-Za-z0-9_-]+$/;
/** A journal record that ends the agent its key names, besides `result`. */
const WORKFLOW_END_RE = /error|fail|cancel|abort|kill|stop/i;
/** The parent's launch receipt: the task id the workflow's notification will
 *  carry, and the transcript dir that says which `wf_…` it is. Matched on the
 *  raw JSONL line, so newlines are still `\n` escapes. */
const WORKFLOW_LAUNCH_RE = /Task ID: ([A-Za-z0-9_-]+)\\n[\s\S]*?Transcript dir: [^"]*?\/subagents\/workflows\/(wf_[A-Za-z0-9_-]+)/;

export interface WorkflowJournal { agentKey: Map<string, string>; ended: Set<string> }

/** `agentId → key` for every agent the journal saw start, and the keys that ended.
 *  An unreadable line costs that line; an unreadable journal answers nothing
 *  ended, which leaves the agents to the freshness backstop. */
export function readWorkflowJournal(text: string | null): WorkflowJournal {
  const agentKey = new Map<string, string>();
  const ended = new Set<string>();
  for (const line of (text ?? "").split("\n")) {
    if (!line.trim()) continue;
    let rec: { type?: string; key?: string; agentId?: string };
    try { rec = JSON.parse(line); } catch { continue; }
    if (typeof rec.key !== "string" || typeof rec.type !== "string") continue;
    if (rec.type === "started") { if (rec.agentId) agentKey.set(rec.agentId, rec.key); }
    else if (rec.type === "result" || WORKFLOW_END_RE.test(rec.type)) ended.add(rec.key);
  }
  return { agentKey, ended };
}

/** `wf_… → task id`, off the launch receipts in the parent's tail. A launch
 *  older than the tail is simply not mapped: the journal and freshness still
 *  answer for its agents. */
export function workflowTaskIds(parentTail: string | null): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of (parentTail ?? "").split("\n")) {
    if (!line.includes("Transcript dir:") || !line.includes("/subagents/workflows/")) continue;
    const m = WORKFLOW_LAUNCH_RE.exec(line);
    if (m) out.set(m[2], m[1]);
  }
  return out;
}

interface LiveAgent { file: string; dir: string; id: string; lastWriteAt: number; workflow?: string }

function freshAgents(dir: string, now: number, workflow?: string): LiveAgent[] {
  let names: string[];
  try { names = readdirSync(dir); } catch { return []; }
  const out: LiveAgent[] = [];
  for (const name of names) {
    const m = AGENT_FILE_RE.exec(name);
    if (!m) continue;
    const file = join(dir, name);
    let st;
    try { st = statSync(file); } catch { continue; }
    if (now - st.mtimeMs > STALE_MS) continue; // nothing to ask the parent about
    out.push({ file, dir, id: m[1], lastWriteAt: st.mtimeMs, workflow });
  }
  return out;
}

/**
 * The agents still running under this conversation, newest first — the Task
 * tool's and a dynamic workflow's alike. Empty when there are none, when the
 * conversation has no agent directory at all, or when anything about the read
 * fails.
 */
export function readRunningAgents(cwd: string, conversationId: string | undefined, now = Date.now()): SessionAgent[] {
  if (!conversationId) return [];
  const dir = subagentsDir(cwd, conversationId);
  const live = freshAgents(dir, now);
  const wfRoot = join(dir, "workflows");
  let wfNames: string[] = [];
  try { wfNames = readdirSync(wfRoot).filter((n) => WORKFLOW_DIR_RE.test(n)); } catch { /* no workflow ever ran */ }
  for (const wf of wfNames) live.push(...freshAgents(join(wfRoot, wf), now, wf));
  if (!live.length) return [];
  // Paid for only when some agent log is fresh — an idle conversation with a
  // year of finished agents under it never reads the parent at all.
  const parentTail = readTail(join(claudeProjectDir(cwd), `${conversationId}.jsonl`), PARENT_TAIL);
  const notified = notifiedAt(parentTail);
  const wfTask = wfNames.length ? workflowTaskIds(parentTail) : new Map<string, string>();
  const journals = new Map<string, WorkflowJournal>();
  const out: SessionAgent[] = [];
  for (const a of live) {
    if (a.workflow) {
      let j = journals.get(a.workflow);
      if (!j) { j = readWorkflowJournal(readTail(join(a.dir, "journal.jsonl"), PARENT_TAIL)); journals.set(a.workflow, j); }
      const key = j.agentKey.get(a.id);
      if (key !== undefined && j.ended.has(key)) continue; // the workflow recorded its result
      const task = wfTask.get(a.workflow);
      const done = task === undefined ? undefined : notified.get(task);
      if (done !== undefined && done >= a.lastWriteAt) continue; // the whole workflow ended
    } else {
      const stopped = notified.get(a.id);
      if (stopped !== undefined && stopped >= a.lastWriteAt) continue; // it ended, and the parent wrote that down
    }
    const metaPath = join(a.dir, `agent-${a.id}.meta.json`);
    const meta = readMeta(metaPath);
    let startedAt = a.lastWriteAt;
    try { startedAt = statSync(metaPath).mtimeMs; } catch { /* keep the fallback */ }
    // The CLI's own end mark: an agent that wakes AFTER its parent's notification
    // (a late notice about its own background shell) writes once more and stops,
    // and no second notification follows — without this it read as running until
    // the freshness backstop.
    if (meta.finished === true && startedAt >= a.lastWriteAt - FINISHED_SLACK_MS) continue;
    out.push({
      id: a.id,
      what: cap((meta.description || meta.agentType || "agent").trim(), 120),
      type: meta.agentType,
      model: meta.model,
      startedAt,
      lastWriteAt: a.lastWriteAt,
      doing: lastActivity(readTail(a.file, AGENT_TAIL)) ?? undefined,
    });
  }
  out.sort((x, y) => y.lastWriteAt - x.lastWriteAt);
  return out.slice(0, MAX_AGENTS);
}

/**
 * What runs under a session, asked of the backend's `agents` providers in order (backend contract
 * v2): `{store:"claude-agents"}` is `readRunningAgents` above, unchanged; `{source:true}` is the
 * plugin's `AgentSource.list()` on the same poll. SYNC, like the poll that asks it.
 *
 * `null` = no provider answered, so the list stays ABSENT on the wire (a backend that cannot say
 * what runs under it must not look like one with nothing running); an empty list is an answer.
 * A source's rows count as running unless they carry `endedAt`; the cap and newest-first order are
 * the claude reader's. A provider that throws has not answered; the next one is asked.
 */
export function readAgents(
  d: Pick<BackendDescriptor, "facts" | "sources">,
  s: SourceSession & { claudeSessionId?: string },
  now = Date.now(),
): SessionAgent[] | null {
  const providers = Array.isArray(d.facts?.agents) ? d.facts.agents : [];
  for (const p of providers) {
    try {
      if ((p as { store?: unknown }).store === "claude-agents") return readRunningAgents(s.cwd, s.claudeSessionId, now);
      if ((p as { source?: unknown }).source === true && d.sources?.agents) {
        const rows = d.sources.agents.list(s);
        if (rows) return fromSource(rows);
      }
    } catch { /* a provider that throws has not answered */ }
  }
  return null;
}

function fromSource(rows: readonly SourceAgent[]): SessionAgent[] {
  return rows
    .filter((a) => a && typeof a.id === "string" && a.id && a.endedAt === undefined)
    .map<SessionAgent>((a) => ({
      id: a.id,
      what: cap((a.name ?? "").trim() || "agent", 120),
      startedAt: a.startedAt,
      lastWriteAt: a.lastWriteAt ?? a.startedAt,
    }))
    .sort((x, y) => y.lastWriteAt - x.lastWriteAt)
    .slice(0, MAX_AGENTS);
}

/** Did the published set change in a way a person would SEE? Elapsed is counted
 *  on the phone off `startedAt`, so a write that moved nothing but a clock is
 *  not worth a broadcast to every attached client. */
export function agentsChanged(a: SessionAgent[] | undefined, b: SessionAgent[]): boolean {
  const x = a ?? [];
  if (x.length !== b.length) return true;
  for (let i = 0; i < b.length; i++) {
    if (x[i].id !== b[i].id || x[i].doing !== b[i].doing || x[i].what !== b[i].what) return true;
  }
  return false;
}

/**
 * The CLI's own word for what a session is doing, off `~/.claude/sessions/<pid>.json`
 * — `busy`, `idle` or `shell` — for the one thing no log carries: BACKGROUND
 * SHELLS. A `run_in_background` Bash call or a Monitor outlives its turn the same
 * way a background agent does, the footer says "2 shells", and the reader said
 * "done" underneath it. `shell` is written when the main loop is idle and a
 * shell is still running; the file holds no count, so neither does the wire.
 *
 * Which file is OURS: the record carries the tmux target the CLI runs in
 * (`waterplane_<id>:@226.%226`), which is exact; failing that (a CLI with no tmux
 * target on record), the conversation id — but only when exactly ONE live process
 * claims it, because `--resume` of a conversation open elsewhere gives two
 * records the same id, and picking one is a guess. No match ⇒ null, never a
 * status borrowed from another process.
 */
export interface CliSessionRecord { pid?: number; sessionId?: string; tmux?: string; status?: string }

export function pickCliSession(
  recs: CliSessionRecord[], tmuxName: string | null, conversationId: string | undefined,
  alive: (pid: number) => boolean,
): CliSessionRecord | null {
  const live = recs.filter((r) => typeof r.pid === "number" && alive(r.pid));
  if (tmuxName) {
    const hit = live.find((r) => typeof r.tmux === "string" && r.tmux.startsWith(`${tmuxName}:`));
    if (hit) return hit;
  }
  if (!conversationId) return null;
  const same = live.filter((r) => r.sessionId === conversationId);
  return same.length === 1 ? same[0] : null;
}


function readRecord(path: string): CliSessionRecord | null {
  try {
    const v = JSON.parse(readFileSync(path, "utf8"));
    return v && typeof v === "object" ? v as CliSessionRecord : null;
  } catch { return null; }
}

/** waterplane session id → the CLI record file last matched, so a poll reads one file
 *  and not the whole directory. Re-validated on every read. */
const cliFileCache = new Map<string, string>();

/** `readCliStatus`'s status, plus the pid it was read off — `shells.ts` needs
 *  the pid to find the wrapper shells UNDER this CLI process, which the
 *  status string alone cannot name. */
export interface CliRecord { status: string; pid: number }

export function readCliRecord(sessionId: string, tmuxName: string | null, conversationId: string | undefined): CliRecord | null {
  const dir = join(claudeConfigDir(), "sessions");
  // The cache is only ever trusted on the TMUX-TARGET match — exact, by
  // construction, so re-validating the one cached file against itself is a
  // real check. Off tmux, `pickCliSession`'s "exactly one live process claims
  // this conversation id" guard needs to see EVERY record in the directory:
  // re-validating against an array holding only the cached file is trivially
  // "exactly one" every time, which is the guard doing nothing at all — a
  // second `--resume` of the same conversation, opened elsewhere, would never
  // be seen. So a `tmuxName`-less lookup always rescans.
  if (tmuxName) {
    const cached = cliFileCache.get(sessionId);
    if (cached) {
      const r = readRecord(cached);
      if (r && pickCliSession([r], tmuxName, conversationId, pidAlive)) return asCliRecord(r);
      cliFileCache.delete(sessionId);
    }
  }
  let names: string[];
  try { names = readdirSync(dir); } catch { return null; }
  const recs: (CliSessionRecord & { file: string })[] = [];
  for (const n of names) {
    if (!/^\d+\.json$/.test(n)) continue;
    const file = join(dir, n);
    const r = readRecord(file);
    if (r) recs.push({ ...r, file });
  }
  const hit = pickCliSession(recs, tmuxName, conversationId, pidAlive) as (CliSessionRecord & { file: string }) | null;
  if (!hit) return null;
  if (tmuxName) {
    cliFileCache.set(sessionId, hit.file);
    if (cliFileCache.size > 256) { const k = cliFileCache.keys().next().value; if (k !== undefined) cliFileCache.delete(k); }
  }
  return asCliRecord(hit);
}

function asCliRecord(r: CliSessionRecord): CliRecord | null {
  return typeof r.status === "string" && typeof r.pid === "number" ? { status: r.status, pid: r.pid } : null;
}

/** Wrapper kept for its existing callers/tests: the status alone, with none of
 *  the record's other fields. */
export function readCliStatus(sessionId: string, tmuxName: string | null, conversationId: string | undefined): string | null {
  return readCliRecord(sessionId, tmuxName, conversationId)?.status ?? null;
}
