/**
 * The pure half of the phone's slow-job store (`slowJobs.ts`): what one (desktop, kind, repo) holds,
 * how a `slowjob.state` frame or an HTTP answer moves it, when a screen should start a run, and how
 * what is held reads as a `useRemoteResource` state. No DOM, no socket — `slowJobsLogic.test.mjs`.
 *
 * A job is a host read that outlives the screen that asked (host `slowjobs.ts`, wire
 * `shared/wire/slowjob.ts`). The phone keeps two separate facts per key and never merges them:
 * the newest RUN it heard of (running / done / failed, never carrying a result) and the last
 * RESULT it holds (from that run or an older one, live or off this phone's disk). A running
 * re-check therefore never hides the last answer, and a failed one never deletes it.
 */
import type { SlowJob, SlowJobKind } from "@waterplane/shared";

export interface SlowEntry<R = unknown> {
  /** The newest run heard of, without its result. */
  run: SlowJob | null;
  /** The last answer held — maybe an older run's. */
  result: R | null;
  /** Which run `result` came from; null for one this phone wrote itself (a save's answer) or never had. */
  resultRunId: string | null;
  /** When that answer was taken (the run's `finishedAt`, or the moment it was written here). */
  resultAt: number | null;
  /** `live`: read from the desktop this page life. `cache`: off this phone's disk. */
  source: "live" | "cache" | null;
  /** A result read is out. */
  fetching: boolean;
  /** Why the last read of this key failed (not a failed RUN — that is `run.error`). */
  readError: string | null;
}

export const EMPTY_ENTRY: SlowEntry = { run: null, result: null, resultRunId: null, resultAt: null, source: null, fetching: false, readError: null };

/** Under this age a result counts as fresh: a screen opening on it does not start another run. */
export const SLOW_FRESH_MS = 60_000;

/** Store key: one desktop, one kind, one repo (`argsKey` unused by every kind so far). */
export const entryKey = (host: string | null, kind: SlowJobKind, repoId: string): string => `${host ?? "local"}|${kind}:${repoId}`;
/** The `rescache` key (the cache adds the desktop itself). */
export const cacheKeyOf = (kind: SlowJobKind, repoId: string): string => `slowjob:${kind}:${repoId}`;

const strip = (job: SlowJob): SlowJob => {
  const { result: _r, ...rest } = job;
  return rest;
};

/**
 * One frame (or a job read over HTTP, result and all) applied to an entry. `fetch` says the run
 * finished with a result this entry does not hold yet — the caller reads it over HTTP (a frame
 * never carries one). A frame for an OLDER run than the one held is dropped: frames from the
 * reconnect catch-up and live ones can cross.
 */
export function withJob<R>(e: SlowEntry<R>, job: SlowJob, now: number): { entry: SlowEntry<R>; fetch: boolean } {
  if (e.run && job.id !== e.run.id && job.startedAt < e.run.startedAt) return { entry: e, fetch: false };
  let next: SlowEntry<R> = { ...e, run: strip(job) };
  // An answer this phone wrote itself (a save's or a fix's re-read) newer than the moment this run
  // STARTED is newer than what the run read: a re-read of the kept run (a reopened screen, a link
  // flap) and a run already going when the write landed must not put the pre-write result back.
  // (Phone clock against the host's `startedAt`: a skew of seconds only ever errs toward keeping the own answer.)
  const ownIsNewer = e.result !== null && e.resultRunId === null && e.resultAt !== null && e.resultAt > job.startedAt;
  if (job.state === "done" && job.result !== undefined && !ownIsNewer) {
    next = { ...next, result: job.result as R, resultRunId: job.id, resultAt: job.finishedAt ?? now, source: "live", readError: null };
  }
  const fetch = job.state === "done" && !!job.hasResult && job.result === undefined && next.resultRunId !== job.id && !ownIsNewer;
  return { entry: next, fetch };
}

/** An answer this phone got another way (a save or a fix answers with the re-read): it IS the newest result. */
export function withOwnResult<R>(e: SlowEntry<R>, result: R | null, now: number): SlowEntry<R> {
  return { ...e, result, resultRunId: null, resultAt: result === null ? null : now, source: "live" };
}

/** What `rescache` keeps for a key, and the entry it seeds (only where memory holds no result). */
export interface SlowCacheRow<R = unknown> { result: R; resultRunId: string | null; resultAt: number }
export function cacheRowOf<R>(e: SlowEntry<R>): SlowCacheRow<R> | null {
  return e.result === null || e.resultAt === null ? null : { result: e.result, resultRunId: e.resultRunId, resultAt: e.resultAt };
}
export function withCacheRow<R>(e: SlowEntry<R>, row: SlowCacheRow<R> | null): SlowEntry<R> {
  if (!row || e.result !== null) return e;
  return { ...e, result: row.result, resultRunId: row.resultRunId, resultAt: row.resultAt, source: "cache" };
}

export const isRunning = (e: SlowEntry): boolean => e.run?.state === "running";

/**
 * Whether a screen opening on this key starts a run by itself. Only where the caller allows it
 * (`auto`: a free read — never `skills.recommend`, the model call, which stays a tap), never over
 * a running one, and not again right after one failed (a failure is said, not retried in a loop).
 */
export function shouldAutoStart(e: SlowEntry, now: number, auto: boolean, freshMs = SLOW_FRESH_MS): boolean {
  if (!auto || isRunning(e)) return false;
  if (e.run?.state === "failed" && now - (e.run.finishedAt ?? e.run.startedAt) < freshMs) return false;
  return e.resultAt === null || now - e.resultAt >= freshMs;
}

/**
 * The entry as `useRemoteResource` would say it, so `Empty` and its age line need nothing new.
 * A result is `fresh` only when it came from the desktop and is younger than `freshMs`; anything
 * else on screen is `cached` with its age. With no result: a run or read under way is `loading`,
 * a dead link `offline`, a failure `error`.
 */
export function resourceOf(e: SlowEntry, online: boolean, now: number, freshMs = SLOW_FRESH_MS): { state: "loading" | "fresh" | "cached" | "error" | "offline"; age: number | null; error: string | null } {
  const failed = e.run?.state === "failed" ? e.run.error ?? "The desktop gave up on it." : null;
  const error = e.readError ?? failed;
  if (e.result !== null) {
    const age = e.resultAt === null ? null : Math.max(0, now - e.resultAt);
    const fresh = e.source === "live" && age !== null && age < freshMs;
    return { state: fresh ? "fresh" : "cached", age: fresh ? null : age, error };
  }
  if (isRunning(e) || e.fetching) return { state: "loading", age: null, error: null };
  if (!online) return { state: "offline", age: null, error: null };
  if (error) return { state: "error", age: null, error };
  return { state: "loading", age: null, error: null };
}

/**
 * After a reconnect the host's list (`GET /api/jobs`) is the truth about runs: a run this phone
 * holds as running that the list no longer has was lost (the desktop restarted — it keeps jobs in
 * memory only). Returns the keys' runs to forget.
 */
export function lostRuns(held: Array<{ key: string; e: SlowEntry }>, listed: SlowJob[]): string[] {
  const ids = new Set(listed.map((j) => j.id));
  return held.filter(({ e }) => isRunning(e) && e.run && !ids.has(e.run.id)).map(({ key }) => key);
}

/**
 * The host answered "no run kept for this key" to a read made while the entry held run `runId` as
 * running (a desktop restart forgets every job): that run was lost, so forget it — otherwise
 * `shouldAutoStart` never starts again and `resourceOf` says loading for ever. A different run
 * (a start that landed meanwhile) or a settled one is left alone.
 */
export function withRunLost<R>(e: SlowEntry<R>, runId: string | null): SlowEntry<R> {
  return runId !== null && e.run?.id === runId && isRunning(e) ? { ...e, run: null } : e;
}

/** Whole minutes or "under a minute" — a run's own clock, said beside it. */
function since(ms: number): string {
  const m = Math.floor(Math.max(0, ms) / 60_000);
  return m < 1 ? "under a minute ago" : m === 1 ? "1 min ago" : `${m} min ago`;
}

/**
 * The line under a screen while its run is going: what runs, since when, how far where the work
 * counts (`progress` absent = it does not say, so no number is made up), and that leaving is safe.
 * `what` is mid-sentence and capitalised by the caller's words ("The checklist", "The skills list").
 */
export function runningWords(what: string, run: SlowJob, now: number): string {
  const p = run.progress && run.progress.total > 0 ? ` · ${Math.floor((Math.min(run.progress.done, run.progress.total) / run.progress.total) * 100)}%` : "";
  return `${what} is running on the desktop, started ${since(now - run.startedAt)}${p}. It keeps going if you leave this screen; the answer waits here.`;
}

/** The newest run failed: its own sentence, and what is on screen instead. */
export function failedWords(what: string, run: SlowJob, hasResult: boolean): string {
  const why = run.error ?? "The desktop gave up on it.";
  return `${what} did not finish: ${why}${hasResult ? " The answer below is the last one that did." : ""}`;
}
