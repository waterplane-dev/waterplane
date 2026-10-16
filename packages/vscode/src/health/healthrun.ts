/**
 * The repo-health lifecycle, vscode-free: runs the bundled engine (`dist/healthworker.mjs`) in a
 * worker_threads Worker, one step at a time, and keeps one `HealthDoc` per folder.
 *
 *  - `read`    = status → plot. Read-only; cached 60 s per folder unless forced.
 *  - `refresh` = update → status → plot. SINGLE-FLIGHT per folder: the series file is append-only,
 *    and two concurrent updates would append the same rows twice, permanently.
 *  - `forget`  = delete OUR series file, then refresh. The only mutation besides `update`'s append.
 *
 * The steps are a closed union and the argv is `[step, "--root=" + folder]`, plus `--scope=` on a
 * read of a folder's scope. A series the waterplane desktop app already measured in the folder
 * (`healthsource.ts`) is READ by status/plot through `..._HEALTH_READ_FROM`; `update` and the tail
 * mend never see it. Our own series lives under `storageDir/<healthSlug(folder)>/` (the worker's `WATERPLANE_VSCODE_HEALTH_DIR`),
 * never in the folder. A step past `stepMs()` is terminated; rows `update` had already appended
 * (every 25 commits) stay, and the next refresh carries on from them.
 */
import { mkdirSync, rmSync } from "node:fs";
import { delimiter, join } from "node:path";
import { Worker } from "node:worker_threads";
import { envName, parseRepoHealthProgress } from "@waterplane/shared";
import type { HealthDoc, HealthRunState } from "../protocol.js";
import { chooseSource, readScopes, repoSeriesDir } from "./healthsource.js";
import type { HealthSource } from "./healthsource.js";
import { foldHealth, gitOnPath, isShallow, NO_GIT_WHY } from "./healthdoc.js";
import type { HealthStepResult, HealthUpdateResult } from "./healthdoc.js";
import { healthSlug } from "./healthslug.js";
import { healthIndexOfFile } from "./healthindexdoc.js";
import { mendSeriesTail, TORN_TAIL_NOTE } from "./seriestail.js";

export type HealthStep = "status" | "plot" | "update";

export interface HealthRunDeps {
  /** Absolute path of `dist/healthworker.mjs`. */
  workerFile: string;
  /** `<globalStorage>/health`; each folder's series goes in a subdirectory of it. */
  storageDir: string;
  /** The per-step cap (the `waterplane.healthSeconds` setting, in ms). */
  stepMs: () => number;
  /** The directory of VS Code's `git.path`, or null. Searched before PATH and prepended to it. */
  extraPath: () => string | null;
  onChange: (folder: string) => void;
  now?: () => number;
}

const READ_CACHE_MS = 60_000;
/** `waterplane.healthSeconds`'s default (package.json says the same): a first measure of a long history is minutes. */
export const DEFAULT_HEALTH_SECONDS = 600;
const SERIES_NAME = "repohealth.jsonl";

interface Slot {
  doc: HealthDoc | null;
  why?: string;
  run: HealthRunState | null;
  readAt: number;
  update: HealthUpdateResult | null;
  flight: { kind: "read" | "refresh"; p: Promise<void> } | null;
  /** A refresh asked for while a read was in flight. */
  queued: Promise<void> | null;
  worker: Worker | null;
  cancelled: boolean;
  /** Set when a torn last row was cut off; cleared once an `update` has run clean (it re-measured it). */
  tailNote: string | null;
  /** The scope the person picked (a folder's, read-only); null = the whole repo. */
  scope: string | null;
  /** Where the last read came from. */
  source: HealthSource | null;
  scopes: string[];
}

/**
 * The only variables the worker sees: what git needs to find itself and its config (PATH; HOME or
 * USERPROFILE; XDG_CONFIG_HOME for a config kept there — its `safe.directory` included), what
 * Windows needs to start a process at all (SYSTEMROOT), the locale, and a temp dir. No GIT_*:
 * an inherited GIT_DIR or GIT_WORK_TREE would point every command at another repository.
 */
const ENV_KEEP = new Set(["PATH", "HOME", "USERPROFILE", "SYSTEMROOT", "XDG_CONFIG_HOME", "LANG", "LC_ALL", "TMPDIR", "TEMP", "TMP"]);

export function workerEnv(from: Record<string, string | undefined>, healthDir: string, extraPath: string | null, readFrom: string | null = null): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(from)) if (v !== undefined && ENV_KEEP.has(k.toUpperCase())) env[k] = v;
  env[envName("VSCODE_HEALTH_DIR")] = healthDir;
  if (readFrom) env[envName("VSCODE_HEALTH_READ_FROM")] = readFrom;
  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
  if (extraPath) env[pathKey] = [extraPath, env[pathKey]].filter(Boolean).join(delimiter);
  return env;
}

/** The folder's whole-repo series file when the desktop app left one there. */
function repoFileOf(folder: string): string | null {
  const dir = repoSeriesDir(folder);
  return dir ? join(dir, SERIES_NAME) : null;
}

export class HealthRun {
  private readonly slots = new Map<string, Slot>();
  private disposed = false;
  private readonly now: () => number;

  constructor(private readonly d: HealthRunDeps) {
    this.now = d.now ?? Date.now;
  }

  state(folder: string): { doc: HealthDoc | null; why?: string; run: HealthRunState | null } {
    const s = this.slots.get(folder);
    if (!s) return { doc: null, run: null };
    return s.why !== undefined ? { doc: s.doc, why: s.why, run: s.run } : { doc: s.doc, run: s.run };
  }

  /** The series file this folder's runs write. */
  seriesFile(folder: string): string {
    return join(this.d.storageDir, healthSlug(folder), SERIES_NAME);
  }

  /** Show one of the folder's scopes (null = whole repo): a forced, read-only read. */
  async setScope(folder: string, scope: string | null): Promise<void> {
    const s = this.slot(folder);
    s.scope = scope !== null && readScopes(folder).includes(scope) ? scope : null;
    if (s.flight) await s.flight.p.catch(() => {});
    if (this.disposed) return;
    return this.read(folder, { force: true });
  }

  read(folder: string, opts: { force?: boolean } = {}): Promise<void> {
    const s = this.slot(folder);
    if (s.flight) return s.flight.p;
    if (!opts.force && s.doc && this.now() - s.readAt < READ_CACHE_MS) return Promise.resolve();
    return this.fly(s, folder, "read", () => this.readSteps(s, folder));
  }

  refresh(folder: string): Promise<void> {
    const s = this.slot(folder);
    if (s.flight?.kind === "refresh") return s.flight.p;
    if (s.queued) return s.queued;
    if (s.flight) {
      // A read is in flight: let it finish, then measure. Every caller meanwhile joins this one.
      // `cancel` drops it by clearing `s.queued`: a stop pressed during the read stops the measure too.
      const q: Promise<void> = s.flight.p.then(() => {
        const still = s.queued === q;
        if (still) s.queued = null;
        return still && !this.disposed ? this.refresh(folder) : undefined;
      });
      s.queued = q;
      return q;
    }
    return this.fly(s, folder, "refresh", () => this.refreshSteps(s, folder));
  }

  async forget(folder: string): Promise<void> {
    const s = this.slot(folder);
    if (s.flight) {
      this.cancel(folder);
      await s.flight?.p.catch(() => {});
    }
    if (this.disposed) return;
    rmSync(this.seriesFile(folder), { force: true });
    s.update = null;
    s.doc = null;
    await this.refresh(folder);
  }

  cancel(folder: string): void {
    const s = this.slots.get(folder);
    if (!s?.flight) return;
    s.queued = null;
    s.cancelled = true;
    void s.worker?.terminate();
  }

  dispose(): void {
    this.disposed = true;
    for (const folder of this.slots.keys()) this.cancel(folder);
  }

  // ── internals ────────────────────────────────────────────────────────────

  private slot(folder: string): Slot {
    let s = this.slots.get(folder);
    if (!s) {
      s = { doc: null, run: null, readAt: 0, update: null, flight: null, queued: null, worker: null, cancelled: false, tailNote: null, scope: null, source: null, scopes: [] };
      this.slots.set(folder, s);
    }
    return s;
  }

  private fly(s: Slot, folder: string, kind: "read" | "refresh", body: () => Promise<void>): Promise<void> {
    if (this.disposed) return Promise.resolve();
    s.cancelled = false;
    const p = (async () => {
      try {
        await body();
      } finally {
        s.flight = null;
        s.worker = null;
        s.run = null;
        s.cancelled = false;
        this.d.onChange(folder);
      }
    })();
    s.flight = { kind, p };
    return p;
  }

  /** null = git is there (and the env to run with); a string = why nothing can run. */
  private envFor(folder: string): { env: Record<string, string | undefined> } | { why: string } {
    const extra = this.d.extraPath();
    const gitDir = gitOnPath(process.env, extra);
    if (!gitDir) return { why: NO_GIT_WHY };
    const dir = join(this.d.storageDir, healthSlug(folder));
    mkdirSync(dir, { recursive: true });
    return { env: workerEnv(process.env, dir, extra) };
  }

  /** Cut a torn last row off before the engine reads the file (`seriestail.ts`). */
  private mendTail(s: Slot, folder: string): void {
    if (mendSeriesTail(this.seriesFile(folder)) === "cut") s.tailNote = TORN_TAIL_NOTE;
  }

  private async readSteps(s: Slot, folder: string): Promise<void> {
    const e = this.envFor(folder);
    if ("why" in e) return this.noGit(s);
    this.mendTail(s, folder);
    await this.readWith(s, folder, e.env);
  }

  private async refreshSteps(s: Slot, folder: string): Promise<void> {
    const e = this.envFor(folder);
    if ("why" in e) return this.noGit(s);
    this.mendTail(s, folder);
    const startedAt = this.now();
    const u = await this.step(s, folder, "update", e.env);
    s.update = { ...u, at: this.now(), ms: this.now() - startedAt };
    if (u.code === 0) s.tailNote = null; // the dropped row is back in the series
    else this.mendTail(s, folder); // a cut update can tear the tail itself
    // Cut or refused, the rows already on disk are still worth reading back. A stop pressed
    // during update ends the run here and reads once more — status and plot are cheap.
    s.cancelled = false;
    await this.readWith(s, folder, e.env);
  }

  /** status → plot against the chosen source. `base` has no READ_FROM, and `update` is never given one. */
  private async readWith(s: Slot, folder: string, base: Record<string, string | undefined>): Promise<void> {
    s.scopes = readScopes(folder);
    if (s.scope && !s.scopes.includes(s.scope)) s.scope = null;
    const src = chooseSource(folder, this.seriesFile(folder), s.scope);
    s.source = src;
    const env = src.dir ? { ...base, [envName("VSCODE_HEALTH_READ_FROM")]: src.dir } : base;
    const args = src.scope ? ["--scope=" + src.scope] : [];
    const status = await this.step(s, folder, "status", env, args);
    if (status.cancelled) return; // keep the previous doc: a stopped read read nothing
    const pre = foldHealth(this.foldIn(s, folder, status, null));
    const plot = pre.doc?.series ? await this.step(s, folder, "plot", env, args) : null;
    if (plot?.cancelled) return;
    const out = foldHealth(this.foldIn(s, folder, status, plot));
    // The index is the whole repo's, read off the same file the engine just read; a scope has none.
    if (out.doc?.series && !src.scope) out.doc.index = healthIndexOfFile(src.file, this.now());
    s.doc = out.doc;
    s.why = out.why;
    s.readAt = this.now();
  }

  private foldIn(s: Slot, folder: string, status: HealthStepResult, plot: HealthStepResult | null) {
    return {
      folder, status, plot, update: s.update, shallow: isShallow(folder), readAt: this.now(),
      stepMs: this.d.stepMs(), seriesFile: s.source?.file ?? this.seriesFile(folder), tailNote: s.tailNote,
      source: { kind: s.source?.kind ?? "own", scope: s.source?.scope ?? null, scopes: s.scopes, repoFile: repoFileOf(folder) },
    };
  }

  private noGit(s: Slot): void {
    s.doc = null;
    s.why = NO_GIT_WHY;
    s.readAt = this.now();
  }

  /** One engine step in a fresh Worker. Never rejects: a crash is a result with `code: null`. */
  private step(s: Slot, folder: string, step: HealthStep, env: Record<string, string | undefined>, extra: string[] = []): Promise<HealthStepResult> {
    if (s.cancelled || this.disposed) return Promise.resolve({ stdout: "", stderr: "", code: null, cancelled: true });
    s.run = { step, startedAt: this.now(), note: null };
    this.d.onChange(folder);
    const argv = [step, "--root=" + folder, ...extra];
    return new Promise<HealthStepResult>((resolve) => {
      let stdout = "", stderr = "", done = false, timedOut = false;
      let w: Worker;
      try {
        w = new Worker(this.d.workerFile, { argv, env, stdout: true, stderr: true });
      } catch (err) {
        resolve({ stdout, stderr: `${err instanceof Error ? err.message : String(err)}\n`, code: null });
        return;
      }
      s.worker = w;
      const finish = (code: number | null): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (s.worker === w) s.worker = null;
        void w.terminate();
        resolve({ stdout, stderr, code: timedOut || s.cancelled ? null : code, timedOut, cancelled: !timedOut && s.cancelled });
      };
      const timer = setTimeout(() => { timedOut = true; finish(null); }, Math.max(1, this.d.stepMs()));
      w.on("message", (m: { t: string; s?: string; code?: number }) => {
        if (m.t === "out") stdout += m.s ?? "";
        else if (m.t === "err") {
          stderr += m.s ?? "";
          for (const line of (m.s ?? "").split("\n")) {
            const note = parseRepoHealthProgress(line);
            if (note && s.run) { s.run.note = note; this.d.onChange(folder); }
          }
        } else if (m.t === "exit") finish(typeof m.code === "number" ? m.code : null);
      });
      w.on("error", (err) => { stderr += `repohealth: ${err.message}\n`; finish(null); });
      w.on("exit", (code) => finish(s.cancelled ? null : code));
    });
  }
}
