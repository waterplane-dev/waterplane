/**
 * The per-repo health index, kept current without being asked.
 *
 * The pure arithmetic is `shared/healthindex.ts`; this is the plumbing around
 * it: where the series file is, when the engine is run again, what is cached
 * for `/api/repos`, and the one push a called move earns.
 *
 *  - **Weekly refresh.** An hourly sweep runs `refreshRepoHealth` for every repo
 *    that already has a series file and whose last host refresh is over 7 days
 *    old — SEQUENTIALLY, never two engines at once. A repo with no series file
 *    is never started: measuring a repo for the first time is a person's tap.
 *  - **Boot computes without refreshing**, so the chip has a value at once.
 *  - **`/api/repos` reads the cache only** (`summaryFor`); the engine never runs
 *    in a request path. Unknown ⇒ absent, never 0. The cache is keyed to the
 *    series file's mtime+size: the file is also rewritten from OUTSIDE this
 *    host (a CLI re-cut, the VS Code extension), and a chip cached at boot
 *    then read "Health 112" beside an index view computing 98 off the file.
 *    A changed stamp re-derives the index from the file (one stat per call,
 *    no engine run).
 *  - **One push per repo per week**: `(week, kind)` last notified is persisted
 *    in `<STATE_DIR>/healthindex.json`, so a restart does not re-fire.
 *  - Failures degrade to absent + a reason, logged once; no push on error.
 *  - `WATERPLANE_HEALTH_WEEKLY=0` stops the refresh and the push (the chip and
 *    the route still read whatever series exists).
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  BRAND, LEGACY, assessHealthMove, healthIndex, healthMoveWords, isoWeekOf, logTag, repoHealthIndexOf,
  type HealthIndexResponse, type HealthSeriesRow, type RepoHealthIndex,
} from "@waterplane/shared";
import { hostStateDir } from "./branddirs.js";
import { contextLimitsFor } from "./compliance.js";
import { discoverTargets } from "./repos.js";
import { refreshRepoHealth } from "./repohealth.js";
import { env } from "./env.js";
import { readJsonGuarded, writeJsonAtomic } from "./jsonstore.js";

const SWEEP_MS = Math.max(5_000, Number(env("HEALTH_SWEEP_MS") || 60 * 60_000));
/** A repo is refreshed when its last refresh is older than this. */
export const HEALTH_REFRESH_MS = 7 * 24 * 60 * 60_000;
/** After a refresh that did not succeed, wait this long before trying that repo again. */
const RETRY_MS = 6 * 60 * 60_000;
export const SERIES_FILE = "repohealth.jsonl";

export interface HealthWatchDeps {
  root: string;
  /** Primary worktrees to consider. */
  repos(): Promise<{ id: string; repoName: string; worktreePath: string }[]>;
  /** Run the engine for one worktree; true when it finished cleanly. */
  refresh(wt: string): Promise<boolean>;
  /** The context-weight warn line for this repo, or null. */
  warnChars(wt: string): number | null;
  notify(kind: "health", p: { title: string; body: string; tag: string }): void;
  now?(): number;
  /** The series file's text, or null when there is none. Default: the real file. */
  readSeries?(wt: string): string | null;
  /** A cheap stamp of the series file (mtime+size), or null when there is
   *  none; a change makes `summaryFor` re-derive. Default: `stat` of the real file. */
  seriesStamp?(wt: string): string | null;
  /** Default: `WATERPLANE_HEALTH_WEEKLY !== "0"`. */
  enabled?(): boolean;
  /** The state file; default `<STATE_DIR>/healthindex.json`. */
  statePath?: string;
}

interface Stored { lastRefresh?: number; notified?: string }

/** The series file for a worktree: current state dir name first, then each legacy one. */
export function seriesPathOf(wt: string): string | null {
  for (const d of [BRAND.stateDirName, ...LEGACY.map((l) => l.stateDirName)]) {
    const p = join(wt, d, SERIES_FILE);
    if (existsSync(p)) return p;
  }
  return null;
}

function readSeriesFile(wt: string): string | null {
  const p = seriesPathOf(wt);
  if (!p) return null;
  try { return readFileSync(p, "utf8"); } catch { return null; }
}

function seriesStampOf(wt: string): string | null {
  const p = seriesPathOf(wt);
  if (!p) return null;
  try { const st = statSync(p); return `${st.mtimeMs}:${st.size}`; } catch { return null; }
}

function parseRows(text: string): HealthSeriesRow[] {
  const rows: HealthSeriesRow[] = [];
  for (const line of text.split("\n")) {
    const l = line.trim();
    if (!l) continue;
    try {
      const r = JSON.parse(l);
      if (r && typeof r === "object") rows.push(r as HealthSeriesRow);
    } catch { /* a torn line is one missing reading, not a dead series */ }
  }
  return rows;
}

const keyOf = (wt: string): string => { try { return realpathSync(wt); } catch { return wt; } };

export class HealthWatch {
  private state = new Map<string, Stored>();
  private cache = new Map<string, RepoHealthIndex>();
  /** The series stamp each cache entry was derived from ("none" = no file). */
  private stamps = new Map<string, string>();
  private lastAttempt = new Map<string, number>();
  private logged = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private sweeping = false;
  private path: string;

  constructor(private deps: HealthWatchDeps) {
    this.path = deps.statePath ?? join(hostStateDir(deps.root), "healthindex.json");
    const raw = readJsonGuarded<any>(this.path, null);
    for (const [wt, v] of Object.entries<any>(raw?.repos ?? {})) {
      if (!v || typeof v !== "object") continue;
      this.state.set(wt, {
        lastRefresh: Number.isFinite(v.lastRefresh) ? v.lastRefresh : undefined,
        notified: typeof v.notified === "string" ? v.notified : undefined,
      });
    }
  }

  private now(): number { return (this.deps.now ?? Date.now)(); }
  private weekly(): boolean { return (this.deps.enabled ?? (() => env("HEALTH_WEEKLY") !== "0"))(); }
  private text(wt: string): string | null { return (this.deps.readSeries ?? readSeriesFile)(wt); }
  private stamp(wt: string): string {
    try { return (this.deps.seriesStamp ?? seriesStampOf)(wt) ?? "none"; } catch { return "none"; }
  }

  /** Compute from existing series for every repo, WITHOUT refreshing; then start the sweep. */
  async start(): Promise<void> {
    if (this.timer) return;
    this.timer = setInterval(() => void this.sweep(), SWEEP_MS);
    this.timer.unref?.();
    try {
      for (const r of await this.deps.repos()) this.recompute(r.worktreePath);
    } catch (e) { this.logOnce("boot", e); }
    void this.sweep();
  }

  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }

  /**
   * The summary for `/api/repos`, or undefined. Served from the cache while the
   * series file is the one it was derived from; re-derived from the file (no
   * engine) when its stamp moved since — never a number older than the file.
   */
  summaryFor(wt: string): RepoHealthIndex | undefined {
    const k = keyOf(wt);
    if (this.stamps.get(k) !== this.stamp(wt)) this.recompute(wt);
    return this.cache.get(k);
  }

  /** The whole answer for the route, computed from the series file now (cheap, no engine). */
  respond(wt: string): HealthIndexResponse {
    const lr = this.state.get(keyOf(wt))?.lastRefresh;
    const lastRefresh = lr ? new Date(lr).toISOString() : null;
    try {
      const text = this.text(wt);
      if (text === null) return { series: null, move: null, words: null, lastRefresh, reason: "this repo has no repo-health series yet" };
      const series = healthIndex(parseRows(text), this.deps.warnChars(wt));
      if (!series) return { series: null, move: null, words: null, lastRefresh, reason: "no week has every enabled reading yet, so there is no baseline" };
      const move = assessHealthMove(series.points);
      return { series, move, words: healthMoveWords(series.points, move, isoWeekOf(new Date(this.now()).toISOString().slice(0, 10))), lastRefresh };
    } catch (e) {
      this.logOnce(wt, e);
      return { series: null, move: null, words: null, lastRefresh, reason: "the series could not be read" };
    }
  }

  /** Recompute one repo's cache from its series file. Returns the response used. */
  recompute(wt: string): HealthIndexResponse {
    const k = keyOf(wt);
    // Stamp BEFORE reading: a write landing mid-read leaves a stale stamp, so
    // the next call re-derives rather than keeping the half-old answer.
    this.stamps.set(k, this.stamp(wt));
    const r = this.respond(wt);
    const s = repoHealthIndexOf(r.series, r.move);
    if (s) this.cache.set(k, s); else this.cache.delete(k);
    return r;
  }

  private maybeNotify(wt: string, repoId: string, repoName: string, r: HealthIndexResponse): void {
    if (!this.weekly() || !r.series || !r.move?.kind || !r.words) return;
    const week = r.series.points[r.series.points.length - 1]?.week;
    if (!week) return;
    const k = keyOf(wt);
    const mark = `${week}:${r.move.kind}`;
    const st = this.state.get(k) ?? {};
    if (st.notified === mark) return;
    // Remember BEFORE sending: a crash between the two loses a push, never repeats one.
    this.state.set(k, { ...st, notified: mark });
    this.persist();
    const title = r.words.title.includes(repoName) ? r.words.title : `${repoName}: ${r.words.title}`;
    this.deps.notify("health", { title, body: r.words.body, tag: `health:${repoId}` });
  }

  /** Whether a repo with a series is due its weekly engine run. */
  due(wt: string): boolean {
    const k = keyOf(wt);
    const now = this.now();
    const last = this.state.get(k)?.lastRefresh;
    if (last !== undefined && now - last <= HEALTH_REFRESH_MS) return false;
    const tried = this.lastAttempt.get(k);
    return !(tried !== undefined && now - tried < RETRY_MS);
  }

  /** Note that a refresh succeeded elsewhere (the manual route) and recompute. */
  refreshed(wt: string): HealthIndexResponse {
    const k = keyOf(wt);
    this.state.set(k, { ...this.state.get(k), lastRefresh: this.now() });
    this.persist();
    return this.recompute(wt);
  }

  async sweep(): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      const repos = await this.deps.repos();
      for (const r of repos) {
        const wt = r.worktreePath;
        try {
          if (this.text(wt) === null) { this.cache.delete(keyOf(wt)); continue; }
          if (this.weekly() && this.due(wt)) {
            this.lastAttempt.set(keyOf(wt), this.now());
            let ok = false;
            try { ok = await this.deps.refresh(wt); } catch (e) { this.logOnce(wt, e); }
            if (ok) this.refreshed(wt);
          }
          this.maybeNotify(wt, r.id, r.repoName, this.recompute(wt));
        } catch (e) { this.logOnce(wt, e); }
      }
    } catch (e) { this.logOnce("sweep", e); } finally { this.sweeping = false; }
  }

  private logOnce(key: string, e: unknown): void {
    if (this.logged.has(key)) return;
    this.logged.add(key);
    console.log(`${logTag} health index · ${key}: ${e instanceof Error ? e.message : String(e)}`);
  }

  private persist(): void {
    try {
      mkdirSync(hostStateDir(this.deps.root), { recursive: true });
      const repos: Record<string, Stored> = {};
      for (const [k, v] of this.state) repos[k] = v;
      writeJsonAtomic(this.path, { version: 1, repos }, { space: 2 });
    } catch { /* an unwritable state dir means a re-notify after a restart, not a crash */ }
  }
}

/** The production wiring: the real discovery, engine and context-weight line. */
export function createHealthWatch(root: string, notify: HealthWatchDeps["notify"]): HealthWatch {
  return new HealthWatch({
    root, notify,
    repos: async () => (await discoverTargets(root)).filter((t) => t.isPrimary).map((t) => ({ id: t.id, repoName: t.repoName, worktreePath: t.worktreePath })),
    refresh: async (wt) => (await refreshRepoHealth(wt)).last?.ok === true,
    warnChars: (wt) => contextLimitsFor(wt).effective.maxChars ?? null,
  });
}
