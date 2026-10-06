import { nativeSetAuto } from "../nativePull";
import { LS_AUTO, readState } from "./pullConsts";
import { lsSet } from "../storage";
import type { Listener, PullRecord } from "./pullTypes";
import { pullPersist, pullPatch, pullSync, pullAdd, pullAddLocal, pullFindFor, pullShadowed, pullDropSuperseded, pullRetry, pullRemove, pullPause, pullResumeAll, pullWhyIdle } from "./pullQueue";
import { pullSave, pullSaveNative, pullVerifySaved, pullVerifyAllSaved, pullObjectUrl } from "./pullSave";
import { pullStart, pullPump, pullWatchdog, pullRun, pullScheduleRetry } from "./pullEngine";
import { pullStartNative, pullSyncNative, pullAdoptNative, pullSyncNativeSoon } from "./pullNative";
import { pullStartBackgroundFetch, pullWatchBackgroundFetch, pullAdoptBackgroundFetches, pullRecoverBackgroundFetches, pullDrainBackgroundResults, pullDropBackgroundResult, pullNoteBgFailure, pullNoteBackgroundResult, pullImportFromCache, pullImportAllCached } from "./pullBgFetch";
import { pullRangeFetch, pullStore, pullEvictOld, pullDropOne, pullDropBytes } from "./pullRange";

export function setAutoPull(on: boolean): void {
  lsSet(LS_AUTO, on ? "1" : "0");
  void nativeSetAuto(on);
  if (on) pulls.pump();
  pulls.emit();
}

/**
 * The manager. Its method bodies live in the slices beside this file as
 * functions typed `this: PullManager`; each field below is one of them, so a
 * call is still `pulls.name(...)` on the one instance and `this` is that instance.
 */
export class PullManager {
  // The state below is read and written by the method slices in pull/, so it is
  // not `private` (a function in another file cannot see a private member).
  records: Record<string, PullRecord> = readState();
  listeners = new Set<Listener>();
  /** The one in-flight range download. Sequential on purpose: two transfers on a
   *  bad link finish later than the same two run one after another, and a partly
   *  downloaded APK is worth nothing. */
  active: string | null = null;
  abort: AbortController | null = null;
  retryTimer: number | null = null;
  started = false;
  /** When the native queue was last read. See `syncNativeSoon`. */
  lastNativeSync = 0;

  // ── subscription ──────────────────────────────────────────────────
  subscribe(cb: Listener): () => void {
    this.listeners.add(cb);
    cb(this.list());
    return () => { this.listeners.delete(cb); };
  }

  emit(): void {
    const snapshot = this.list();
    for (const cb of this.listeners) cb(snapshot);
  }

  /** Newest first — the same order the host queues them in. */
  list(): PullRecord[] {
    return Object.values(this.records).sort((a, b) => b.item.ts - a.item.ts);
  }

  get(id: string): PullRecord | undefined { return this.records[id]; }

  // ── the slices' methods ───────────────────────────────────────────
  persist = pullPersist;
  patch = pullPatch;
  sync = pullSync;
  add = pullAdd;
  addLocal = pullAddLocal;
  findFor = pullFindFor;
  shadowed = pullShadowed;
  dropSuperseded = pullDropSuperseded;
  retry = pullRetry;
  remove = pullRemove;
  pause = pullPause;
  resumeAll = pullResumeAll;
  whyIdle = pullWhyIdle;
  save = pullSave;
  saveNative = pullSaveNative;
  verifySaved = pullVerifySaved;
  verifyAllSaved = pullVerifyAllSaved;
  objectUrl = pullObjectUrl;
  start = pullStart;
  pump = pullPump;
  watchdog = pullWatchdog;
  run = pullRun;
  scheduleRetry = pullScheduleRetry;
  startNative = pullStartNative;
  syncNative = pullSyncNative;
  adoptNative = pullAdoptNative;
  syncNativeSoon = pullSyncNativeSoon;
  startBackgroundFetch = pullStartBackgroundFetch;
  watchBackgroundFetch = pullWatchBackgroundFetch;
  adoptBackgroundFetches = pullAdoptBackgroundFetches;
  recoverBackgroundFetches = pullRecoverBackgroundFetches;
  drainBackgroundResults = pullDrainBackgroundResults;
  dropBackgroundResult = pullDropBackgroundResult;
  noteBgFailure = pullNoteBgFailure;
  noteBackgroundResult = pullNoteBackgroundResult;
  importFromCache = pullImportFromCache;
  importAllCached = pullImportAllCached;
  rangeFetch = pullRangeFetch;
  store = pullStore;
  evictOld = pullEvictOld;
  dropOne = pullDropOne;
  dropBytes = pullDropBytes;
}

export const pulls = new PullManager();

/** Wire the service worker's Background Fetch reports into the manager. Called
 *  once from App.tsx alongside the other SW message plumbing. */
export function onServiceWorkerPullMessage(data: any): boolean {
  if (!data || data.type !== "pull-result") return false;
  pulls.noteBackgroundResult(String(data.id), !!data.ok, Number(data.received || 0), data.reason);
  return true;
}
