/**
 * `extStorage(pluginId)`: an extension's remembered choices on this phone, per host.
 *
 * An extension may not import `storage.ts` (`local/extension-boundary`) and may not write a key
 * literal (`local/no-storage-key-literal`), so without this it had no house way to remember
 * anything. The keys are `storage.ts`'s `extKey` — one registry still names every prefix this app
 * owns — and they are HOST keys: switching desktops parks them with the host they were chosen on.
 * Reads and writes swallow private mode and a full quota (`lsJson`'s rule): a choice that could
 * not be kept is a default next time, never a crash.
 */
import { extKey, lsDel, lsJson, lsSetJson } from "../storage.ts";

export interface ExtStorage {
  /** The stored value, or `fallback` when unset or unreadable. Validate it: an older build wrote it. */
  read<T>(name: string, fallback: T): T;
  write(name: string, value: unknown): void;
  remove(name: string): void;
}

const ID = /^[a-z][a-z0-9-]{0,39}$/;
const NAME = /^[a-zA-Z][a-zA-Z0-9-]{0,39}$/;

export function extStorage(pluginId: string): ExtStorage {
  if (!ID.test(pluginId)) throw new Error(`extStorage: bad plugin id ${JSON.stringify(pluginId)}`);
  const key = (name: string) => {
    if (!NAME.test(name)) throw new Error(`extStorage: bad name ${JSON.stringify(name)}`);
    return extKey(pluginId, name);
  };
  return {
    read: (name, fallback) => lsJson(key(name), fallback),
    write: (name, value) => lsSetJson(key(name), value),
    remove: (name) => lsDel(key(name)),
  };
}
