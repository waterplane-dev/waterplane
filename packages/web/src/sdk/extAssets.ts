/**
 * `extAssets(pluginId)`: an extension's downloaded ENGINE files on this phone — fetched from the
 * desktop's `/api/plugin/<id>/asset/<file>` (the manifest's `assets` folder) and kept as Blobs in
 * IndexedDB (`idb.ts` store `extassets`, keyed `<id>/<file>`) for offline use.
 *
 * IndexedDB and not Cache Storage + the service worker's `/ext-asset/` route (`extAssetUrl`):
 * the Android shell registers no service worker, and a plain-http page has neither a service
 * worker nor the Cache API — IndexedDB is the one store all three have. An extension starts its
 * engine from `URL.createObjectURL(blob)` of what `get` returns.
 *
 * The rule exception this serves (docs/notes/plugins.md, "an engine too big for every OTA
 * update"): only a worker/WASM engine and its data, downloaded when the person ENABLES the
 * extension — never UI, never fetched when a sheet opens. What the bytes are, and whether they
 * are right (sha256 against the folder's manifest), is the extension's to check: this module
 * fetches, stores and forgets, and never says a file is good.
 *
 * Every store call is best-effort like the rest of `idb.ts`: a failure is `null`/`false`, never a throw.
 */
import { api } from "../api";
import { idbClearWhere, idbDel, idbGet, idbKeys, idbSet } from "../idb";

const STORE = "extassets";
const ID = /^[a-z][a-z0-9-]{0,39}$/;
/** The host's own rule for a file name (`host/plugins/pluginassets.ts` `ASSET_NAME`): flat, no slash. */
const FILE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface ExtAssets {
  /** The desktop's file, as a streaming Response (authenticated, fused to its headers). Rejects
   *  offline or on a fuse; a refusal in words (403 off, 404 missing) is a Response with `ok:false`
   *  and a JSON `{ error }` body. */
  fetch(file: string, signal?: AbortSignal): Promise<Response>;
  /** The stored copy, or null when absent or unreadable. */
  get(file: string): Promise<Blob | null>;
  /** Keep `blob` under `file`; false when it could not be written (quota, no IndexedDB). */
  put(file: string, blob: Blob): Promise<boolean>;
  remove(file: string): Promise<void>;
  /** The file names stored for this extension. */
  list(): Promise<string[]>;
  /** Forget every stored file of this extension; false when the store could not be opened. */
  clear(): Promise<boolean>;
}

export function extAssets(pluginId: string): ExtAssets {
  if (!ID.test(pluginId)) throw new Error(`extAssets: bad plugin id ${JSON.stringify(pluginId)}`);
  const prefix = `${pluginId}/`;
  const key = (file: string) => {
    if (!FILE.test(file)) throw new Error(`extAssets: bad file name ${JSON.stringify(file)}`);
    return prefix + file;
  };
  return {
    fetch: (file, signal) => { key(file); return api.pluginAsset(pluginId, file, signal); },
    get: async (file) => {
      const v = await idbGet<unknown>(STORE, key(file));
      return v instanceof Blob ? v : null;
    },
    put: (file, blob) => idbSet(STORE, key(file), blob),
    remove: (file) => idbDel(STORE, key(file)),
    list: async () => (await idbKeys(STORE)).filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length)),
    clear: () => idbClearWhere(STORE, (k) => k.startsWith(prefix)),
  };
}
