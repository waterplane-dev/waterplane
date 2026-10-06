import { hostBase } from "../hostUrl";
import { isDemo } from "../demo/mode";
import type { PullRecord } from "./pullTypes";
import { openPullCache, PULL_RESULT_PREFIX, MAX_ATTEMPTS, artifactUrl } from "./pullConsts";
import type { PullManager } from "./pullManager";

// ── engine 1: Background Fetch ────────────────────────────────────
/**
 * Hand the transfer to the browser. Returns true when it took it.
 *
 * Availability is narrow (Chromium, secure context, a registered SW) and that
 * is fine — this is a strict upgrade where it exists, and `rangeFetch` is a
 * complete implementation everywhere else. A failure to register is never
 * fatal: we fall through to the fallback rather than failing the item.
 */
export async function pullStartBackgroundFetch(this: PullManager, rec: PullRecord): Promise<boolean> {
  // A partial download can't be handed over: Background Fetch owns the whole
  // request and would start at zero, throwing away bytes we already paid for.
  if (rec.received > 0) return false;
  // One failure is enough: the browser tells us "failure" and nothing else, so
  // an item that keeps being handed back to this engine loops for ever at
  // "waiting to start" with no error anyone can act on. The range engine reads
  // the actual status code.
  if (rec.bgBlocked) return false;
  // **Never in the native shell.** There the page is `http://localhost` and the
  // daemon is `http://100.x:8770`, so this request is cross-origin — and unlike
  // `fetch`, Background Fetch issues it with no `Origin`, which the host's
  // same-origin guard refuses (and an opaque cross-origin response would land
  // zero bytes in the cache even if it did not). `rangeFetch` is CORS-clean,
  // resumable, and the reason `corsHeaders` exposes ETag/Content-Range at all.
  if (hostBase()) return false;
  // **Never in the demo.** The service worker issues this request itself,
  // outside the page's `fetch`, so the demo transport would never see it.
  // `rangeFetch` goes through `fetch`, which the demo answers.
  if (isDemo()) return false;
  try {
    if (!("serviceWorker" in navigator)) return false;
    const reg: any = await navigator.serviceWorker.ready;
    if (!reg?.backgroundFetch) return false;
    const bgf = await reg.backgroundFetch.fetch(rec.item.id, [artifactUrl(rec.item)], {
      title: rec.item.name,
      downloadTotal: rec.item.size,
      icons: [{ src: "/assets/icon-192.png", sizes: "192x192", type: "image/png" }],
    });
    this.patch(rec.item.id, { engine: "bgfetch" });
    this.watchBackgroundFetch(bgf);
    return true;
  } catch {
    // Already-registered id (a duplicate start) or an unsupported combination.
    // Either way the fallback is correct.
    return false;
  }
}

/** Mirror a Background Fetch's progress into our records while the page is
 *  open. When it isn't, the SW's completion handler is what lands the file. */
export function pullWatchBackgroundFetch(this: PullManager, bgf: any): void {
  if (!bgf) return;
  const id = bgf.id as string;
  bgf.addEventListener?.("progress", () => {
    const received = Number(bgf.downloaded || 0);
    if (bgf.result === "failure") {
      this.noteBgFailure(id, bgf.failureReason);
      return;
    }
    this.patch(id, { state: bgf.result === "success" ? "done" : "downloading", received });
  });
}

/** On boot, re-attach to Background Fetches still running from a previous
 *  session — otherwise the sheet shows "queued" for a transfer the OS is
 *  actively making, and a second start would be registered on top. */
export async function pullAdoptBackgroundFetches(this: PullManager): Promise<Set<string>> {
  const live = new Set<string>();
  try {
    if (!("serviceWorker" in navigator)) return live;
    const reg: any = await navigator.serviceWorker.ready;
    if (!reg?.backgroundFetch) return live;
    const ids: string[] = await reg.backgroundFetch.getIds();
    for (const id of ids) {
      const bgf = await reg.backgroundFetch.get(id);
      if (bgf) { live.add(id); this.watchBackgroundFetch(bgf); }
    }
  } catch { /* no Background Fetch here — the fallback covers it */ }
  return live;
}

/**
 * Boot-time reconciliation of everything the browser did while we weren't
 * running, in the only order that is safe:
 *
 *  1. re-attach to fetches still in flight (they must not be counted as dead),
 *  2. apply the verdicts the service worker parked in Cache Storage,
 *  3. land any bytes sitting in that cache,
 *  4. and only then charge what is left: a record we handed to Background
 *     Fetch that came back with no live transfer, no verdict and no bytes.
 *
 * Step 4 is the one that was missing. Without it a Background Fetch the host
 * refused (403 — no `Origin`, `Sec-Fetch-Site: cross-site`) left a record that
 * looked untouched, so it was re-registered on every launch and the row said
 * "waiting to start" for ever with nothing anywhere to act on.
 */
export async function pullRecoverBackgroundFetches(this: PullManager, orphans: string[]): Promise<void> {
  const live = await this.adoptBackgroundFetches();
  const settled = await this.drainBackgroundResults();
  await this.importAllCached();
  for (const id of orphans) {
    if (live.has(id) || settled.has(id)) continue;
    const cur = this.records[id];
    if (!cur || cur.state === "done" || cur.state === "paused") continue;
    this.noteBgFailure(id, "the download ended while the app was closed");
  }
}

/** Apply (and clear) verdicts the service worker parked for a page that was
 *  not running. Returns the ids it accounted for. */
export async function pullDrainBackgroundResults(this: PullManager): Promise<Set<string>> {
  const seen = new Set<string>();
  if (typeof caches === "undefined") return seen;
  try {
    const cache = await openPullCache();
    for (const req of await cache.keys()) {
      const path = new URL(req.url).pathname;
      if (!path.startsWith(PULL_RESULT_PREFIX)) continue;
      let data: any = null;
      try { data = await (await cache.match(req))?.json(); } catch { /* unreadable ⇒ just drop it */ }
      await cache.delete(req);
      const id = String(data?.id || decodeURIComponent(path.slice(PULL_RESULT_PREFIX.length)));
      if (!id || !this.records[id]) continue;
      seen.add(id);
      this.noteBackgroundResult(id, !!data?.ok, Number(data?.received || 0), data?.reason || undefined);
    }
  } catch { /* no Cache Storage ⇒ nothing was parked either */ }
  return seen;
}

/** Drop a parked verdict this page has already handled live, so the next
 *  launch doesn't charge the same failure a second time. */
export async function pullDropBackgroundResult(this: PullManager, id: string): Promise<void> {
  if (typeof caches === "undefined") return;
  try {
    const cache = await openPullCache();
    await cache.delete(PULL_RESULT_PREFIX + encodeURIComponent(id));
  } catch { /* nothing parked */ }
}

/**
 * A Background Fetch landed. The service worker parks the finished response in
 * Cache Storage rather than writing IndexedDB itself: a worker that opened this
 * DB by version could collide with a page holding the previous one open, and a
 * worker that opened it versionless would find no `pulls` store on a client
 * that hasn't upgraded yet. Cache Storage needs no schema, so the bytes are
 * always safely landed and this side moves them at leisure.
 */
/**
 * A Background Fetch came back "failure". Requeueing it as-is was the bug that
 * made auto-download look completely dead: no attempt counted, no backoff, no
 * error the row could show — and since `startBackgroundFetch` would happily
 * register the same id again on the next tick, the item cycled
 * queued → downloading → queued at 0 B for ever while the sheet said "waiting
 * to start" and `whyIdle()` had nothing to report.
 *
 * So: count it, back it off like any other failed attempt, and take this
 * engine away from the item, because the browser gives no status code and the
 * range engine does. A 403 then reads as "http 403" on the row instead of as
 * an invisible loop.
 */
export function pullNoteBgFailure(this: PullManager, id: string, reason?: string): void {
  const cur = this.records[id];
  if (!cur) return;
  if (cur.state === "paused") return;           // a user pause is not a failure
  const attempts = (cur.attempts ?? 0) + 1;
  const failed = attempts >= MAX_ATTEMPTS;
  this.patch(id, {
    state: failed ? "failed" : "queued",
    attempts,
    error: reason || "background fetch failed",
    engine: undefined,
    bgBlocked: true,
    rate: undefined,
  });
  if (!failed) this.scheduleRetry(id, attempts);
  this.pump();
}

export function pullNoteBackgroundResult(this: PullManager, id: string, ok: boolean, received: number, reason?: string): void {
  if (!this.records[id]) return;
  // Handled here and now — forget the copy the SW parked for a page that
  // might never have opened, or the next launch replays it.
  void this.dropBackgroundResult(id);
  if (!ok) {
    this.noteBgFailure(id, reason);
    return;
  }
  this.patch(id, { received });
  void this.importFromCache(id).finally(() => this.pump());
}

/** Move one finished Background Fetch out of Cache Storage into the pulls
 *  store. A miss leaves the record queued, so the fallback engine re-fetches
 *  it — wasteful but correct, which is the right way round. */
export async function pullImportFromCache(this: PullManager, id: string): Promise<void> {
  const rec = this.records[id];
  if (!rec) return;
  try {
    const cache = await openPullCache();
    const url = artifactUrl(rec.item);
    const hit = await cache.match(url);
    // A miss is the normal case for a record no Background Fetch ever ran for
    // (the SW may have started one we never saw, so this can't be filtered by
    // `engine`). Silently leave it to the range engine — writing an error here
    // put "download not found in cache" on rows that were merely queued.
    if (!hit) return;
    const blob = await hit.blob();
    await this.store(id, blob, blob.size, rec.item.size || blob.size, rec.item.name);
    await cache.delete(url);
    this.patch(id, { state: "done", received: blob.size, error: undefined, engine: "bgfetch" });
  } catch (e) {
    this.patch(id, { state: "queued", error: String((e as Error)?.message || e) });
  }
}

/** On boot, land anything the service worker finished while the app was shut.
 *  This is the case auto-download exists for: the APK downloaded overnight and
 *  is simply THERE when you open the app. */
export async function pullImportAllCached(this: PullManager): Promise<void> {
  if (typeof caches === "undefined") return;
  for (const r of this.list()) {
    if (r.state === "done" || r.state === "paused") continue;
    await this.importFromCache(r.item.id);
  }
}
