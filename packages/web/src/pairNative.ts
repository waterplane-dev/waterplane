/**
 * The shell's half of a sealed pairing: the TLS pin (`ShellTls`) and the update key (`ShellUpdate`).
 * The row is `storeSealed`'s; this runs right after it. Node-tested in `pairPake.test.mjs`.
 *
 * Neither can fail a pairing. A shipped APK has neither plugin and just goes without. A pin the
 * shell would not take leaves that desktop on the tailnet or on plain HTTP, as it was, and a key
 * the person declines in the native dialog is asked about again on a later connect. `setPin` also
 * clears the shell's last refusal; a desktop that stopped offering TLS has only its pin removed. The
 * pin follows the ROW, not the reply: `storeSealed` keeps a pin off a vouched proxy's row.
 *
 * **Two different ids.** A TLS pin is keyed by the ROW (`SavedHost.id`): the native link and pull
 * hold only that, and `syncShellPins` removes any other at boot. So a set on the row replaces what
 * it held, whichever desktop that was, and a replaced pin forgets the WebView's TLS decisions. The
 * update key keeps the desktop's own `hostId`, which is checked against `signed.hostId`.
 */
import type { PakeSealedReply, SavedHost } from "@waterplane/shared";
import { hasShellTls, shellTls } from "./sdk/shellTls.ts";
import { nativePlugin } from "./shellBridge.ts";

interface UpdatePlugin { pinUpdateKey?(o: { hostId: string; name: string; key: string }): Promise<{ pinned?: boolean }> }

/** Resolves when the person has answered the native dialog, because a reload would take the
 *  question away. */
export async function pinSealed(host: SavedHost, reply: PakeSealedReply): Promise<void> {
  if (hasShellTls()) {
    try {
      if (host.tls) await shellTls.setPin({ hostId: host.id, spki: host.tls.spki });
      else await shellTls.removePin(host.id);
    } catch { /* see above */ }
  }
  const update = nativePlugin<UpdatePlugin>("Update");
  if (!reply.updateKey || typeof update?.pinUpdateKey !== "function") return;
  try { await update.pinUpdateKey({ hostId: reply.hostId, name: host.name, key: reply.updateKey }); } catch { /* see above */ }
}
