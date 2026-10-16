/**
 * Every conversation log on this machine, summarised per file and cached — the
 * extension's copy of the host's token store (`tokenstats.ts`'s
 * `TokenStatsStore`), same shape (`Files`, version 5), same refresh rule.
 *
 * A refresh is a STAT sweep: a file whose size and mtime are both unchanged is
 * kept as it was; anything that moved is re-read WHOLE by the host's own
 * `summarizeLog` (the duplicate rule needs the file's whole id set, so an
 * appended read cannot be trusted); a file that went is dropped. A cold scan of
 * ~9k logs is seconds, so it is async, yields every `YIELD_EVERY` reads and
 * reports progress, and the result is cached in the extension's global storage
 * so the next window opens warm.
 */
import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { summarizeLog, walkLogs } from "../../../host/src/tokenscan.js";
import type { Files } from "../../../host/src/costwindow.js";

/** A single log this big is not read (`tokenstats.ts`' `MAX_FILE`). */
const MAX_FILE = 256 * 1024 * 1024;
/** Logs re-read between yields to the event loop (`tokenstats.ts`' `YIELD_EVERY`). */
const YIELD_EVERY = 64;
/** The store format. A different version on disk is discarded and rebuilt — it is a cache of logs still there. */
const VERSION = 5;

export type { Files };

/** What the last refresh found, for the corpus doc's footer. */
export interface ScanStats { scannedAt: number; logs: number; reread: number }

/** The per-file summaries of every Claude Code log under `<config dir>/projects`, cached in one JSON file. */
export class TokenStore {
  private cacheFile: string;
  private store: Files = {};
  private inFlight: Promise<ScanStats> | null = null;
  /** The last refresh's counts; `scannedAt` 0 until one has run. */
  stats: ScanStats = { scannedAt: 0, logs: 0, reread: 0 };

  /** `cacheFile` = where the summaries persist (the extension's globalStorageUri). Nothing is read until `load()`. */
  constructor(cacheFile: string) {
    this.cacheFile = cacheFile;
  }

  /** The summaries as of the last refresh (or load): slug → path below it, no extension → summary. */
  get files(): Files {
    return this.store;
  }

  /** Read the cache file. A missing, corrupt or other-version file leaves the store empty — the next refresh rebuilds it. */
  async load(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.cacheFile, "utf8")) as { v?: number; store?: Files; stats?: ScanStats };
      if (raw?.v === VERSION && raw.store && typeof raw.store === "object") {
        this.store = raw.store;
        if (raw.stats && typeof raw.stats.scannedAt === "number") this.stats = raw.stats;
      }
    } catch { /* absent or corrupt: rebuilt from the logs, which are the source anyway */ }
  }

  /** Write the cache file atomically (temp file + rename), so a window closing mid-write leaves the old copy. */
  async save(): Promise<void> {
    await mkdir(dirname(this.cacheFile), { recursive: true });
    const tmp = `${this.cacheFile}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify({ v: VERSION, store: this.store, stats: this.stats }));
    await rename(tmp, this.cacheFile);
  }

  /**
   * Walk `<configDir>/projects`, re-read whatever moved, drop whatever went.
   * Concurrent callers share one walk. `onProgress(done, total)` is called after
   * each project directory's stat sweep and every re-read, `total` being the
   * logs found so far. A machine with no projects directory is an EMPTY store,
   * never the stale one.
   */
  refresh(configDir: string, onProgress?: (done: number, total: number) => void): Promise<ScanStats> {
    this.inFlight ??= this.walk(configDir, onProgress).finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  private async walk(configDir: string, onProgress?: (done: number, total: number) => void): Promise<ScanStats> {
    const root = join(configDir, "projects");
    const next: Files = {};
    let logs = 0;
    let reread = 0;
    let done = 0;
    let slugs: string[];
    try {
      slugs = (await readdir(root, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
    } catch { slugs = []; }

    for (const slug of slugs) {
      const prev = this.store[slug] ?? {};
      // Recursive: a third of the spend is in `<conversation>/subagents/`.
      const rels = await walkLogs(join(root, slug));
      const stats = await Promise.all(rels.map((rel) => stat(join(root, slug, rel)).catch(() => null)));
      logs += rels.length;
      onProgress?.(done, logs);
      for (let i = 0; i < rels.length; i++) {
        const rel = rels[i];
        const st = stats[i];
        done++;
        if (!st || st.size === 0 || st.size > MAX_FILE) continue;
        const key = rel.replace(/\.jsonl$/, "");
        const m = Math.round(st.mtimeMs);
        const was = prev[key];
        if (was && was.s === st.size && was.m === m) {
          (next[slug] ??= {})[key] = was;
          continue;
        }
        const sum = await summarizeLog(join(root, slug, rel), st.size, m);
        reread++;
        if (sum) (next[slug] ??= {})[key] = { ...sum, ...(rel.includes("/subagents/") ? { sub: 1 as const } : {}) };
        onProgress?.(done, logs);
        if (reread % YIELD_EVERY === 0) await new Promise((r) => setImmediate(r));
      }
    }
    this.store = next;
    this.stats = { scannedAt: Date.now(), logs, reread };
    onProgress?.(logs, logs);
    return this.stats;
  }
}
