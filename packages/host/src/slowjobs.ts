/**
 * Slow jobs: a read or a suggestion the host runs on a screen's behalf, kept past the screen
 * (`shared/wire/slowjob.ts`; routes `routes/apijobs.ts`; design `.claude/outbox/slow-jobs-host.md`).
 *
 * - **Never twice.** A start whose key (kind + repo + args key) is RUNNING joins that run and
 *   gets its promise — a second tab, a retried POST or a screen re-opened mid-run spends nothing
 *   new. This is what keeps the one spender here (`skills.recommend`) to one call per tap.
 * - **Kept, then forgotten.** A settled run stays `SLOW_JOB_KEEP_MS`, at most
 *   `SLOW_JOB_KEEP_MAX` settled ones (oldest settled first; a running one is never evicted).
 *   Memory only: a restart forgets them, and a screen then simply starts again.
 * - **No timers.** Expiry is applied on every access; the one timer per run is its give-up
 *   bound (`timeoutMs`), unref'd, after which the run reads `failed` in words while the work it
 *   started may still finish — its late answer is dropped, never served as the newer run's.
 * - **Nothing applies itself.** A job returns a value; what it means is a person's decision.
 *
 * The broadcast (`onChange`) never carries `result` (`hasResult` says one is waiting at the
 * HTTP route): results can be large, and the setup report's confirm tokens are minted per
 * HTTP read, never put into a frame every tab receives.
 */
import { randomUUID } from "node:crypto";
import { SLOW_JOB_KEEP_MAX, SLOW_JOB_KEEP_MS, type SlowJob, type SlowJobKind, type SlowJobProgress } from "@waterplane/shared";

/** The work's own progress callback: `report(done, total)`. Throttled before it reaches the wire. */
export type SlowJobReport = (done: number, total: number) => void;

export interface SlowJobSpec<R> {
  kind: SlowJobKind;
  repoId: string;
  /** Distinguishes runs of one kind in one repo that answer different questions. */
  argsKey?: string;
  run: (report: SlowJobReport) => Promise<R>;
  /** Give-up bound for this run (default `DEFAULT_TIMEOUT_MS`). */
  timeoutMs?: number;
  /** Host-side facts the HTTP read needs (the worktree, for confirm tokens). Never on the wire. */
  meta?: Record<string, string>;
  /**
   * No frames for this run while nobody asked for them: the OLD routes (`GET …/skills`, polled
   * every 3 s, `GET …/compliance`) join jobs quietly, so they do not put two frames per poll on
   * every tab. A loud start joining a quiet run makes it loud from then on (and emits at once).
   */
  quiet?: boolean;
}

export interface SlowJobsOpts {
  onChange?: (job: SlowJob) => void;
  now?: () => number;
  keepMs?: number;
  keepMax?: number;
  /** Minimum gap between two progress frames of one run. */
  progressEveryMs?: number;
}

export const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const ERROR_CAP = 300;

interface Entry {
  job: SlowJob;
  promise: Promise<unknown>;
  meta: Record<string, string>;
  lastProgressAt: number;
  quiet: boolean;
}

export const slowJobKey = (kind: SlowJobKind, repoId: string, argsKey?: string): string =>
  argsKey ? `${kind}:${repoId}:${argsKey}` : `${kind}:${repoId}`;

const errText = (e: unknown): string => {
  const m = e instanceof Error ? e.message : typeof e === "string" ? e : "";
  const t = m.trim() || "The job failed without saying why.";
  return t.length > ERROR_CAP ? `${t.slice(0, ERROR_CAP - 1)}…` : t;
};

export class SlowJobs {
  private readonly byKey = new Map<string, Entry>();
  private readonly byId = new Map<string, Entry>();
  private readonly now: () => number;
  private readonly keepMs: number;
  private readonly keepMax: number;
  private readonly progressEveryMs: number;

  constructor(private readonly opts: SlowJobsOpts = {}) {
    this.now = opts.now ?? Date.now;
    this.keepMs = opts.keepMs ?? SLOW_JOB_KEEP_MS;
    this.keepMax = opts.keepMax ?? SLOW_JOB_KEEP_MAX;
    this.progressEveryMs = opts.progressEveryMs ?? 500;
  }

  /**
   * Start a run, or JOIN the one running under the same key. `joined` says which. A settled
   * run under the key is replaced (a start is a request for a fresh answer; a returning screen
   * READS with `get`). `promise` settles with the result or rejects with the failure.
   */
  start<R>(spec: SlowJobSpec<R>): { job: SlowJob; promise: Promise<R>; joined: boolean } {
    this.prune();
    const key = slowJobKey(spec.kind, spec.repoId, spec.argsKey);
    const live = this.byKey.get(key);
    if (live && live.job.state === "running") {
      live.job.joins = (live.job.joins ?? 0) + 1;
      if (live.quiet && !spec.quiet) { live.quiet = false; this.emit(live); }
      return { job: this.view(live.job), promise: live.promise as Promise<R>, joined: true };
    }
    if (live) this.byId.delete(live.job.id);
    const job: SlowJob = {
      id: randomUUID(), key, kind: spec.kind, repoId: spec.repoId,
      ...(spec.argsKey ? { argsKey: spec.argsKey } : {}),
      state: "running", startedAt: this.now(),
    };
    const entry: Entry = { job, promise: Promise.resolve(), meta: spec.meta ?? {}, lastProgressAt: 0, quiet: spec.quiet === true };
    const current = () => this.byId.get(job.id) === entry;
    const report: SlowJobReport = (done, total) => {
      if (!current() || job.state !== "running") return;
      if (!Number.isFinite(done) || !Number.isFinite(total) || total < 0 || done < 0) return;
      const p: SlowJobProgress = { done: Math.min(done, total), total };
      job.progress = p;
      const t = this.now();
      if (t - entry.lastProgressAt < this.progressEveryMs) return;
      entry.lastProgressAt = t;
      this.emit(entry);
    };
    const timeoutMs = spec.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bound = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Gave up after ${Math.round(timeoutMs / 60_000) || 1} min; nothing was kept from this run.`)), timeoutMs);
      timer.unref?.();
    });
    const promise = Promise.race([Promise.resolve().then(() => spec.run(report)), bound]).then(
      (result) => {
        clearTimeout(timer);
        if (current() && job.state === "running") {
          job.state = "done"; job.finishedAt = this.now(); job.result = result; job.hasResult = true;
          this.emit(entry);
        }
        return result;
      },
      (e: unknown) => {
        clearTimeout(timer);
        if (current() && job.state === "running") {
          job.state = "failed"; job.finishedAt = this.now(); job.error = errText(e);
          this.emit(entry);
        }
        throw e;
      },
    );
    // A run nobody awaits must not surface as an unhandled rejection.
    promise.catch(() => {});
    entry.promise = promise;
    this.byKey.set(key, entry);
    this.byId.set(job.id, entry);
    this.emit(entry);
    this.prune();
    return { job: this.view(job), promise, joined: false };
  }

  /** The running or kept run under this key, with its result. */
  get(kind: SlowJobKind, repoId: string, argsKey?: string): SlowJob | null {
    this.prune();
    const e = this.byKey.get(slowJobKey(kind, repoId, argsKey));
    return e ? this.full(e.job) : null;
  }

  /**
   * Drop the SETTLED runs of `kind` (this repo's, or every repo's when `repoId` is absent): a write
   * changed what they read, so serving their kept answer would put the pre-write state back on a
   * phone. A running run is left alone (its frames and promise stay consistent); a returning
   * screen simply finds nothing kept. Returns how many were dropped.
   */
  forget(kind: SlowJobKind, repoId?: string): number {
    let n = 0;
    for (const [key, e] of [...this.byKey]) {
      if (e.job.kind !== kind || (repoId !== undefined && e.job.repoId !== repoId) || e.job.state === "running") continue;
      this.byKey.delete(key); this.byId.delete(e.job.id); n++;
    }
    return n;
  }

  /** The run with this id, with its result — null once replaced or expired. */
  getById(id: string): SlowJob | null {
    this.prune();
    const e = this.byId.get(id);
    return e ? this.full(e.job) : null;
  }

  /** The host-side facts a run was started with (never on the wire). */
  metaOf(id: string): Record<string, string> | null {
    return this.byId.get(id)?.meta ?? null;
  }

  /** Every running and kept run, newest first, WITHOUT results (a reconnecting phone's catch-up). */
  list(): SlowJob[] {
    this.prune();
    return [...this.byKey.values()].map((e) => this.view(e.job)).sort((a, b) => b.startedAt - a.startedAt);
  }

  private emit(entry: Entry): void {
    if (entry.quiet) return;
    try { this.opts.onChange?.(this.view(entry.job)); } catch { /* a broadcast failure never fails the work */ }
  }

  /** The wire view: everything but `result`. */
  private view(job: SlowJob): SlowJob {
    const { result: _r, ...rest } = job;
    return { ...rest, ...(rest.progress ? { progress: { ...rest.progress } } : {}) };
  }

  private full(job: SlowJob): SlowJob {
    return { ...this.view(job), ...(job.state === "done" ? { result: job.result } : {}) };
  }

  private prune(): void {
    const t = this.now();
    const settled: Entry[] = [];
    for (const [key, e] of this.byKey) {
      if (e.job.state === "running") continue;
      if (t - (e.job.finishedAt ?? t) >= this.keepMs) { this.byKey.delete(key); this.byId.delete(e.job.id); continue; }
      settled.push(e);
    }
    if (settled.length <= this.keepMax) return;
    settled.sort((a, b) => (a.job.finishedAt ?? 0) - (b.job.finishedAt ?? 0));
    for (const e of settled.slice(0, settled.length - this.keepMax)) { this.byKey.delete(e.job.key); this.byId.delete(e.job.id); }
  }
}
