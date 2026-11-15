/**
 * Slow jobs — a read or a recommendation the host runs on a screen's behalf, kept past the
 * screen (host `slowjobs.ts`, `routes/apijobs.ts`; design in `.claude/outbox/slow-jobs-host.md`).
 *
 * A job is keyed by kind + repo (+ an args key). Starting one that is RUNNING joins it — the
 * work never runs twice — and a settled one is kept `SLOW_JOB_KEEP_MS` so a screen that comes
 * back gets the answer at once. Jobs are READS and SUGGESTIONS only: nothing a job produces is
 * applied by anyone but a person's tap. Memory only: a host restart forgets them.
 *
 * Every optional field means "this host did not say"; a value is never guessed.
 */

/** The kinds a host runs. An unknown kind is refused in words, never guessed at. */
export type SlowJobKind = "skills.inventory" | "skills.uses" | "skills.recommend" | "setup.check";
export const SLOW_JOB_KINDS: readonly SlowJobKind[] = ["skills.inventory", "skills.uses", "skills.recommend", "setup.check"];
export const isSlowJobKind = (k: unknown): k is SlowJobKind => typeof k === "string" && (SLOW_JOB_KINDS as readonly string[]).includes(k);

export type SlowJobState = "running" | "done" | "failed";

/** How long a settled job is kept for a returning screen. */
export const SLOW_JOB_KEEP_MS = 30 * 60_000;
/** At most this many SETTLED jobs are kept; the oldest settled goes first, a running one never. */
export const SLOW_JOB_KEEP_MAX = 64;

/** Progress only where the work itself counts it; absent = the work does not say how far it is. */
export interface SlowJobProgress {
  done: number;
  total: number;
}

export interface SlowJob<R = unknown> {
  /** One RUN: a restart of the same key is a new id. */
  id: string;
  /** `kind:repoId[:argsKey]` — what a start joins on. */
  key: string;
  kind: SlowJobKind;
  repoId: string;
  argsKey?: string;
  state: SlowJobState;
  startedAt: number;
  /** Set once settled (`done` or `failed`). */
  finishedAt?: number;
  progress?: SlowJobProgress;
  /** `done` only, and only over HTTP (`GET`/`POST …/jobs/:kind`, `GET /api/jobs/:id`):
   *  the `slowjob.state` frame never carries it — fetch it when `hasResult` says so. */
  result?: R;
  /** `done`: a result is waiting at the job's HTTP route. */
  hasResult?: boolean;
  /** `failed`: one sentence saying why. */
  error?: string;
  /** How many starts this run absorbed beyond the first (a second tab, a retry). */
  joins?: number;
}
