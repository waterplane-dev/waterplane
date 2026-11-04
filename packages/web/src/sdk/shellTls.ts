/**
 * The page's side of the Android `ShellTls` plugin (`ShellTlsPlugin.java`), the contract in plan
 * section 8a. **Its presence is the capability check**: no plugin, no TLS route, so a shipped APK
 * that learned a pin simply ignores it. Reached off the Capacitor global, never an npm import, for
 * the reason `hostUrl.ts` gives.
 *
 * `spki` is lowercase hex SHA-256 of the leaf's SPKI DER. **`hostId` here is the saved ROW's id
 * (`SavedHost.id`), not the desktop's own `SavedHost.hostId`**: the link set and a pull hand the
 * shell the row's id, and that is what `ShellTlsPins.pinOf` is asked with, so a pin under any other
 * key is one no background service ever finds. One pin per host, and a set replaces. The native side
 * refuses a malformed id or SPKI, and a replacing set or a `removePin` forgets the WebView's TLS
 * decisions (`clearSslPreferences`) before it resolves.
 */
import { nativePlugin } from "../shellBridge.ts";

export interface TlsPin { hostId: string; spki: string }

/** The last certificate this shell refused. Every field absent when it has refused none. */
export interface TlsRefusal { host?: string; spki?: string; at?: number }

interface TlsPlugin {
  setPin(o: TlsPin): Promise<void>;
  removePin(o: { hostId: string }): Promise<void>;
  list(): Promise<{ pins?: TlsPin[] }>;
  lastRefusal(): Promise<TlsRefusal>;
}

function plugin(): TlsPlugin | null {
  const p = nativePlugin<TlsPlugin>("Tls");
  return p && typeof p.setPin === "function" ? p : null;
}

/** Can this shell enforce a pin? */
export function hasShellTls(): boolean {
  return plugin() !== null;
}

/** Each call throws in words where there is no plugin; `shellTlsPins` and `shellTlsRefusal` read as empty. */
export const shellTls = {
  setPin: (pin: TlsPin): Promise<void> => plugin()?.setPin(pin) ?? Promise.reject(new Error("this app build cannot pin a desktop")),
  removePin: (hostId: string): Promise<void> => plugin()?.removePin({ hostId }) ?? Promise.reject(new Error("this app build cannot pin a desktop")),
};

/** The pins the shell holds; empty on a shell with none, or that did not answer. */
export async function shellTlsPins(): Promise<TlsPin[]> {
  try { return (await plugin()?.list())?.pins ?? []; } catch { return []; }
}

/** The last refusal, or null when there is none to say (`at` is absent). */
export async function shellTlsRefusal(): Promise<TlsRefusal | null> {
  try {
    const r = await plugin()?.lastRefusal();
    return r?.at ? r : null;
  } catch { return null; }
}
