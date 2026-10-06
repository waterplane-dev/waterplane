/**
 * Background shells under a session, read off the process table — what
 * `SessionInfo.shellList` is built from.
 *
 * `agents.ts`'s `readCliStatus` already says a session HAS shells (the CLI's
 * own `~/.claude/sessions/<pid>.json`, `status: "shell"`); that record holds
 * no count, no command, no age. The wrapper the CLI spawns for a
 * `run_in_background` Bash or a Monitor is a distinctive shape on `ps`:
 *
 *   /bin/zsh -c source ~/.claude/shell-snapshots/snapshot-zsh-<stamp>.sh …
 *     && eval '<CMD>' < /dev/null && pwd -P >| /tmp/claude-XXXX-cwd
 *
 * a direct child of the CLI's pid, in its OWN process group (`pgid === pid`),
 * with no tty. MCP servers and `caffeinate` are also CLI children but share
 * the CLI's own pgid, so `pgid !== cliPid` alone is what keeps them out — no
 * name-based exclusion needed.
 *
 * Best-effort throughout, like every reader in this file's family
 * (`agents.ts`, `screenlog.ts`): a `ps` that cannot be read, a transcript
 * that will not join, an output file that was never written — every one of
 * those costs a FIELD, never the row, and `readShellList` itself degrades to
 * `undefined` (absent — "could not read") rather than a guess, kept apart
 * from `[]` ("read, and there are none").
 */
import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { basename, join } from "node:path";
import type { SessionShell, SessionShellDetail } from "@waterplane/shared";
import { selfMatchOf, serverLikeOf } from "@waterplane/shared";
import { readTail } from "./agents.js";
import { stripAnsi } from "./prompt.js";
import { claudeProjectDir, transcriptPath } from "./transcript.js";
import { env } from "./env.js";
import { sleep as procSleep } from "./proc.js";

/** `WATERPLANE_SHELLS=0` turns the whole reader off — the list stays absent, same
 *  as a `ps` that failed to run. */
export function shellsEnabled(): boolean {
  return env("SHELLS") !== "0";
}

/** A pathological session must not turn a status poll into a wall of rows. */
export const MAX_SHELLS = 12;

// ── `ps -axo pid=,ppid=,pgid=,etime=,time=,command=` ────────────────────────

export interface PsRow {
  pid: number;
  ppid: number;
  pgid: number;
  /** Elapsed wall-clock time, in seconds — `ps`'s own `etime`. */
  etimeSec: number;
  /** Cumulative CPU time, in ms — `ps`'s own `time`. */
  cpuMs: number;
  command: string;
}

const PS_LINE_RE = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.*)$/;

/** `[[dd-]hh:]mm:ss` → seconds. Undefined on anything that doesn't parse —
 *  never a guessed age. */
export function parseEtimeSec(raw: string): number | undefined {
  let days = 0;
  let rest = raw.trim();
  const dash = rest.indexOf("-");
  if (dash !== -1) {
    days = Number(rest.slice(0, dash));
    rest = rest.slice(dash + 1);
  }
  const parts = rest.split(":").map(Number);
  if (!Number.isFinite(days) || parts.some((n) => !Number.isFinite(n))) return undefined;
  let secs: number;
  if (parts.length === 2) secs = parts[0] * 60 + parts[1];
  else if (parts.length === 3) secs = parts[0] * 3600 + parts[1] * 60 + parts[2];
  else return undefined;
  return days * 86400 + secs;
}

/** `mm:ss.cc` (arbitrary-width minutes, macOS's usual shape) or `hh:mm:ss` →
 *  milliseconds. Undefined on anything that doesn't parse. */
export function parseCpuMs(raw: string): number | undefined {
  const parts = raw.trim().split(":");
  if (parts.length === 2) {
    const m = Number(parts[0]);
    const s = Number(parts[1]);
    if (!Number.isFinite(m) || !Number.isFinite(s)) return undefined;
    return Math.round((m * 60 + s) * 1000);
  }
  if (parts.length === 3) {
    const h = Number(parts[0]);
    const m = Number(parts[1]);
    const s = Number(parts[2]);
    if (![h, m, s].every(Number.isFinite)) return undefined;
    return Math.round((h * 3600 + m * 60 + s) * 1000);
  }
  return undefined;
}

/** Pure: fixture text in, rows out — this is what `shells.test.mjs` pins
 *  against real `ps` output captured on this desktop. */
export function parsePsTable(text: string): PsRow[] {
  const out: PsRow[] = [];
  for (const line of text.split("\n")) {
    const m = PS_LINE_RE.exec(line);
    if (!m) continue;
    const etimeSec = parseEtimeSec(m[4]);
    const cpuMs = parseCpuMs(m[5]);
    if (etimeSec === undefined || cpuMs === undefined) continue;
    out.push({ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), etimeSec, cpuMs, command: m[6] });
  }
  return out;
}

let psMemo: { at: number; rows: PsRow[] } | null = null;
const PS_MEMO_MS = 2000;

/** `fresh: true` bypasses the 2s memo — `killShellGroup` must never act on a
 *  stale reading of who is still alive. */
export function readPsTable(fresh = false): PsRow[] {
  if (!fresh && psMemo && Date.now() - psMemo.at < PS_MEMO_MS) return psMemo.rows;
  const out = execFileSync("ps", ["-axo", "pid=,ppid=,pgid=,etime=,time=,command="], {
    encoding: "utf8", maxBuffer: 8 * 1024 * 1024, timeout: 3000, stdio: ["ignore", "pipe", "ignore"],
    // `etime=` is `[[dd-]hh:]mm:ss` everywhere we know, but force the C locale anyway.
    env: { ...process.env, LC_ALL: "C", LANG: "C" },
  });
  const rows = parsePsTable(out);
  psMemo = { at: Date.now(), rows };
  return rows;
}

// ── The wrapper discriminator + its group ───────────────────────────────────

const WRAPPER_RE = /shell-snapshots\/snapshot-/;

/** `ppid === cliPid && pgid !== cliPid && the CLI's own shell-wrapper shape`
 *  — see the module doc for why `pgid !== cliPid` alone keeps out MCP
 *  servers and `caffeinate`, which are CLI children too but share its pgid. */
export function isShellWrapper(row: PsRow, cliPid: number): boolean {
  return row.ppid === cliPid && row.pgid !== cliPid && WRAPPER_RE.test(row.command);
}

/** Utility programs that make up a shell's OWN plumbing, never a real worker.
 *  Matched on the basename of the command's first token, case-insensitively. */
const WORKER_EXCLUDE = new Set(["sleep", "tail", "head", "zsh", "sh", "bash", "cat", "grep", "wc", "cut"]);

function programOf(command: string): string {
  const first = command.trim().split(/\s+/)[0] ?? "";
  const base = first.split("/").pop() ?? first;
  return base.toLowerCase();
}

export interface ShellGroup {
  wrapper: PsRow;
  /** Every live descendant, transitively, staying inside the wrapper's own
   *  pgid — a child that escaped into a pgid of its own is not followed. */
  members: PsRow[];
  /** `members` minus the sleep/pipeline utilities — the real workers. */
  workers: PsRow[];
}

/** One group per wrapper shell found under `cliPid`. */
export function shellsUnder(cliPid: number, rows: PsRow[]): ShellGroup[] {
  const byPpid = new Map<number, PsRow[]>();
  for (const r of rows) {
    const list = byPpid.get(r.ppid);
    if (list) list.push(r); else byPpid.set(r.ppid, [r]);
  }
  const groups: ShellGroup[] = [];
  for (const wrapper of rows) {
    if (!isShellWrapper(wrapper, cliPid)) continue;
    const members: PsRow[] = [];
    const stack = [wrapper.pid];
    while (stack.length) {
      const cur = stack.pop()!;
      for (const kid of byPpid.get(cur) ?? []) {
        if (kid.pgid !== wrapper.pgid) continue;
        members.push(kid);
        stack.push(kid.pid);
      }
    }
    const workers = members.filter((m) => !WORKER_EXCLUDE.has(programOf(m.command)));
    groups.push({ wrapper, members, workers });
  }
  return groups;
}

// ── The eval'd command text ──────────────────────────────────────────────

const EVAL_START = "&& eval '";
const EVAL_END = "' < /dev/null";

function capText(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/**
 * The text between `&& eval '` and `' < /dev/null`, unescaped and capped at
 * 240 characters — `SessionShell.command`. Undefined when the wrapper's own
 * command line does not have that shape (a `ps` truncation, a CLI version
 * that wraps differently), in which case the caller falls back to the raw
 * command capped the same way.
 */
export function evalText(command: string): string | undefined {
  const full = evalTextFull(command);
  return full === undefined ? undefined : capText(full, 240);
}

/** `evalText` uncapped — `readShellDetail`, the one reader asked for the
 *  whole command by a person rather than shipped on every `SessionInfo`. */
export function evalTextFull(command: string): string | undefined {
  const s = command.indexOf(EVAL_START);
  if (s === -1) return undefined;
  const start = s + EVAL_START.length;
  const e = command.indexOf(EVAL_END, start);
  if (e === -1) return undefined;
  const raw = command.slice(start, e);
  return raw.split("'\\''").join("'").split(`'"'"'`).join("'");
}

function normalizeWs(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

// ── CPU tracking across polls ────────────────────────────────────────────

interface CpuTrack { cpuMs: number; movedAt?: number }
const cpuTrack = new Map<number, CpuTrack>();

/**
 * Record this poll's aggregate `cpuMs` for `pid` (the wrapper's own pid — the
 * stable identity across the whole group's churn of short-lived workers) and
 * answer `movedAt`: `undefined` on the FIRST ever reading of this pid (there
 * is nothing yet to compare against — the honest "can't tell yet"), the
 * previous `movedAt` unchanged when the reading repeats, `now` when it moved.
 */
export function trackCpu(map: Map<number, CpuTrack>, pid: number, cpuMs: number, now: number): number | undefined {
  const prev = map.get(pid);
  if (!prev) { map.set(pid, { cpuMs }); return undefined; }
  if (cpuMs !== prev.cpuMs) prev.movedAt = now;
  prev.cpuMs = cpuMs;
  return prev.movedAt;
}

/** Drop tracked pids that are no longer wrapper shells anywhere — otherwise
 *  the map grows for as long as the host runs. */
export function pruneCpuTrack(map: Map<number, CpuTrack>, livePids: Set<number>): void {
  for (const pid of map.keys()) if (!livePids.has(pid)) map.delete(pid);
}

// ── The transcript join: taskId, description, launch ────────────────────

export interface ShellTranscriptFact {
  command: string;
  description?: string;
  taskId: string;
  launch: "background" | "timeout";
}

const BG_ID_RE = /Command running in background with ID: ([A-Za-z0-9]+)/;
const MOVED_RE = /was moved to the background \(ID: ([A-Za-z0-9]+)\)/;

interface ResultBlock { type?: string; text?: string }
function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((b) => (b && typeof b === "object" ? (b as ResultBlock).text ?? "" : "")).join("\n");
  }
  return "";
}

/**
 * Every backgrounded Bash call this tail of the conversation log can prove,
 * by matching each `tool_use`'s own `tool_use_id` to its `tool_result` — the
 * CLI's own pairing, not a guess. A tool_result whose text names neither
 * pattern is not a background command and is dropped.
 */
export function shellTranscriptFacts(tail: string): ShellTranscriptFact[] {
  const pending = new Map<string, { command: string; description?: string }>();
  const out: ShellTranscriptFact[] = [];
  for (const line of tail.split("\n")) {
    if (!line.trim().startsWith("{")) continue;
    let rec: { message?: { content?: unknown } };
    try { rec = JSON.parse(line); } catch { continue; }
    const content = rec.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content as Record<string, unknown>[]) {
      if (block?.type === "tool_use" && block.name === "Bash") {
        const input = block.input as { command?: string; description?: string } | undefined;
        if (typeof input?.command === "string" && typeof block.id === "string") {
          pending.set(block.id, { command: input.command, description: input.description });
        }
      } else if (block?.type === "tool_result" && typeof block.tool_use_id === "string") {
        const call = pending.get(block.tool_use_id);
        if (!call) continue;
        const text = resultText(block.content);
        const bg = BG_ID_RE.exec(text);
        const moved = MOVED_RE.exec(text);
        if (bg) out.push({ command: call.command, description: call.description, taskId: bg[1], launch: "background" });
        else if (moved) out.push({ command: call.command, description: call.description, taskId: moved[1], launch: "timeout" });
      }
    }
  }
  return out;
}

/** The fact whose (whitespace-normalised, 240-capped) command matches this
 *  shell's own eval'd text — the join key, since nothing else ties a `ps` pid
 *  to a transcript record. */
export function joinShellFact(evalCommand: string, facts: ShellTranscriptFact[]): ShellTranscriptFact | undefined {
  const key = normalizeWs(capText(evalCommand, 240));
  return facts.find((f) => normalizeWs(capText(f.command, 240)) === key);
}

// ── The task's own output file ───────────────────────────────────────────

function procUid(): number | null {
  return typeof process.getuid === "function" ? process.getuid() : null;
}

/** Where the CLI writes a background task's output. Every part comes from the
 *  host's own reads (cwd, the conversation id, the transcript join's taskId),
 *  never from a client. */
export function shellOutputPath(cwd: string, conversationId: string, taskId: string): string | undefined {
  const uid = procUid();
  if (uid === null) return undefined;
  const slug = basename(claudeProjectDir(cwd));
  return join("/private/tmp", `claude-${uid}`, slug, conversationId, "tasks", `${taskId}.output`);
}

/** `/private/tmp/claude-<uid>/<slug>/<conv>/tasks/<taskId>.output`, stat'd
 *  only — never read. `undefined` on anything that doesn't resolve or isn't
 *  there, and the size is only ever reported past 0 bytes: most of these
 *  commands redirect their own output, so a 0-byte file is silence by
 *  design, never "read and found empty". */
export function shellOutputStat(cwd: string, conversationId: string, taskId: string): { outputAt: number; outputBytes: number } | undefined {
  const path = shellOutputPath(cwd, conversationId, taskId);
  if (!path) return undefined;
  try {
    const st = statSync(path);
    if (st.size <= 0) return undefined;
    return { outputAt: st.mtimeMs, outputBytes: st.size };
  } catch { return undefined; }
}

// ── Assembly ──────────────────────────────────────────────────────────────

/**
 * Every background shell running under `cliPid`, or `undefined` when the
 * process table could not be read at all (`WATERPLANE_SHELLS=0`, or a throw) — kept
 * apart from `[]`, which means the read succeeded and there are none.
 *
 * `cliStatus` is the CLI's own record status (`readCliRecord`'s `"shell"` or
 * `"busy"` — the only two this is ever called under) and is what tells a
 * background shell from the running turn's OWN foreground command: a live
 * FOREGROUND Bash call has the exact same `ps` shape as a backgrounded one
 * (`isShellWrapper` cannot tell them apart on its own), so a wrapper is only
 * read as background when the conversation-log join PROVES it (a `launch`
 * fact) or the main loop is idle (`"shell"` — nothing under an idle main loop
 * can be the current turn, so every wrapper left is a survivor). An unjoined
 * wrapper while the CLI still says `"busy"` is marked `foreground: true`
 * instead.
 */
export function readShellList(
  cliPid: number, cwd: string, claudeSessionId: string | undefined, cliStatus: string | null, now = Date.now(),
): SessionShell[] | undefined {
  if (!shellsEnabled()) return undefined;
  let rows: PsRow[];
  try { rows = readPsTable(); } catch { return undefined; }
  const groups = shellsUnder(cliPid, rows).slice(0, MAX_SHELLS);
  pruneCpuTrack(cpuTrack, new Set(rows.map((r) => r.pid)));
  if (!groups.length) return [];

  let facts: ShellTranscriptFact[] = [];
  if (claudeSessionId) {
    try {
      const tail = readTail(transcriptPath(cwd, claudeSessionId), 512 * 1024);
      facts = tail ? shellTranscriptFacts(tail) : [];
    } catch { facts = []; }
  }

  const out: SessionShell[] = [];
  for (const { wrapper, workers } of groups) {
    const command = evalText(wrapper.command) ?? capText(wrapper.command, 240);
    const totalCpuMs = wrapper.cpuMs + workers.reduce((sum, w) => sum + w.cpuMs, 0);
    const cpuMovedAt = trackCpu(cpuTrack, wrapper.pid, totalCpuMs, now);
    const startedAt = now - wrapper.etimeSec * 1000;

    const sh: SessionShell = {
      pid: wrapper.pid,
      startedAt,
      command,
      cpuMs: totalCpuMs,
      workers: workers.length,
    };
    if (cpuMovedAt !== undefined) sh.cpuMovedAt = cpuMovedAt;
    if (selfMatchOf(command)) sh.selfMatch = true;
    if (serverLikeOf(command)) sh.serverLike = true;

    const fact = claudeSessionId ? joinShellFact(command, facts) : undefined;
    if (fact) {
      if (fact.description) sh.description = fact.description;
      sh.taskId = fact.taskId;
      sh.launch = fact.launch;
      if (claudeSessionId) {
        const outStat = shellOutputStat(cwd, claudeSessionId, fact.taskId);
        if (outStat) { sh.outputAt = outStat.outputAt; sh.outputBytes = outStat.outputBytes; }
      }
    } else if (cliStatus !== "shell") {
      // No transcript proof this was ever launched to the background, and the
      // main loop is not idle either — this wrapper is the running turn's own
      // foreground command wearing the discriminator's shape, not a
      // background shell a person could stop from here.
      sh.foreground = true;
    }
    out.push(sh);
  }
  return out;
}

// ── One shell, opened by a person ────────────────────────────────────────

/** How much of a shell's output file one open reads — the tail, since what a
 *  person opening a running shell wants is what it is printing NOW. */
export const SHELL_OUTPUT_TAIL = 64 * 1024;

/** A progress bar redraws its line with `\r`; keep what the line finally
 *  said, the way a terminal would show it, then drop the escapes. */
export function cleanShellOutput(raw: string): string {
  const lines = raw.replace(/\r\n/g, "\n").split("\n").map((l) => {
    const t = l.replace(/\r+$/, "");
    const i = t.lastIndexOf("\r");
    return i === -1 ? t : t.slice(i + 1);
  });
  return stripAnsi(lines.join("\n"));
}

/**
 * The whole command and the tail of the output for ONE background shell of
 * this CLI — `GET /api/shell`. `null` when `pid` is not, right now, one of
 * this CLI's wrapper shells: the pid is the client's, so it only ever selects
 * among `shellsUnder(cliPid)`, never names an arbitrary process. The output
 * file's path is built from the transcript join, never from the request.
 */
export function readShellDetail(
  cliPid: number, cwd: string, claudeSessionId: string | undefined, pid: number,
): SessionShellDetail | null {
  let rows: PsRow[];
  try { rows = readPsTable(); } catch { return null; }
  const group = shellsUnder(cliPid, rows).find((g) => g.wrapper.pid === pid);
  if (!group) return null;
  const command = evalTextFull(group.wrapper.command) ?? group.wrapper.command;
  const out: SessionShellDetail = { pid, command };

  let fact: ShellTranscriptFact | undefined;
  if (claudeSessionId) {
    try {
      const tail = readTail(transcriptPath(cwd, claudeSessionId), 512 * 1024);
      fact = tail ? joinShellFact(command, shellTranscriptFacts(tail)) : undefined;
    } catch { fact = undefined; }
  }
  if (fact?.description) out.description = fact.description;
  if (!fact || !claudeSessionId) {
    out.outputWhy = "no output file — the CLI's log has no background-task record for this command, so there is no task id to find it by";
    return out;
  }
  const path = shellOutputPath(cwd, claudeSessionId, fact.taskId);
  if (!path) { out.outputWhy = "no output file — this desktop has no uid to find it under"; return out; }
  out.outputPath = path;
  let st;
  try { st = statSync(path); } catch {
    out.outputWhy = "the CLI has not written an output file for this task";
    return out;
  }
  const raw = readTail(path, SHELL_OUTPUT_TAIL);
  if (raw === null) { out.outputWhy = "the output file could not be read"; return out; }
  out.outputBytes = st.size;
  out.outputAt = st.mtimeMs;
  // A tail read can start mid-line (and mid-character): drop that first part line.
  let text = raw;
  if (st.size > SHELL_OUTPUT_TAIL) {
    out.truncated = true;
    const nl = text.indexOf("\n");
    if (nl !== -1) text = text.slice(nl + 1);
  }
  out.output = cleanShellOutput(text);
  return out;
}

// ── Foreground, without the summary-only work ───────────────────────────

/**
 * Which of `cliPid`'s wrapper shells are the running turn's OWN command
 * (`foreground`), off an already-read `rows` table — the same discriminator
 * `readShellList` applies per row, without the CPU tracking, output stat or
 * `MAX_SHELLS` cap a KILL pass has no use for. Used by `drive.ts`'s
 * `stopShellsUnder` so a session close never signals the turn's own command.
 */
export function foregroundWrapperPids(
  cliPid: number, rows: PsRow[], cwd: string, claudeSessionId: string | undefined, cliStatus: string | null,
): Set<number> {
  const out = new Set<number>();
  const groups = shellsUnder(cliPid, rows);
  if (!groups.length) return out;
  let facts: ShellTranscriptFact[] = [];
  if (claudeSessionId) {
    try {
      const tail = readTail(transcriptPath(cwd, claudeSessionId), 512 * 1024);
      facts = tail ? shellTranscriptFacts(tail) : [];
    } catch { facts = []; }
  }
  for (const { wrapper } of groups) {
    const command = evalText(wrapper.command) ?? capText(wrapper.command, 240);
    const fact = claudeSessionId ? joinShellFact(command, facts) : undefined;
    if (!fact && cliStatus !== "shell") out.add(wrapper.pid);
  }
  return out;
}

// ── Kill ──────────────────────────────────────────────────────────────────

const sleep = (ms: number): Promise<void> => procSleep(ms, { unref: true });

/** Injectable seams — real `ps`/`kill`/`sleep` by default, swapped out by
 *  `shells.test.mjs` to drive the whole refusal ladder (ppid mismatch,
 *  pgid !== pid, startedAt drift, already gone, a survivor) with no real OS
 *  process tree, and by `stopShellsUnder` to share ONE fresh precondition
 *  read across a whole close pass instead of one per group. */
export interface KillShellDeps {
  /** The precondition table — defaults to a fresh `readPsTable(true)` read.
   *  The checks AFTER signalling always read fresh again on their own: they
   *  happen at a different real moment than this one, and per group, so
   *  sharing THIS table only removes the redundant read every group used to
   *  take before it had even sent a signal. */
  rows?: PsRow[];
  readPs?: () => PsRow[];
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Stop one shell's WHOLE process group — SIGTERM, then SIGKILL after 3s for
 * whatever in the group is still alive (CLAUDE.md's decision: closing stops
 * shells fully, and so does a per-row stop).
 *
 * The precondition read is a FRESH process table (never the 2s memo — acting
 * on a stale "still there" is exactly the failure the memo exists to risk
 * elsewhere) unless the caller already took one this pass (`deps.rows`), and
 * every precondition is checked against it: the pid must still be a wrapper
 * directly under THIS cli, still be its own group leader, and its start time
 * must still be within 2s of the one the caller last saw — a pid the OS
 * recycled onto an unrelated process is refused, not signalled. The SAME
 * ppid check is repeated right before the SIGKILL, over a row read AFTER the
 * SIGTERM, for the same reason — a recycled pid must not be signalled just
 * because an unrelated new process happens to now share the old pgid. And the
 * verdict is never a guess: a final fresh read says whether the group is
 * actually gone, and a survivor comes back `ok: false`, never `true`.
 */
export async function killShellGroup(
  cliPid: number, pid: number, startedAt: number, now = Date.now(), deps: KillShellDeps = {},
): Promise<{ ok: boolean; reason?: string }> {
  const readPs = deps.readPs ?? (() => readPsTable(true));
  const kill = deps.kill ?? ((p, sig) => process.kill(p, sig));
  const doSleep = deps.sleep ?? sleep;

  let rows: PsRow[];
  if (deps.rows) {
    rows = deps.rows;
  } else {
    try { rows = readPs(); } catch { return { ok: false, reason: "the desktop could not read its own process table" }; }
  }
  const row = rows.find((r) => r.pid === pid);
  if (!row) return { ok: false, reason: "that shell has already ended" };
  if (row.ppid !== cliPid || row.pgid !== pid) return { ok: false, reason: `pid ${pid} is no longer under this session — not touched` };
  const rowStartedAt = now - row.etimeSec * 1000;
  if (Math.abs(rowStartedAt - startedAt) > 2000) return { ok: false, reason: "that shell has already ended" };

  try {
    kill(-pid, "SIGTERM");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return { ok: false, reason: "that shell has already ended" };
    return { ok: false, reason: `the desktop refused: ${code ?? "unknown error"}` };
  }

  await doSleep(3000);
  let after: PsRow[] = [];
  try { after = readPs(); } catch { /* best-effort survivor check */ }
  if (after.some((r) => r.pgid === pid)) {
    // Re-check the wrapper is still ours before SIGKILLing its group — see
    // the doc comment above.
    const wrapperRow = after.find((r) => r.pid === pid);
    if (!wrapperRow || wrapperRow.ppid === cliPid) {
      try { kill(-pid, "SIGKILL"); } catch { /* already gone */ }
    }
    let after2: PsRow[] = [];
    try { after2 = readPs(); } catch { /* best-effort */ }
    if (after2.some((r) => r.pgid === pid)) {
      return { ok: false, reason: "that shell did not stop" };
    }
  }
  return { ok: true };
}
