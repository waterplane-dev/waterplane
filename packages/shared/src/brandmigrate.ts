/**
 * Copying the phone's localStorage from a legacy prefix to the current one —
 * the pure half, over a Storage-shaped object, so a test hands it a Map. The
 * web's boot calls it before anything reads a key.
 *
 * Rules, each because a draft is the last copy of words somebody typed:
 *  - COPY, never move: an older bundle (the APK rolls back to its built-in
 *    assets after failed boots) still reads the legacy keys. Deleting them is a
 *    later release's job.
 *  - copy ONLY IF the new key is absent: a value already under the new name was
 *    written by the new bundle and is newer than anything legacy.
 *  - run ONCE, marked: after the mark, a key the person cleared under the new
 *    name must stay cleared, not be resurrected from its stale legacy copy.
 */
import { BRAND, LEGACY, lsKey } from "./brand.js";

/** The subset of `Storage` this needs. */
export interface KeyValueStore {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Where the "already migrated" mark lives, and what it holds. */
export const BRAND_MIGRATED_KEY = lsKey("brand.migratedFrom");
export interface BrandMigratedMark {
  /** The legacy slugs whose keys were considered. */
  from: string[];
  /** When, ms since epoch. */
  at: number;
}

/** The current-prefix key for a legacy-prefixed one, or null if `key` carries
 *  no legacy prefix. Covers every shape under the prefix (parked hosts'
 *  `<p>h.<id>.…`, `<p>trSeen.…`) because the rewrite is of the prefix only. */
export function currentKeyFor(key: string): string | null {
  for (const l of LEGACY) {
    if (l.storagePrefix !== BRAND.storagePrefix && key.startsWith(l.storagePrefix)) {
      return BRAND.storagePrefix + key.slice(l.storagePrefix.length);
    }
  }
  return null;
}

export interface BrandMigrateResult {
  /** False when the mark said it had already run. */
  ran: boolean;
  /** `[legacyKey, newKey]` pairs that were copied. */
  copied: [string, string][];
  /** Legacy keys left alone because the new key already held a value. */
  kept: string[];
}

/** Copy every legacy-prefixed key to the current prefix, once. `now` is the
 *  caller's clock (this module has none). Never deletes, never overwrites. */
export function migrateLegacyStorage(store: KeyValueStore, now: number): BrandMigrateResult {
  if (store.getItem(BRAND_MIGRATED_KEY) !== null) return { ran: false, copied: [], kept: [] };
  // Snapshot the key list first: setItem during iteration reorders `key(i)`.
  const keys: string[] = [];
  for (let i = 0; i < store.length; i++) {
    const k = store.key(i);
    if (k !== null) keys.push(k);
  }
  const copied: [string, string][] = [];
  const kept: string[] = [];
  // Newest legacy identity first, so when two past names both hold a key the
  // newer one's value is the one copied.
  for (const l of LEGACY) {
    if (l.storagePrefix === BRAND.storagePrefix) continue;
    for (const k of keys) {
      if (!k.startsWith(l.storagePrefix)) continue;
      const to = BRAND.storagePrefix + k.slice(l.storagePrefix.length);
      if (store.getItem(to) !== null) { kept.push(k); continue; }
      const v = store.getItem(k);
      if (v === null) continue;
      store.setItem(to, v);
      copied.push([k, to]);
    }
  }
  const mark: BrandMigratedMark = { from: LEGACY.map((l) => l.slug), at: now };
  store.setItem(BRAND_MIGRATED_KEY, JSON.stringify(mark));
  return { ran: true, copied, kept };
}
