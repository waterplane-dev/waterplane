import type { PullItem } from "@waterplane/shared";
import { abs } from "../hostUrl";
import { LS, lsGet } from "../storage";
import { PULL_CACHE, migratePullCache } from "../boot/brandMigrate";
import type { PullRecord } from "./pullTypes";

export const LS_STATE = LS.pullState;
/** Where the service worker parks a finished Background Fetch. Must match
 *  `PULLS` in public/sw.js — the handoff is by cache name, and the two halves
 *  run in different scripts; both build it from the brand slug. Opened only
 *  through `openPullCache`, which first copies what an older name still holds. */
export async function openPullCache(): Promise<Cache> {
  await migratePullCache();
  return caches.open(PULL_CACHE);
}
/** Where the service worker parks how a Background Fetch ENDED. Must match
 *  `PULL_RESULT_PREFIX` in public/sw.js. A verdict delivered only by
 *  postMessage is lost whenever the app was closed — which is precisely when
 *  this engine is doing its job. */
export const PULL_RESULT_PREFIX = "/__pull-result/";
export const LS_AUTO = LS.pullAuto;
/** Bytes read before the partial blob is written back to IndexedDB. Small enough
 *  that a dead spot costs little, big enough not to thrash storage. */
export const FLUSH_BYTES = 1024 * 1024;
/** Also flush on a timer: on a slow link 1 MB can be minutes, and a progress
 *  number that only moves per megabyte reads as frozen. The write is small and
 *  the offset is what a resume costs, so flushing often is cheap insurance. */
export const FLUSH_MS = 1500;
/** No response headers within this ⇒ the tunnel is gone. A fetch against a dead
 *  Tailscale path does not error, it HANGS — and a hung fetch pins `active`, so
 *  the queue stops and the retry button does nothing. */
export const HEADERS_TIMEOUT_MS = 25_000;
/** No bytes for this long mid-stream ⇒ same thing, one step later. */
export const STALL_MS = 30_000;
/** Give up after this many attempts that made NO progress. Attempts that moved
 *  bytes reset the count: a link delivering 40 KB per try is awful but is not a
 *  reason to abandon a download, and giving up is what the phone must not do. */
export const MAX_ATTEMPTS = 50;
/** Retry backoff (ms), clamped to the last entry. */
export const BACKOFF = [2_000, 5_000, 10_000, 20_000, 30_000, 60_000, 120_000];
/** Heartbeat: re-try the queue even with no `online`/visibility event. A phone
 *  moving between cells fires neither, and `navigator.onLine` stays true the
 *  whole time the tunnel is dead. */
export const TICK_MS = 15_000;
/** Finished downloads keep their bytes this long, then the blob is evicted. */
export const KEEP_DONE_MS = 7 * 24 * 60 * 60 * 1000;
/** Cap on tracked records — the host queue is capped at 200, match it. */
export const MAX_RECORDS = 200;

/** How long a save waits for the service to say where the file went, and how
 *  often it asks. The copy is a local file-to-MediaStore write — a second is
 *  generous; the rest of the budget is for a phone that is busy installing the
 *  APK it just finished downloading. */
export const PUBLISH_WAIT_MS = 8000;
export const PUBLISH_POLL_MS = 300;
/** How often the native engine's queue is re-read. Cheap, but it is a bridge
 *  call and `pump()` runs on every wake event as well as the heartbeat. */
export const NATIVE_SYNC_MS = 2_000;

/** The id of a locally-requested download. Same INPUTS as the host's `pullId`
 *  (repo + path + mtime) so one file is one row however many times it is asked
 *  for, but a distinct prefix and hash: the two id spaces must not collide, and
 *  a browser has no cheap sha1. */
export function localPullId(repoId: string, relPath: string, mtime: number): string {
  const key = `${repoId} ${relPath} ${Math.round(mtime)}`;
  let h = 5381;
  for (let i = 0; i < key.length; i++) h = ((h * 33) ^ key.charCodeAt(i)) >>> 0;
  let h2 = 52711;
  for (let i = key.length - 1; i >= 0; i--) h2 = ((h2 * 31) ^ key.charCodeAt(i)) >>> 0;
  return `l_${h.toString(36)}${h2.toString(36)}`;
}

export function artifactUrl(item: PullItem): string {
  // `abs()` because this URL is also handed to Background Fetch, which the
  // browser performs from the service worker — outside the transport patch the
  // native shell installs (hostUrl.ts), and to the native download service,
  // which sends no bearer — so `abs()` pins the SAVED (tailnet) address, never
  // the LAN route, where a token-less request is a 401. No-op in the browser.
  return abs(`/api/repos/${item.repoId}/artifact?path=${encodeURIComponent(item.relPath)}&download=1`);
}

export function readState(): Record<string, PullRecord> {
  try {
    const raw = JSON.parse(lsGet(LS_STATE) || "{}");
    return raw && typeof raw === "object" ? raw : {};
  } catch { return {}; }
}

/** Auto-download on by default. Off = files are queued and listed, and each one
 *  waits for a tap — the escape hatch for a metered link. */
export function autoPull(): boolean {
  return lsGet(LS_AUTO) !== "0";
}
