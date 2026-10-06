/**
 * Thumbnail BYTES on this device — the missing half of the offline gallery.
 *
 * `offlineCache.ts` already keeps the gallery's *listing* (what files exist) and
 * the text of opened documents, so a grid with the tunnel down paints rows
 * instead of skeleton tiles. The pictures in those rows came from somewhere
 * else: the service worker's `<slug>-thumbs-v1` cache (public/sw.js). That works
 * in the browser PWA and **nowhere else** — `main.tsx` deliberately does not
 * register a service worker inside the Android shell (the app is loaded out of
 * the APK, the daemon is a different origin), so in the app that ships to the
 * phone every thumbnail was a live request. Offline that is a grid of file
 * names over grey boxes: the one screen whose entire job is "show me the
 * picture" was the one screen that had no pictures.
 *
 * So thumbnails are cached HERE too, in IndexedDB, by the page — which works
 * identically in the browser and in the APK. Two stores, on purpose:
 *  - `thumbs`    — the blob, keyed by its URL.
 *  - `thumbmeta` — `{ url, savedAt, bytes }` for the same key.
 * Eviction has to rank every entry by age and sum their sizes; doing that over
 * the blob store would mean pulling every thumbnail out of the DB to decide
 * which ones to drop.
 *
 * Caching by URL is only sound because the URL is versioned — `&thumb=<w>&v=<mtime>`
 * (media.ts `sized()`), so a regenerated file at the same path is a different
 * key and yesterday's screenshot can never be served under today's name. Same
 * rule the service worker relies on, and the same rule as `artifactMarks`.
 */
import { timedFetch } from "@waterplane/shared";
import { idbClear, idbDel, idbGet, idbGetAll, idbSet } from "./idb";

const BLOBS = "thumbs";
const META = "thumbmeta";

/** Thumbnails kept. ~400 × ~25 KB ≈ 10 MB — the same budget the service worker
 *  cache uses, well inside a phone's quota, and a re-fetch of an evicted one is
 *  a single normal request whenever the link is up. */
const MAX_THUMBS = 400;
/** Second, independent ceiling: entry count says nothing about bytes, and a tab
 *  full of 400 KB "thumbnails" (see below) would be 160 MB of quota. */
const MAX_TOTAL_BYTES = 24 * 1024 * 1024;
/** A "thumb" that comes back this big is the host serving the ORIGINAL:
 *  `thumbs.ts` returns null (⇒ original) when it has no converter, the type is
 *  unsupported, or the source is already small. Parking a multi-MB original
 *  under a thumbnail key is exactly the storage this cache exists to avoid. */
const MAX_ENTRY_BYTES = 512 * 1024;
/** Background warms in flight. Small on purpose: these run *alongside* the
 *  grid's own <img> loads on a link that is often a phone's uplink. */
const MAX_PARALLEL = 3;
/** A thumbnail is ~25 KB; a request for one that takes longer than this is a
 *  link that has bigger problems, and this is a background nicety. */
const FETCH_MS = 15000;

interface ThumbMeta { url: string; savedAt: number; bytes: number }

/** The stored bytes for a thumbnail URL, or null. */
export async function getThumbBlob(url: string): Promise<Blob | null> {
  const b = await idbGet<Blob>(BLOBS, url);
  return b instanceof Blob && b.size > 0 ? b : null;
}

/** Is this thumbnail already on the device? Reads the small record, never the
 *  blob — used by the warmer to skip work, dozens of times per listing. */
async function haveThumb(url: string): Promise<boolean> {
  return !!(await idbGet<ThumbMeta>(META, url));
}

const queued = new Set<string>();
const pending: string[] = [];
let running = 0;

/**
 * Remember this thumbnail, in the background, at most once.
 *
 * Called when a grid <img> has just LOADED, so the bytes are in the browser's
 * own HTTP cache and the host marked them `immutable` — `cache: "force-cache"`
 * then makes this a memory/disk read rather than a second trip over Tailscale.
 * A miss there costs one ~25 KB request, which is the price of the picture
 * still being there tonight on the train.
 */
export function cacheThumb(url: string): void {
  if (!url || url.startsWith("blob:") || queued.has(url)) return;
  queued.add(url);
  pending.push(url);
  void pump();
}

async function pump(): Promise<void> {
  if (running >= MAX_PARALLEL) return;
  const url = pending.shift();
  if (!url) return;
  running++;
  try {
    await store(url);
  } catch {
    // Offline, host gone, file deleted — nothing to do and nothing to say. The
    // grid already reports a picture it could not draw; a warm that failed is
    // invisible by design. Dropped from `queued` so a later view can retry.
    queued.delete(url);
  } finally {
    running--;
    void pump();
  }
}

async function store(url: string): Promise<void> {
  if (await haveThumb(url)) return;
  const res = await timedFetch(url, { cache: "force-cache" }, FETCH_MS);
  const type = res.headers.get("content-type") || "";
  if (!res.ok || !type.startsWith("image/")) throw new Error(`thumb ${res.status}`);
  const blob = await res.blob();
  // Checked on the BLOB, not on content-length: a compressed or chunked
  // response can arrive without a length, and "no header" must not mean
  // "store whatever came back".
  if (!blob.size || blob.size > MAX_ENTRY_BYTES) throw new Error("not a thumbnail");
  await idbSet(BLOBS, url, blob);
  await idbSet(META, url, { url, savedAt: Date.now(), bytes: blob.size } satisfies ThumbMeta);
  void prune();
}

let pruning = false;

/** Evict oldest-first until both ceilings hold. Insertion time, not last use:
 *  tracking reads would mean a DB write per painted tile, and the thing an
 *  age-ranked cache gets wrong (dropping a thumbnail you still look at) costs
 *  one request. */
async function prune(): Promise<void> {
  if (pruning) return;
  pruning = true;
  try {
    const all = await idbGetAll<ThumbMeta>(META);
    const newestFirst = [...all].sort((a, b) => b.savedAt - a.savedAt);
    const doomed: ThumbMeta[] = newestFirst.slice(MAX_THUMBS);
    let bytes = 0;
    for (const m of newestFirst.slice(0, MAX_THUMBS)) {
      bytes += m.bytes || 0;
      if (bytes > MAX_TOTAL_BYTES) doomed.push(m);
    }
    for (const m of doomed) {
      await idbDel(BLOBS, m.url);
      await idbDel(META, m.url);
      queued.delete(m.url);
    }
  } finally {
    pruning = false;
  }
}

/**
 * Make sure this device holds the thumbnails for the top of a listing.
 *
 * The grid loads its <img>s lazily, so what gets remembered is exactly what
 * scrolled past the viewport — which is right for a long tab and wrong for the
 * case that matters: a gallery opened, glanced at and closed still has to show
 * a full screen of pictures when the link is gone. `urls` is therefore the
 * FIRST rows of the listing, warmed whether or not they were ever drawn.
 *
 * Silent and best-effort: a warm that fails leaves the grid exactly as it was.
 */
export function prefetchThumbs(urls: string[]): void {
  for (const u of urls) cacheThumb(u);
}

/**
 * Throw away every cached thumbnail — both stores, and the warm-once guard.
 *
 * The storage screen's button (`storageAudit.ts`). `queued` is the part that
 * is easy to forget and impossible to notice: it is what stops the warmer
 * re-fetching a picture it has already stored, so a clear that leaves it full
 * empties the cache and then refuses to refill it for the life of the tab —
 * the grid would go back to fetching every thumbnail over Tailscale on every
 * paint, which is the opposite of what the tap was for.
 *
 * Blobs and metadata are cleared together or the eviction ranking is left
 * pointing at pictures that are gone.
 */
export async function forgetThumbs(): Promise<boolean> {
  queued.clear();
  pending.length = 0;
  const blobs = await idbClear(BLOBS);
  const meta = await idbClear(META);
  return blobs && meta;
}
