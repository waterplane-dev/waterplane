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
import type { SessionAgent } from "@waterplane/shared";
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

export interface MetaFile { agentType?: string; description?: string; model?: string }

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
 * The agents still running under this conversation, newest first. Empty when
 * there are none, when the conversation has no agent directory at all, or when
 * anything about the read fails.
 */
export function readRunningAgents(cwd: string, conversationId: string | undefined, now = Date.now()): SessionAgent[] {
  if (!conversationId) return [];
  const dir = subagentsDir(cwd, conversationId);
  let names: string[];
  try { names = readdirSync(dir); } catch { return []; }
  const live: { file: string; id: string; lastWriteAt: number }[] = [];
  for (const name of names) {
    const m = AGENT_FILE_RE.exec(name);
    if (!m) continue;
    const file = join(dir, name);
    let st;
    try { st = statSync(file); } catch { continue; }
    if (now - st.mtimeMs > STALE_MS) continue; // nothing to ask the parent about
    live.push({ file, id: m[1], lastWriteAt: st.mtimeMs });
  }
  if (!live.length) return [];
  // Paid for only when some agent log is fresh — an idle conversation with a
  // year of finished agents under it never reads the parent at all.
  const notified = notifiedAt(readTail(join(claudeProjectDir(cwd), `${conversationId}.jsonl`), PARENT_TAIL));
  const out: SessionAgent[] = [];
  for (const a of live) {
    const stopped = notified.get(a.id);
    if (stopped !== undefined && stopped >= a.lastWriteAt) continue; // it ended, and the parent wrote that down
    const meta = readMeta(join(dir, `agent-${a.id}.meta.json`));
    let startedAt = a.lastWriteAt;
    try { startedAt = statSync(join(dir, `agent-${a.id}.meta.json`)).mtimeMs; } catch { /* keep the fallback */ }
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
