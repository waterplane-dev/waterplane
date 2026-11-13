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
  AGENT_POINTS_CAP, AGENT_POINT_WEEKS, AGENT_SUB_POINTS_CAP, AGENT_READING_WEEKS, LOOK_RULE_TEXT, isAgentAbsent, repoSpendByWeek, seriesOf, transcriptDirName, type AgentPoint, type AgentPointsResponse, type AgentReadingAbsent, type AgentReadingsDoc, type AgentReadingsResponse,
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
const VERSION = 3;
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
    return this.resolve(repos).map((r) => ({ conv: r.conv, agents: r.subs.map((x) => x.e) }));
  }

  private resolve(repos: readonly string[]): { id: string; repo: string; conv: ConvSummary; subs: { id: string; e: AgentLogSummary }[] }[] {
    const want = new Set(repos);
    const repoSlugs = repos.map(transcriptDirName);
    const out: { id: string; repo: string; conv: ConvSummary; subs: { id: string; e: AgentLogSummary }[] }[] = [];
    for (const [slug, files] of Object.entries(this.store)) {
      if (!repoSlugs.some((r) => slugBelongs(slug, r))) continue;
      const agents = new Map<string, { id: string; e: AgentLogSummary }[]>();
      for (const [k, e] of Object.entries(files)) {
        if (!isAgent(e)) continue;
        const conv = k.split("/")[0]!;
        (agents.get(conv) ?? agents.set(conv, []).get(conv)!).push({ id: k, e });
      }
      for (const [k, e] of Object.entries(files)) {
        if (isAgent(e)) continue;
        // The record's own cwd decides, so `app-other` never lands in `app`
        // through the slug prefix; a log with no cwd counts only in the repo's own slug.
        const repo = e.w ? repoOfWorktree(e.w) : undefined;
        const belongs = repo !== undefined ? want.has(repo) : repoSlugs.includes(slug);
        if (belongs) out.push({ id: k, repo: repo ?? repos[0]!, conv: e, subs: agents.get(k) ?? [] });
      }
    }
    return out;
  }

  /**
   * Session points for these repos: one per conversation and one per subagent log that began inside
   * the last `AGENT_POINT_WEEKS` weeks, newest first, each kind cut to its own cap (the capped list holds fresh conversations only) (the oldest go; `cut`
   * says how many). A log with no dated record has no start time and is left out, not placed.
   * `capped: false` keeps every point (the weekly region folds them on the host, so a busy repo's
   * older weeks are medians over ALL their sessions; only the wire to the phone needs the caps).
   */
  points(repos: readonly string[], now: number, capped = true): { points: AgentPoint[]; cut: number } {
    const since = Date.parse(`${lastWeeks(now, AGENT_POINT_WEEKS)[0]}T00:00:00Z`);
    const all: AgentPoint[] = [];
    for (const { id, repo, conv, subs } of this.resolve(repos)) {
      if (conv.t0 !== undefined && conv.t0 >= since) all.push(pointOf(id, repo, conv.t0, conv.sr, { fresh: !conv.nf, headless: conv.nf === "headless", commit: !!conv.cm }));
      for (const { id: sid, e } of subs) {
        if (e.t0 !== undefined && e.t0 >= since) all.push(pointOf(sid, repo, e.t0, e.sr, { fresh: true, headless: false, sub: true }));
      }
    }
    all.sort((a, b) => b.t0 - a.t0);
    if (!capped) return { points: all, cut: 0 };
    // A headless, forked or continued conversation is no reading's session (`seriesReadingOf`, `derivedMarkers`
    // want `fresh`): it stays off the wire, so it neither spends the conversation cap nor moves `coverFrom`
    // (the axis start) for readings that never read it. `cut` counts only points a reading could have used.
    const convs = all.filter((p) => !p.sub && p.fresh), subs = all.filter((p) => p.sub);
    const keep = [...convs.slice(0, AGENT_POINTS_CAP), ...subs.slice(0, AGENT_SUB_POINTS_CAP)].sort((a, b) => b.t0 - a.t0);
    return { points: keep, cut: convs.length + subs.length - keep.length };
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

function pointOf(id: string, repo: string, t0: number, sr: ConvSummary["sr"], f: { fresh: boolean; headless: boolean; commit?: boolean; sub?: boolean }): AgentPoint {
  return {
    id, t0, repo, fresh: f.fresh, headless: f.headless,
    ...(f.sub ? { sub: true } : {}),
    ...(sr?.md ? { model: sr.md } : {}), ...(sr?.cli ? { cli: sr.cli } : {}),
    ...(sr?.st !== undefined ? { start: sr.st } : {}),
    ...(sr?.pt ? { parts: sr.pt } : {}),
    ...(sr?.lk !== undefined ? { look: sr.lk } : {}),
    req: sr?.rq ?? 0,
    ...(f.commit !== undefined ? { commit: f.commit } : {}),
  };
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

/** The token ledger's day rows for the spend reading — a warm read, as the health line's;
 *  a ledger that fails is a sentence on that reading, never the answer's error. */
export async function agentLedger(read: () => Promise<{ days: Parameters<typeof repoSpendByWeek>[0] }>): Promise<{ days: Parameters<typeof repoSpendByWeek>[0] } | AgentReadingAbsent> {
  try { return { days: (await read()).days }; } catch (e) {
    return { absent: `The token ledger could not be read: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** The route's whole answer. */
export async function agentReadingsFor(
  store: AgentReadingsStore, worktree: string, backlog: readonly BacklogItem[] | null, now = Date.now(), waitMs = SWEEP_WAIT_MS,
  /** The token ledger's day rows, or why they could not be read; omitted = no spend reading at all. */
  ledger?: { days: Parameters<typeof repoSpendByWeek>[0] } | AgentReadingAbsent,
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
    ...(ledger ? { spend: isAgentAbsent(ledger) ? ledger : repoSpendByWeek(ledger.days, repos) } : {}),
  };
  const doc: AgentReadingsDoc = {
    ok: true,
    repo: repos[0]!,
    // Start, looks and requests are the agent series' weekly buckets (the token-stats card's
    // function), over EVERY point, not the capped list the points route sends the phone: a cap
    // would leave an old week with a median over its newest sessions, or none at all.
    weeks: foldAgentWeeks(store.conversations(repos), lastWeeks(now, AGENT_READING_WEEKS), escaped,
      seriesOf(store.points(repos, now, false).points, { grain: "week" })),
    rules: RULES,
    scannedAt: swept.at, logs: swept.logs, reread: swept.reread,
  };
  return doc;
}

/**
 * The points route's whole answer, for one repo (`worktrees` = its one worktree) or every repo the
 * host knows (`worktrees` = each repo's primary path). Same sweep-with-a-wait as the readings.
 */
export async function agentPointsFor(store: AgentReadingsStore, worktrees: readonly string[], now = Date.now(), waitMs = SWEEP_WAIT_MS): Promise<AgentPointsResponse> {
  const repos = [...new Set(worktrees.flatMap(repoSpellings))];
  let swept;
  try {
    const sweep = store.sweep(repos);
    sweep.catch(() => {});
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<null>((r) => { timer = setTimeout(() => r(null), waitMs); });
    swept = await Promise.race([sweep, late]).finally(() => clearTimeout(timer));
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  if (!swept) return { ok: false, pending: true, error: "This desktop is reading its conversation logs for the first time. It carries on in the background; read again in a minute." };
  const { points, cut } = store.points(repos, now);
  return { ok: true, points, cut, repos, rules: { look: LOOK_RULE_TEXT }, scannedAt: swept.at, logs: swept.logs, reread: swept.reread };
}
