/**
 * The text-in-marks extension's host half: nothing to run. Its whole job on the desktop is the
 * manifest's `assets` folder, which the CORE serves read-only at `/api/plugin/ocr/asset/<file>`
 * while the person has the extension switched on (`plugins/pluginassets.ts`) — the folder is
 * filled by `scripts/build-assets.mjs` at `npm run build`. Reading happens on the phone (web/).
 * A host module exists because an in-repo extension is discovered by naming one
 * (`plugins/builtin.ts`), and so the switch has something to activate.
 */
import type { HostPluginApi } from "@waterplane/shared";

export function activate(_api: HostPluginApi): void {
  // Deliberately empty: no method, no poller, no spend.
}
