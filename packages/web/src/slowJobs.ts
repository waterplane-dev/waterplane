/**
 * The phone's slow-job store: host reads that outlive the screen that asked (the setup checklist,
 * the skills inventory and its use counts, the skill suggestions — host `slowjobs.ts`, wire
 * `shared/wire/slowjob.ts`). It lives OUTSIDE every component, so leaving a screen aborts nothing
 * and coming back finds the run still going or its answer waiting.
 *
 * Here and not in a feature folder because two readers sit on opposite sides of the feature
 * boundary (`SetupSheet.tsx` at the root, `features/skills`), as `skillsDoor.ts` does. The wire
 * half — the `slowjob.state` frame, the reconnect catch-up, the toast when a run ends off-screen —
 * is `features/slowjobs`, which calls the writers below. ONE writer: this file.
 *
 *  - start or join: `POST /api/repos/:id/jobs/:kind` (a running key is JOINED, never run twice);
 *  - a frame moves the run; `done` reads the result over HTTP (a frame never carries one);
 *  - the last result per (desktop, kind, repo) is kept in the default read cache (`rescache`),
 *    so a reload or a dead link still shows it, labelled with its age;
 *  - a start while the link is down is refused with the offline gate's sentence, never queued.
 * Pure rules: `slowJobsLogic.ts`.
 */
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { SlowJob, SlowJobKind } from "@waterplane/shared";
import { createStore, useStore } from "./sdk/store.ts";
import { api, isOffline } from "./api";
import { activeHost } from "./hosts";
import { getResCache, putResCache } from "./offlineCache";
import { withoutConfirm } from "./resourceCache";
import { linkOnline, subscribeLink } from "./link";
import { offlineSentence } from "./kit/offlineGate";
import type { RemoteResource } from "./useRemoteResource";
import {
  EMPTY_ENTRY, cacheKeyOf, cacheRowOf, entryKey, isRunning, lostRuns, resourceOf, shouldAutoStart, withCacheRow, withJob, withOwnResult, withRunLost,
  type SlowCacheRow, type SlowEntry,
} from "./slowJobsLogic";

/** Bump when a kind's result DTO changes shape, so old cached rows are dropped. */
const CACHE_SHAPE = 1;

const entries = createStore<Record<string, SlowEntry>>({});
/** Keys a mounted screen is showing right now (counted: two can show one key). */
const watched = new Map<string, number>();
/** Keys a person is waiting on (a tap, or a screen that had nothing to show yet): the ones whose end is worth a toast. */
const asked = new Set<string>();
/** Keys whose cache row was already read this page life. */
const seeded = new Set<string>();

const host = () => activeHost()?.id ?? null;
const keyOf = (kind: SlowJobKind, repoId: string) => entryKey(host(), kind, repoId);
const get = (key: string): SlowEntry => entries.get()[key] ?? EMPTY_ENTRY;
const put = (key: string, e: SlowEntry) => entries.set((m) => ({ ...m, [key]: e }));

export interface SlowSettled { kind: SlowJobKind; repoId: string; job: SlowJob; asked: boolean; watched: boolean }
type SettledFn = (s: SlowSettled) => void;
const settledFns = new Set<SettledFn>();
/** `features/slowjobs` listens here for the toast; returns the unsubscribe. */
export function onSlowJobSettled(fn: SettledFn): () => void {
  settledFns.add(fn);
  return () => { settledFns.delete(fn); };
}

function settled(kind: SlowJobKind, repoId: string, job: SlowJob): void {
  const key = keyOf(kind, repoId);
  const s: SlowSettled = { kind, repoId, job, asked: asked.has(key), watched: (watched.get(key) ?? 0) > 0 };
  asked.delete(key);
  for (const fn of settledFns) { try { fn(s); } catch { /* a listener's bug never stops the store */ } }
}

function saveCache(kind: SlowJobKind, repoId: string, e: SlowEntry): void {
  const row = cacheRowOf(e);
  // The setup report carries one-shot fix tokens (minted per HTTP read): never kept on disk.
  if (row && kind === "setup.check") row.result = withoutConfirm(row.result);
  if (row) void putResCache(cacheKeyOf(kind, repoId), CACHE_SHAPE, row).catch(() => {});
}

/** Apply one job (a frame, an HTTP answer, a catch-up row) and read its result when it has one waiting. */
function apply(job: SlowJob): void {
  const key = keyOf(job.kind, job.repoId);
  const before = get(key);
  const { entry, fetch } = withJob(before, job, Date.now());
  if (entry === before) return;
  put(key, entry);
  if (entry.resultRunId === job.id && before.resultRunId !== job.id) saveCache(job.kind, job.repoId, entry);
  const wasRunning = before.run?.id === job.id && before.run.state === "running";
  const interested = asked.has(key) || (watched.get(key) ?? 0) > 0 || before.result !== null;
  if (fetch && interested) void readResult(job.kind, job.repoId, job);
  else if (job.state !== "running" && (wasRunning || asked.has(key))) settled(job.kind, job.repoId, job);
}

async function readResult(kind: SlowJobKind, repoId: string, frame: SlowJob): Promise<void> {
  const key = keyOf(kind, repoId);
  put(key, { ...get(key), fetching: true });
  try {
    const { job } = await api.slowJobRead(repoId, kind);
    put(key, { ...get(key), fetching: false });
    if (job) {
      const before = get(key);
      const { entry } = withJob(before, job, Date.now());
      put(key, entry);
      if (entry.resultRunId === job.id && before.resultRunId !== job.id) saveCache(kind, repoId, entry);
    }
    settled(kind, repoId, job ?? frame);
  } catch (e) {
    put(key, { ...get(key), fetching: false, readError: isOffline(e) ? null : String((e as Error)?.message || e) });
  }
}

/** A `slowjob.state` frame from the socket. */
export function onSlowJobFrame(job: SlowJob): void {
  apply(job);
}

/**
 * After a (re)connect: the host's list is what happened while the socket was down. A run held as
 * running that it no longer lists was lost (a desktop restart forgets every job); a screen showing
 * that key asks again.
 */
export async function resyncSlowJobs(): Promise<void> {
  const prefix = `${host() ?? "local"}|`;
  const mine = Object.entries(entries.get()).filter(([k]) => k.startsWith(prefix));
  if (!mine.length) return;
  let jobs: SlowJob[];
  try { jobs = (await api.slowJobList()).jobs ?? []; } catch { return; }
  for (const k of lostRuns(mine.map(([key, e]) => ({ key, e })), jobs)) put(k, { ...get(k), run: null });
  for (const j of [...jobs].reverse()) if (entries.get()[keyOf(j.kind, j.repoId)]) apply(j);
  for (const [k] of mine) {
    if ((watched.get(k) ?? 0) === 0) continue;
    const [kind, repoId] = splitKey(k);
    if (kind && repoId && !get(k).run) void ensureSlowJob(kind, repoId, { auto: false });
  }
}

function splitKey(k: string): [SlowJobKind | null, string | null] {
  const rest = k.slice(k.indexOf("|") + 1);
  const i = rest.indexOf(":");
  return i < 0 ? [null, null] : [rest.slice(0, i) as SlowJobKind, rest.slice(i + 1)];
}

/** Read the kept answer off disk once per page life, under whatever memory already holds. */
async function seed(kind: SlowJobKind, repoId: string): Promise<void> {
  const key = keyOf(kind, repoId);
  if (seeded.has(key)) return;
  seeded.add(key);
  const row = await getResCache<SlowCacheRow>(cacheKeyOf(kind, repoId), CACHE_SHAPE).catch(() => null);
  if (row) put(key, withCacheRow(get(key), row.value));
}

/**
 * Start (or join) a run. Refused, with the offline gate's sentence, while the link is down — a
 * start is never queued. Returns that sentence, or null when the desktop took it.
 */
export async function startSlowJob(kind: SlowJobKind, repoId: string, verb: string, opts: { ask?: boolean } = {}): Promise<string | null> {
  if (!linkOnline()) return offlineSentence(verb);
  const key = keyOf(kind, repoId);
  if (opts.ask !== false) asked.add(key);
  put(key, { ...get(key), readError: null });
  try {
    const { job } = await api.slowJobStart(repoId, kind);
    apply(job);
    return null;
  } catch (e) {
    asked.delete(key);
    if (isOffline(e)) return offlineSentence(verb);
    const why = String((e as Error)?.message || e);
    put(key, { ...get(key), readError: why });
    return `Could not ${verb}: ${why}`;
  }
}

/**
 * What a screen does on open: show what is held (memory, else disk), ask the desktop for its kept
 * run, and start one only where `auto` allows (`shouldAutoStart`). A run already going is joined
 * by listening, not by a second start.
 */
export async function ensureSlowJob(kind: SlowJobKind, repoId: string, opts: { auto: boolean; verb?: string }): Promise<void> {
  await seed(kind, repoId);
  if (!linkOnline()) return;
  const key = keyOf(kind, repoId);
  put(key, { ...get(key), fetching: true });
  const heldRun = isRunning(get(key)) ? get(key).run?.id ?? null : null;
  try {
    const { job } = await api.slowJobRead(repoId, kind);
    put(key, { ...get(key), fetching: false, readError: null });
    if (job) apply(job);
    // The desktop keeps no run for this key but this phone holds one as running: it was lost (a restart).
    else put(key, withRunLost(get(key), heldRun));
  } catch (e) {
    put(key, { ...get(key), fetching: false, readError: isOffline(e) ? null : String((e as Error)?.message || e) });
    return;
  }
  const e = get(key);
  // Nothing to show yet: the person is waiting on this run, so its end is worth a toast if they leave.
  if (isRunning(e) && e.result === null) asked.add(key);
  if (shouldAutoStart(e, Date.now(), opts.auto)) void startSlowJob(kind, repoId, opts.verb ?? "read it", { ask: e.result === null });
}

/** An answer the screen got another way (a save, a fix): it is the newest result for its key. */
export function setSlowJobResult<R>(kind: SlowJobKind, repoId: string, result: R | null): void {
  const key = keyOf(kind, repoId);
  const e = withOwnResult(get(key), result, Date.now());
  put(key, e);
  saveCache(kind, repoId, e);
}

export interface SlowJobResource<R> extends RemoteResource<R> {
  /** The newest run, without its result; null when none is known. */
  job: SlowJob | null;
  running: boolean;
  /** When the result on screen was taken. */
  resultAt: number | null;
  /** The refusal of the last start (offline, or the desktop's words); null otherwise. */
  refusal: string | null;
  /** Start a fresh run on a tap. */
  start: () => void;
}

/**
 * One screen's view of one key. `reload` is a fresh run (so a `useRemoteResource` call site's
 * re-check verb keeps working), `set` an answer from elsewhere. `auto`: the screen may start a run
 * by itself when what it holds is older than a minute (never for a paid call).
 */
export function useSlowJob<R>(kind: SlowJobKind, repoId: string | null, opts: { enabled?: boolean; auto: boolean; verb: string }): SlowJobResource<R> {
  const { enabled = true, auto, verb } = opts;
  const online = useSyncExternalStore(subscribeLink, linkOnline);
  const all = useStore(entries);
  const key = repoId ? keyOf(kind, repoId) : null;
  const e = (key && all[key]) || (EMPTY_ENTRY as SlowEntry<R>);
  const [refusal, setRefusal] = useState<string | null>(null);

  useEffect(() => {
    if (!key || !enabled) return;
    watched.set(key, (watched.get(key) ?? 0) + 1);
    return () => {
      const n = (watched.get(key) ?? 1) - 1;
      if (n > 0) watched.set(key, n); else watched.delete(key);
    };
  }, [key, enabled]);

  // On open, and again when the link comes back.
  useEffect(() => {
    if (!repoId || !enabled) return;
    setRefusal(null);
    void ensureSlowJob(kind, repoId, { auto, verb });
  }, [kind, repoId, enabled, online, auto, verb]);

  const start = useCallback(() => {
    if (!repoId) return;
    void startSlowJob(kind, repoId, verb).then(setRefusal);
  }, [kind, repoId, verb]);
  const reload = useCallback(() => start(), [start]);
  const set = useCallback((next: R | null) => { if (repoId) setSlowJobResult(kind, repoId, next); }, [kind, repoId]);

  return useMemo(() => {
    const r = resourceOf(e, online, Date.now());
    const running = isRunning(e);
    return {
      data: e.result as R | null, state: r.state, age: r.age, error: r.error,
      inflight: running || e.fetching, gap: online ? null : "link",
      reload, set, job: e.run, running, resultAt: e.resultAt, refusal, start,
    } as SlowJobResource<R>;
  }, [e, online, refusal, reload, set, start]);
}
