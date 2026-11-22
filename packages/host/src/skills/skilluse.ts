/**
 * How often each skill was used in ONE repo, counted off the CLI's conversation logs.
 *
 * "In this repo" is by construction: only the project directories handed in (the primary
 * worktree and its linked ones) are read, and the answer is never summed across repos.
 * A per-file summary is cached by mtime+size like `tokenscan.ts`, so only a log that moved is
 * re-read. Counts are ABSENT while a scan runs and when no project directory exists — never
 * a partial number presented as complete. A skill name is matched to the inventory at READ
 * time, so the cache does not depend on which skills are installed.
 */
import { existsSync, renameSync } from "node:fs";
import { open, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { addLocalDays } from "@waterplane/shared";
import { JsonShards, readJsonGuarded } from "../jsonstore.js";
import { SCAN_CHUNK, walkLogs } from "../tokenscan.js";

export const SKILLUSE_VERSION = 1;
const SLICE_MS = 8;
/** Days of per-day detail kept per file (one more than the 30 the screen shows). */
const KEEP_DAYS = 31;
const breathe = () => new Promise<void>((r) => setImmediate(r));

type Bag = Record<string, number>;
export interface UseFile {
  m: number; s: number;
  /** Skill tool calls, all time / typed `/name`, all time. */
  all: Bag; typedAll: Bag;
  /** Last KEEP_DAYS days only: day -> {skill: n} and day -> {typed: n}. */
  day?: Record<string, Bag>; typedDay?: Record<string, Bag>;
}
interface Store { version: number; files: Record<string, UseFile> }

/** One shard's body: the store VERSION it was written at, and one project dir's summaries (log path -> summary). */
interface DirShard { v: number; files: Record<string, UseFile> }
const isDirShard = (b: unknown): b is DirShard =>
  typeof b === "object" && b !== null && (b as DirShard).v === SKILLUSE_VERSION && typeof (b as DirShard).files === "object" && (b as DirShard).files !== null;

/**
 * The shard a log belongs to: its project directory. A conversation's subagent logs live in
 * `<project>/<conversation>/subagents[/workflows/<wf>]/`, so that tail is stripped: thousands of
 * conversations must not become thousands of files. Decided from the path alone, so a load, a
 * scan and the migration of the old single file all agree.
 */
export function useShardKey(logPath: string): string {
  return dirname(logPath).replace(/\/[^/]+\/subagents(\/.*)?$/, "");
}

export interface SkillCounts { d30: number; all: number; typed30: number; typedAll: number }
export interface SkillUseReading {
  state: "ready" | "counting" | "absent";
  done?: number; total?: number; why?: string;
  /** `ready` on the previous scan's counts while a newer scan is still reading the logs: ask again. */
  refreshing?: boolean;
  /** Present only when `ready`: counts for the inventory ids that have any use. Others are 0. */
  uses?: Record<string, SkillCounts>;
}

const add = (b: Bag, k: string) => { b[k] = (b[k] ?? 0) + 1; };
const addDay = (m: Record<string, Bag>, d: string, k: string) => add((m[d] ??= {}), k);
const COMMAND = /<command-name>\/?([^<\s]+)<\/command-name>/;
const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Substring a raw log line holds when it may carry a Skill call (the pre-filter). */
export const SKILL_CALL_MARK = '"name":"Skill"';

/**
 * The ONE definition of "a skill use": the `Skill` tool_use blocks of an assistant row, each with
 * its call id (callers dedupe by it: a streamed reply writes its blocks on several rows) and the
 * skill's name without a leading slash. The skills screen's counts and the agent readings' skill
 * loads both ask this.
 */
export function skillCallsOf(row: any): { id: string; name: string }[] {
  const out: { id: string; name: string }[] = [];
  if (row?.type !== "assistant" || !Array.isArray(row.message?.content)) return out;
  for (const b of row.message.content) {
    if (b?.type !== "tool_use" || b.name !== "Skill" || typeof b.input?.skill !== "string" || typeof b.id !== "string") continue;
    out.push({ id: b.id, name: b.input.skill.replace(/^\//, "") });
  }
  return out;
}

/** Read one log into its summary. Null when unreadable. */
export async function summarizeUse(path: string, size: number, mtime: number, now: number, chunk = SCAN_CHUNK): Promise<UseFile | null> {
  const all: Bag = {}, typedAll: Bag = {};
  const day: Record<string, Bag> = {}, typedDay: Record<string, Bag> = {};
  const seen = new Set<string>();
  const keepFrom = dayOf(addLocalDays(now, -KEEP_DAYS));
  const recent = mtime >= addLocalDays(now, -KEEP_DAYS);
  const handle = (line: string): void => {
    if (line.charCodeAt(0) !== 123) return;
    const isSkill = line.includes(SKILL_CALL_MARK);
    const isCmd = line.includes("<command-name>");
    if (!isSkill && !isCmd) return;
    let row: any;
    try { row = JSON.parse(line); } catch { return; }
    const d = typeof row.timestamp === "string" ? row.timestamp.slice(0, 10) : "";
    const inWindow = recent && d >= keepFrom && /^\d{4}-\d\d-\d\d$/.test(d);
    if (isSkill && row.type === "assistant" && Array.isArray(row.message?.content)) {
      for (const { id, name } of skillCallsOf(row)) {
        if (seen.has(id)) continue;
        seen.add(id);
        add(all, name);
        if (inWindow) addDay(day, d, name);
      }
    } else if (isCmd && row.type === "user") {
      const c = row.message?.content;
      const text = typeof c === "string" ? c : Array.isArray(c) ? c.map((x: any) => (typeof x?.text === "string" ? x.text : "")).join("\n") : "";
      const m = COMMAND.exec(text);
      if (!m) return;
      const key = typeof row.uuid === "string" ? row.uuid : "";
      if (key) { if (seen.has(key)) return; seen.add(key); }
      add(typedAll, m[1]);
      if (inWindow) addDay(typedDay, d, m[1]);
    }
  };
  let fh;
  try { fh = await open(path, "r"); } catch { return null; }
  try {
    let carry: Buffer = Buffer.alloc(0);
    let pos = 0;
    let since = performance.now();
    while (pos < size) {
      const want = Math.min(chunk, size - pos);
      const buf = Buffer.allocUnsafe(want);
      const { bytesRead } = await fh.read(buf, 0, want, pos);
      if (bytesRead <= 0) break;
      pos += bytesRead;
      const got = buf.subarray(0, bytesRead);
      const joined = carry.length ? Buffer.concat([carry, got]) : got;
      const nl = joined.lastIndexOf(10);
      if (nl < 0) { carry = joined; continue; }
      carry = joined.subarray(nl + 1);
      for (const line of joined.toString("utf8", 0, nl).split("\n")) {
        handle(line);
        if (performance.now() - since > SLICE_MS) { await breathe(); since = performance.now(); }
      }
    }
    handle(carry.toString("utf8"));
  } catch { return null; } finally { await fh.close().catch(() => {}); }
  return {
    m: mtime, s: size, all, typedAll,
    ...(Object.keys(day).length ? { day } : {}), ...(Object.keys(typedDay).length ? { typedDay } : {}),
  };
}

const sum = (b: Bag | undefined, k: string) => b?.[k] ?? 0;
function since30(days: Record<string, Bag> | undefined, k: string, from: string): number {
  let n = 0;
  if (days) for (const [d, b] of Object.entries(days)) if (d >= from) n += sum(b, k);
  return n;
}

export interface SkillUseOpts { file: string; now?: () => number; chunk?: number; /** Wall-clock ms a finished scan is kept (default `FRESH_MS`). */ freshMs?: number }
interface Run { done: number; total: number; finished: boolean; failedWhy?: string; /** When it finished. */ at?: number;
  /** The finished, successful run this one replaces: `read()` serves its counts while this one scans. */ prev?: Run }
/** A finished scan answers `read()` as it stands for this long; `kick()` starts no new one inside it. */
export const FRESH_MS = 30_000;
/** The run key of the all-repos scan; never a repo id (those are paths or slugs, never start with a NUL). */
const ALL_KEY = "\u0000all";

export class SkillUseStore {
  private store: Store = { version: SKILLUSE_VERSION, files: {} };
  private shards: JsonShards;
  private runs = new Map<string, Run>();
  private opts: SkillUseOpts;
  constructor(opts: SkillUseOpts) {
    this.opts = opts;
    // One file per project dir beside `opts.file`. A shard of another VERSION is ignored: that dir is re-scanned.
    this.shards = new JsonShards(join(dirname(opts.file), "skilluse"));
    for (const body of this.shards.load().values()) if (isDirShard(body)) Object.assign(this.store.files, body.files);
    this.migrate();
  }

  /** Seed the dirs that have no shard yet from the pre-shard single file, write them, and set the file aside as `.migrated` (kept). A failed shard write leaves the file in place. */
  private migrate(): void {
    const legacy = this.opts.file;
    try {
      if (!existsSync(legacy)) return;
      const raw = readJsonGuarded<Store | null>(legacy, null);
      if (raw && raw.version === SKILLUSE_VERSION && raw.files && typeof raw.files === "object") {
        const have = new Set(Object.keys(this.store.files).map(useShardKey));
        for (const [p, f] of Object.entries(raw.files)) {
          const k = useShardKey(p);
          if (have.has(k) || !f || typeof f !== "object") continue;
          this.store.files[p] = f;
          this.shards.mark(k);
        }
      }
      if (this.flush().failed) return;
      // A corrupt file was already moved aside by `readJsonGuarded`; another VERSION seeds nothing and is set aside all the same.
      if (existsSync(legacy)) renameSync(legacy, `${legacy}.migrated`);
    } catch { /* a cache: the logs rebuild whatever was not seeded */ }
  }

  /** One dir's shard body, or undefined (the file is removed) when no summary is left in it. `groups` is one grouping of the store, built once per flush. */
  private bodyOf(key: string, groups: Map<string, Record<string, UseFile>>): DirShard | undefined {
    const files = groups.get(key);
    return files ? { v: SKILLUSE_VERSION, files } : undefined;
  }
  private flush(): { written: number; removed: number; failed: number } {
    if (!this.shards.pending) return { written: 0, removed: 0, failed: 0 };
    const groups = new Map<string, Record<string, UseFile>>();
    for (const [p, f] of Object.entries(this.store.files)) {
      const k = useShardKey(p);
      let g = groups.get(k);
      if (!g) groups.set(k, (g = {}));
      g[p] = f;
    }
    return this.shards.flush((k) => this.bodyOf(k, groups));
  }

  private now() { return (this.opts.now ?? Date.now)(); }

  /**
   * Start (or keep) a background scan of these project dirs, single-flight per key. A scan that
   * finished within `FRESH_MS` is kept: a new run would make the very next `read()` answer
   * `counting` again, so a screen that kicks on every request would never see `ready`.
   */
  kick(key: string, dirs: string[]): void {
    const cur = this.runs.get(key);
    if (cur && (!cur.finished || (cur.at !== undefined && Date.now() - cur.at < (this.opts.freshMs ?? FRESH_MS)))) return;
    const run: Run = { done: 0, total: 0, finished: false };
    if (cur && cur.finished && !cur.failedWhy) run.prev = cur;
    this.runs.set(key, run);
    void this.scan(run, dirs).catch((e) => { run.failedWhy = String((e as Error)?.message ?? e); }).finally(() => { run.at = Date.now(); run.finished = true; run.prev = undefined; });
  }

  private async scan(run: Run, dirs: string[]): Promise<void> {
    const paths: string[] = [];
    for (const dir of dirs) for (const rel of await walkLogs(dir)) paths.push(join(dir, rel));
    run.total = paths.length;
    let dirty = false;
    for (const p of paths) {
      let st;
      try { st = await stat(p); } catch { run.done++; continue; }
      const have = this.store.files[p];
      if (!have || have.m !== st.mtimeMs || have.s !== st.size) {
        const sum = await summarizeUse(p, st.size, st.mtimeMs, this.now(), this.opts.chunk);
        if (sum) { this.store.files[p] = sum; this.shards.mark(useShardKey(p)); dirty = true; }
      }
      run.done++;
    }
    if (dirty) this.save();
  }

  private save(): void {
    // Only the dirs a scan changed are written; a failed shard stays dirty and a ledger that cannot save just re-scans.
    try { this.flush(); } catch { /* re-scans */ }
  }

  /** What the screen may show for this key. `dirs` decide which cached files belong to it. */
  read(key: string, dirs: string[], ids: string[]): SkillUseReading {
    const existing = dirs.filter((d) => this.hasDir(d));
    let run = this.runs.get(key);
    // A refresh in flight never hides counts the store already holds complete.
    const refreshing = !!(run && !run.finished && run.prev);
    if (run && !run.finished && run.prev) { run = run.prev; }
    if (run && !run.finished) return { state: "counting", done: run.done, total: run.total };
    if (!run) return { state: "counting", done: 0, total: 0 };
    if (run.failedWhy) return { state: "absent", why: "The usage scan failed." };
    if (!existing.length && run.total === 0) return { state: "absent", why: "No Claude logs for this repo on this desktop." };
    const from = dayOf(addLocalDays(this.now(), -30));
    const prefixes = dirs.map((d) => (d.endsWith("/") ? d : `${d}/`));
    const uses: Record<string, SkillCounts> = {};
    const idSet = new Set(ids);
    for (const [p, f] of Object.entries(this.store.files)) {
      if (!prefixes.some((x) => p.startsWith(x))) continue;
      for (const id of idSet) {
        const all = sum(f.all, id), typedAll = sum(f.typedAll, id);
        if (!all && !typedAll) continue;
        const c = (uses[id] ??= { d30: 0, all: 0, typed30: 0, typedAll: 0 });
        c.all += all; c.typedAll += typedAll;
        c.d30 += since30(f.day, id, from); c.typed30 += since30(f.typedDay, id, from);
      }
    }
    for (const id of idSet) uses[id] ??= { d30: 0, all: 0, typed30: 0, typedAll: 0 };
    return { state: "ready", uses, ...(refreshing ? { refreshing: true } : {}) };
  }

  /** Every repo on this desktop: `projects` is the CLI's projects folder, walked as one dir. */
  readAll(projects: string, ids: string[]): SkillUseReading {
    this.kick(ALL_KEY, [projects]);
    const r = this.read(ALL_KEY, [projects], ids);
    return r.state === "absent" && r.why?.startsWith("No Claude logs") ? { state: "absent", why: "No Claude logs on this desktop." } : r;
  }

  private hasDir(d: string): boolean {
    const pre = d.endsWith("/") ? d : `${d}/`;
    return Object.keys(this.store.files).some((p) => p.startsWith(pre));
  }
}
