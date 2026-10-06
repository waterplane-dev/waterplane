/**
 * The phone's half of a product rename: everything stored under an OLDER
 * brand's names is copied to the current ones, before anything reads it.
 *
 * Three stores, three moments:
 *
 *  1. **localStorage** — `runBrandMigration()`, the first statement of
 *     `hostBoot.ts`, which is the first import of `main.tsx`. Synchronous, so
 *     nothing can read a key before it is there: drafts, the send queue, the
 *     pad, every parked host's keys (`<prefix>h.<id>.…`) and the reader
 *     watermarks are all just keys under the prefix. The copy itself is
 *     `shared/brandmigrate.ts` (copy, never move; never over a key the new
 *     bundle already wrote; once, marked). This file adds the one thing that
 *     is a key NAME stored as a value: `syncTs`, whose map is keyed by the
 *     names it times. Copied verbatim it would time keys that no longer
 *     exist, every local value would read as never written, and the next
 *     `settings.all` would replace the pad with the host's copy.
 *  2. **IndexedDB** — `copyLegacyStores()`, awaited by `idb.ts` before its
 *     first open resolves, so no reader sees the new database half-filled.
 *     Only the stores that cannot be re-fetched from the host are copied
 *     (`IRREPLACEABLE_STORES`); transcripts, thumbnails and listings rebuild.
 *  3. **Cache Storage** — `migratePullCache()`, awaited by `pull.ts` before it
 *     opens the pulls cache: Background Fetch results waiting for import,
 *     which are megabytes somebody waited for.
 *
 * Nothing legacy is deleted here. The APK falls back to its built-in bundle
 * after failed boots, and that bundle may be one that reads the old names; the
 * cleanup is a later release's job.
 */
import {
  BRAND, HOST_PARK_PREFIX, LEGACY, currentKeyFor, migrateLegacyStorage,
  type BrandMigrateResult, type KeyValueStore,
} from "@waterplane/shared";
import { LS } from "../storage.ts";

// ── localStorage ─────────────────────────────────────────────────────────

/** True for the sync bookkeeping key, bare or parked under a host
 *  (`<prefix>h.<id>.syncTs`; a host id has no dot). */
export function isSyncTsKey(key: string): boolean {
  if (key === LS.syncTs) return true;
  if (!key.startsWith(HOST_PARK_PREFIX)) return false;
  const rest = key.slice(HOST_PARK_PREFIX.length);
  const dot = rest.indexOf(".");
  return dot > 0 && `${BRAND.storagePrefix}${rest.slice(dot + 1)}` === LS.syncTs;
}

/**
 * A `syncTs` map with its key names moved to the current prefix. A name that
 * already has a current-prefix entry keeps it (that one was written by this
 * bundle, so it is newer); anything unparsable is returned unchanged — a wrong
 * rewrite costs more than none.
 */
export function rewriteSyncTs(raw: string): string {
  let map: unknown;
  try { map = JSON.parse(raw); } catch { return raw; }
  if (!map || typeof map !== "object" || Array.isArray(map)) return raw;
  const out: Record<string, unknown> = {};
  const src = map as Record<string, unknown>;
  for (const [k, v] of Object.entries(src)) if (currentKeyFor(k) === null) out[k] = v;
  for (const [k, v] of Object.entries(src)) {
    const to = currentKeyFor(k);
    if (to !== null && !(to in out)) out[to] = v;
  }
  return JSON.stringify(out);
}

/** The localStorage copy plus the `syncTs` rewrite, over any Storage-shaped
 *  object (a node test hands it a Map). */
export function migrateStorage(store: KeyValueStore, now: number): BrandMigrateResult {
  const r = migrateLegacyStorage(store, now);
  for (const [, to] of r.copied) {
    if (!isSyncTsKey(to)) continue;
    const v = store.getItem(to);
    if (v !== null) store.setItem(to, rewriteSyncTs(v));
  }
  return r;
}

/** The boot entry point. Never throws: storage that cannot be read is storage
 *  with nothing to migrate, and the app must start either way. */
export function runBrandMigration(): void {
  try {
    const store = globalThis.localStorage;
    if (!store) return;
    const r = migrateStorage(store, Date.now());
    if (r.ran && (r.copied.length || r.kept.length)) {
      console.info(`[storage] copied ${r.copied.length} keys from an older name, kept ${r.kept.length} newer ones`);
    }
  } catch { /* private mode / blocked storage — nothing to copy */ }
}

// ── the "already copied" list for the async stores ───────────────────────

/** What `LS.brandStores` holds: one entry per copied target (`idb:<name>`,
 *  `cache:<name>`). A target is listed only after its copy FINISHED, so an
 *  interrupted one runs again — safe, because every copy is copy-if-absent. */
function storesDone(): string[] {
  try {
    const v = JSON.parse(globalThis.localStorage?.getItem(LS.brandStores) ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch { return []; }
}
function markStoreDone(id: string): void {
  try {
    const done = storesDone();
    if (!done.includes(id)) globalThis.localStorage?.setItem(LS.brandStores, JSON.stringify([...done, id]));
  } catch { /* private mode: the copy simply runs again next boot, copy-if-absent */ }
}

// ── IndexedDB ────────────────────────────────────────────────────────────

/**
 * The stores whose loss is a loss of content rather than of a cache: queued
 * upload bytes, recorded speech not yet read, the scrollback the TUI never put
 * on the wire, and downloads somebody waited for (`idb.ts` says which is which).
 */
export const IRREPLACEABLE_STORES: readonly string[] = ["uploads", "dictations", "screenlog", "pulls"];

/** Open an EXISTING database without creating one: an upgrade request means it
 *  was not there, and aborting it leaves nothing behind. */
function openIfExists(name: string): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(name);
      req.onupgradeneeded = () => { try { req.transaction?.abort(); } catch { /* already gone */ } };
      req.onsuccess = () => resolve(req.result);
      req.onerror = (e) => { e.preventDefault?.(); resolve(null); };
      req.onblocked = () => resolve(null);
    } catch { resolve(null); }
  });
}

function readAll(db: IDBDatabase, store: string): Promise<{ keys: IDBValidKey[]; values: unknown[] } | null> {
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(store, "readonly");
      const s = tx.objectStore(store);
      const keys = s.getAllKeys();
      const values = s.getAll();
      tx.oncomplete = () => resolve({ keys: keys.result, values: values.result });
      tx.onerror = () => resolve(null);
      tx.onabort = () => resolve(null);
    } catch { resolve(null); }
  });
}

/** Put every pair whose key the target store does not already hold. */
function putAbsent(db: IDBDatabase, store: string, keys: IDBValidKey[], values: unknown[]): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(store, "readwrite");
      const s = tx.objectStore(store);
      const have = s.getAllKeys();
      have.onsuccess = () => {
        const present = new Set(have.result.map((k) => JSON.stringify(k)));
        keys.forEach((k, i) => { if (!present.has(JSON.stringify(k))) s.put(values[i], k); });
      };
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
      tx.onabort = () => resolve(false);
    } catch { resolve(false); }
  });
}

/**
 * Copy the irreplaceable stores of every legacy database into `db` (already
 * open, current schema), once per database name. Never overwrites a key `db`
 * holds, never deletes from the legacy database, never throws.
 */
export async function copyLegacyStores(db: IDBDatabase, legacyNames: readonly string[]): Promise<void> {
  const id = `idb:${db.name}`;
  if (typeof indexedDB === "undefined" || storesDone().includes(id)) return;
  let ok = true;
  for (const name of legacyNames) {
    if (name === db.name) continue;
    const old = await openIfExists(name);
    if (!old) continue;
    try {
      for (const store of IRREPLACEABLE_STORES) {
        if (!old.objectStoreNames.contains(store) || !db.objectStoreNames.contains(store)) continue;
        const rows = await readAll(old, store);
        if (!rows) { ok = false; continue; }
        if (rows.keys.length && !(await putAbsent(db, store, rows.keys, rows.values))) ok = false;
      }
    } finally { old.close(); }
  }
  if (ok) markStoreDone(id);
}

// ── Cache Storage ────────────────────────────────────────────────────────

const pullCacheOf = (slug: string): string => `${slug}-pulls-v1`;
/** Where the service worker parks a finished Background Fetch. `public/sw.js`
 *  builds the same name from the stamped slug — the handoff is by name. */
export const PULL_CACHE = pullCacheOf(BRAND.slug);
/** The same cache under every older name, newest first. */
export const LEGACY_PULL_CACHES: readonly string[] = LEGACY.map((l) => pullCacheOf(l.slug));
/** What a hard reset and the worker's activate purge must leave alone. */
export const PULL_CACHE_PREFIXES: readonly string[] = [PULL_CACHE, ...LEGACY_PULL_CACHES];

let pullMigration: Promise<void> | null = null;

/** Copy every legacy pulls-cache entry the current cache lacks, once. */
export function migratePullCache(): Promise<void> {
  if (!pullMigration) {
    pullMigration = (async () => {
      const id = `cache:${PULL_CACHE}`;
      if (typeof caches === "undefined" || storesDone().includes(id)) return;
      for (const name of LEGACY_PULL_CACHES) {
        if (!(await caches.has(name))) continue;
        const from = await caches.open(name);
        const to = await caches.open(PULL_CACHE);
        for (const req of await from.keys()) {
          if (await to.match(req)) continue;
          const res = await from.match(req);
          if (res) await to.put(req, res);
        }
      }
      markStoreDone(id);
    })().catch(() => { /* no Cache Storage, or a failed copy: retried next boot */ });
  }
  return pullMigration;
}
