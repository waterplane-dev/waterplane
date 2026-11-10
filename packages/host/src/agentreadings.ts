/**
 * Agent readings: per-repo weekly figures only this desktop can take, because
 * it keeps every claude conversation that ran in the repo
 * (`GET /api/repos/:id/agentreadings`; DTO `shared/wire/agentreadings.ts`).
 * The rules are `agentclass.ts`'s, the disk reading `agentscan.ts`'s.
 *
 * ── Bounded cost ────────────────────────────────────────────────────────────
 *
 * `tokenstats.ts`'s store pattern, cut to ONE repo at a time: the store is
 * per-LOG summaries keyed by project directory and relative path, persisted
 * through `jsonstore.ts` (`writeJsonAtomic`, debounced, flushed on demand;
 * `readJsonGuarded`, a corrupt file moved aside and rebuilt from the logs),
 * and the weekly readings are DERIVED on every answer — no running aggregate
 * to drift. A request walks only the project directories whose slug is the
 * repo's (or one of its worktrees'), `stat`s each log and re-reads only the
 * ones whose size or mtime moved; within `MAX_AGE_MS` of the last sweep it
 * walks nothing at all. So the first open of a repo reads its logs once, and
 * every later open costs a stat sweep of that repo's logs only — never a
 * re-scan of every transcript on the machine.
 *
 * Every reading degrades to ABSENT with its sentence: an unreadable project
 * directory is an error answer, never a week of zeros.
 */
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  AGENT_READING_WEEKS, transcriptDirName, type AgentReadingAbsent, type AgentReadingsDoc, type AgentReadingsResponse,
  type BacklogItem,
} from "@waterplane/shared";
import { RULES, countByWeek, foldAgentWeeks, lastWeeks, type AgentLogSummary, type ConvSummary, type EscapedInputs, type ResolvedConv } from "./agentclass.js";
import { summarizeAgentLog, summarizeConv } from "./agentscan.js";
import { hostStateDir } from "./branddirs.js";
import { claudeConfigDir } from "./claudeconfig.js";
import { repoOfWorktree } from "./costwindow.js";
import { exposureCrashMarks } from "./exposure.js";
import { readJsonGuarded, writeJsonAtomic } from "./jsonstore.js";
import { walkLogs } from "./tokenscan.js";

/** Bump when a summary's shape or a classification rule changes: the store then rebuilds from the logs. */
const VERSION = 2;
const MAX_FILE = 256 * 1024 * 1024;
const FLUSH_MS = 5_000;
const YIELD_EVERY = 32;
/** A repo swept this recently is answered from the store without touching the disk. */
export const MAX_AGE_MS = 10 * 60_000;
/** How long an answer waits for a sweep before saying it is still reading. */
export const SWEEP_WAIT_MS = 8_000;

type Entry = ConvSummary | (AgentLogSummary & { sub: 1 });
/** slug → path relative to the slug's directory (without `.jsonl`) → summary. */
type Store = Record<string, Record<string, Entry>>;

const isAgent = (e: Entry): e is AgentLogSummary & { sub: 1 } => (e as { sub?: 1 }).sub === 1;

/** Whether a project directory slug can hold this repo's logs: the repo's own, or a worktree's under it. */
export function slugBelongs(slug: string, repoSlug: string): boolean {
  return slug === repoSlug || slug.startsWith(`${repoSlug}-`);
}

export class AgentReadingsStore {
  private path: string;
  private store: Store = {};
  private timer: NodeJS.Timeout | null = null;
  private dirty = false;
  private swept = new Map<string, { at: number; logs: number; reread: number }>();
  private inFlight = new Map<string, Promise<void>>();

  /** `birthOf` is the file's creation time for the fork test; a test with dated fixtures passes `() => undefined`. */
  constructor(stateDir: string, private birthOf: (st: { birthtimeMs: number }) => number | undefined = (st) => (st.birthtimeMs > 0 ? Math.round(st.birthtimeMs) : undefined)) {
    mkdirSync(stateDir, { recursive: true });
    this.path = join(stateDir, "agentreadings.json");
    try {
      if (existsSync(this.path)) {
        const raw = readJsonGuarded<{ v?: number; store?: Store } | null>(this.path, null);
        if (raw?.v === VERSION && raw.store && typeof raw.store === "object") this.store = raw.store;
      }
    } catch { /* rebuilt from the logs, which are the source anyway */ }
  }

  /** Bring this repo's summaries up to date (unless swept within `maxAgeMs`). Throws only on an unreadable projects directory. */
  async sweep(repos: readonly string[], maxAgeMs = MAX_AGE_MS): Promise<{ at: number; logs: number; reread: number }> {
    const key = repos.join("\0");
    const last = this.swept.get(key);
    if (last && Date.now() - last.at < maxAgeMs) return last;
    let p = this.inFlight.get(key);
    if (!p) {
      p = this.refresh(key, repos).finally(() => this.inFlight.delete(key));
      this.inFlight.set(key, p);
    }
    await p;
    return this.swept.get(key)!;
  }

  private async refresh(key: string, repos: readonly string[]): Promise<void> {
    const root = join(claudeConfigDir(), "projects");
    let slugs: string[];
    try {
      slugs = (await readdir(root, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code === "ENOENT") slugs = [];
      else throw new Error(`The claude projects directory could not be read: ${(e as Error).message}`);
    }
    const repoSlugs = repos.map(transcriptDirName);
    const mine = slugs.filter((s) => repoSlugs.some((r) => slugBelongs(s, r)));
    let logs = 0;
    let reread = 0;
    for (const slug of mine) {
      const prev = this.store[slug] ?? {};
      const next: Record<string, Entry> = {};
      const rels = await walkLogs(join(root, slug));
      const stats = await Promise.all(rels.map((rel) => stat(join(root, slug, rel)).catch(() => null)));
      for (let i = 0; i < rels.length; i++) {
        const rel = rels[i]!;
        const st = stats[i];
        if (!st || st.size === 0 || st.size > MAX_FILE) continue;
        const parts = rel.split("/");
        const top = parts.length === 1;
        // Only conversations and their agents: `<id>.jsonl` and `<id>/subagents/…/agent-*.jsonl`.
        if (!top && !(parts[1] === "subagents" && parts[parts.length - 1]!.startsWith("agent-"))) continue;
        logs++;
        const k = rel.replace(/\.jsonl$/, "");
        const was = prev[k];
        const mtime = Math.round(st.mtimeMs);
        if (was && was.s === st.size && was.m === mtime) { next[k] = was; continue; }
        const path = join(root, slug, rel);
        const sum = top
          ? await summarizeConv(path, k, st.size, mtime, undefined, this.birthOf(st))
          : await summarizeAgentLog(path, rel, st.size, mtime).then((s) => (s ? { ...s, sub: 1 as const } : null));
        reread++;
        if (reread % YIELD_EVERY === 0) await new Promise((r) => setImmediate(r));
        if (sum) next[k] = sum;
      }
      this.store[slug] = next;
    }
    // A slug of this repo that is gone from disk is gone from the fold.
    for (const slug of Object.keys(this.store)) {
      if (repoSlugs.some((r) => slugBelongs(slug, r)) && !mine.includes(slug)) delete this.store[slug];
    }
    this.swept.set(key, { at: Date.now(), logs, reread });
    this.dirty = true;
    this.schedule();
  }

  /** This repo's conversations with their agents. `repos` are the repo's path spellings (as given, realpath). */
  conversations(repos: readonly string[]): ResolvedConv[] {
    const want = new Set(repos);
    const repoSlugs = repos.map(transcriptDirName);
    const out: ResolvedConv[] = [];
    for (const [slug, files] of Object.entries(this.store)) {
      if (!repoSlugs.some((r) => slugBelongs(slug, r))) continue;
      const agents = new Map<string, AgentLogSummary[]>();
      for (const [k, e] of Object.entries(files)) {
        if (!isAgent(e)) continue;
        const conv = k.split("/")[0]!;
        (agents.get(conv) ?? agents.set(conv, []).get(conv)!).push(e);
      }
      for (const [k, e] of Object.entries(files)) {
        if (isAgent(e)) continue;
        // The record's own cwd decides, so `app-other` never lands in `app`
        // through the slug prefix; a log with no cwd counts only in the repo's own slug.
        const belongs = e.w ? want.has(repoOfWorktree(e.w)) : repoSlugs.includes(slug);
        if (belongs) out.push({ conv: e, agents: agents.get(k) ?? [] });
      }
    }
    return out;
  }

  private schedule(): void {
    if (this.timer || !this.dirty) return;
    this.timer = setTimeout(() => { this.timer = null; this.flush(); }, FLUSH_MS);
    this.timer.unref?.();
  }

  flush(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (!this.dirty) return;
    try {
      writeJsonAtomic(this.path, { v: VERSION, store: this.store });
      this.dirty = false;
    } catch { /* a readings cache is not worth taking the daemon down for */ }
  }
}

/** The backlog's bug items for this repo, by the week they were added — or why there is no count. */
export function bugsByWeek(items: readonly BacklogItem[] | null, repos: readonly string[]): Record<string, number> | AgentReadingAbsent {
  if (!items) return { absent: "The backlog could not be read." };
  const want = new Set(repos);
  const mine = items.filter((i) => want.has(repoOfWorktree(i.repoDir)));
  if (!mine.length) return { absent: "This repo has nothing on the backlog." };
  if (!mine.some((i) => i.category)) return { absent: "No backlog item in this repo has a category yet, so bugs cannot be told apart." };
  return countByWeek(mine.filter((i) => i.category === "bug").map((i) => i.createdAt));
}

/** The repo's path spellings: as given, and its realpath (the CLI records the realpath). */
export function repoSpellings(worktree: string): string[] {
  const repo = repoOfWorktree(worktree);
  let real = repo;
  try { real = realpathSync(repo); } catch { /* as given */ }
  return [...new Set([repo, real])];
}

let shared: AgentReadingsStore | null = null;
/** The one store for this host (created on first use, in the host's state dir). */
export function agentReadingsStore(root: string): AgentReadingsStore {
  return (shared ??= new AgentReadingsStore(hostStateDir(root)));
}

/** The route's whole answer. */
export async function agentReadingsFor(
  store: AgentReadingsStore, worktree: string, backlog: readonly BacklogItem[] | null, now = Date.now(), waitMs = SWEEP_WAIT_MS,
): Promise<AgentReadingsResponse> {
  const repos = repoSpellings(worktree);
  let swept;
  try {
    // A repo's FIRST sweep reads every one of its logs (measured: 33 s for
    // 16,000 logs on the owner's desktop). The answer does not wait past
    // `waitMs`; the sweep carries on and the next ask is answered from the store.
    const sweep = store.sweep(repos);
    sweep.catch(() => {});
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<null>((r) => { timer = setTimeout(() => r(null), waitMs); });
    swept = await Promise.race([sweep, late]).finally(() => clearTimeout(timer));
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  if (!swept) {
    return { ok: false, pending: true, error: "This desktop is reading this repo's conversation logs for the first time. It carries on in the background; read again in a minute." };
  }
  const crash = exposureCrashMarks(worktree);
  const escaped: EscapedInputs = {
    crash: "why" in crash ? { absent: crash.why } : countByWeek(crash.at),
    bugs: bugsByWeek(backlog, repos),
  };
  const doc: AgentReadingsDoc = {
    ok: true,
    repo: repos[0]!,
    weeks: foldAgentWeeks(store.conversations(repos), lastWeeks(now, AGENT_READING_WEEKS), escaped),
    rules: RULES,
    scannedAt: swept.at, logs: swept.logs, reread: swept.reread,
  };
  return doc;
}
