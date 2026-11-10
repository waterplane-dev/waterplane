/**
 * `extDeviceBlobs(pluginId)`: records an extension keeps on THIS phone, in IndexedDB (`idb.ts` store `devblobs`, keyed
 * `<pluginId>/<key>`). The vault's phone mirror is the first user: sealed records, the Keystore wrap, a value-free log.
 *
 * Why a seam and not `extStorage`: that is localStorage, which is small, synchronous and string-only, and a copy of secrets
 * (even sealed ones) does not belong there. Why not `extAssets`: those are re-fetchable engine files; these may be the only
 * copy of what this phone has seen. Values are structured-cloneable (objects, strings, Uint8Array); the extension seals
 * what is secret BEFORE it gets here — this module stores and forgets and never reads a value's meaning.
 *
 * `key` is the extension's own path (the vault uses `<vaultId>/<kind>/<id>`); `list`/`clear` take a prefix of it. Every call is
 * best-effort like the rest of `idb.ts`: a failure is `null`/`false`/`[]`, never a throw — and a store the browser evicted
 * reads as empty, which the extension must word as "pull again", not as an error.
 */
import { idbClearWhere, idbDel, idbGet, idbKeys, idbSet } from "../idb";

const STORE = "devblobs";
const ID = /^[a-z][a-z0-9-]{0,39}$/;
const KEY = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/;

export interface ExtDeviceBlobs {
  get<T = unknown>(key: string): Promise<T | null>;
  /** False when it could not be written (quota, no IndexedDB). */
  put(key: string, value: unknown): Promise<boolean>;
  remove(key: string): Promise<void>;
  /** The keys under `prefix` (default all), without the plugin id. */
  list(prefix?: string): Promise<string[]>;
  /** Forget every key under `prefix` (default all of this extension's); false when the store could not be opened. */
  clear(prefix?: string): Promise<boolean>;
}

export function extDeviceBlobs(pluginId: string): ExtDeviceBlobs {
  if (!ID.test(pluginId)) throw new Error(`extDeviceBlobs: bad plugin id ${JSON.stringify(pluginId)}`);
  const base = `${pluginId}/`;
  const key = (k: string) => {
    if (!KEY.test(k) || k.includes("..")) throw new Error(`extDeviceBlobs: bad key ${JSON.stringify(k)}`);
    return base + k;
  };
  return {
    get: async <T,>(k: string) => (await idbGet<T>(STORE, key(k))) ?? null,
    put: (k, v) => idbSet(STORE, key(k), v),
    remove: (k) => idbDel(STORE, key(k)),
    list: async (prefix = "") => (await idbKeys(STORE)).filter((k) => k.startsWith(base + prefix)).map((k) => k.slice(base.length)),
    clear: (prefix = "") => idbClearWhere(STORE, (k) => k.startsWith(base + prefix)),
  };
}
