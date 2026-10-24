/** `main.ts`'s one-line construction of the update check: the real registry, the synced setting, the broadcast. */
import { join } from "node:path";
import { lsKey } from "@waterplane/shared";
import type { HostMessage } from "@waterplane/shared";
import { hostStateDir } from "../branddirs.js";
import type { PluginRegistry } from "../plugins/pluginregistry.js";
import type { SettingsStore } from "../settings.js";
import { UpdateApplier } from "./apply.js";
import { UpdatesChecker, autoCheckFrom } from "./checker.js";
import { installedFrom } from "./installrecord.js";

export const AUTO_CHECK_KEY = lsKey("updates.autoCheck");

export function createPluginUpdates(a: { root: string; plugins: PluginRegistry; settings: SettingsStore; broadcast: (m: HostMessage) => void }): UpdatesChecker {
  return new UpdatesChecker({
    stateDir: hostStateDir(a.root),
    installed: () => installedFrom(a.plugins.entries),
    autoCheck: () => autoCheckFrom(a.settings.get(AUTO_CHECK_KEY)?.value),
    onChange: (status) => a.broadcast({ t: "updates.status", status }),
  });
}

/** The applier beside the checker: same registry, the plugins folder under the config dir. */
export function createUpdateApplier(a: { configDir: string; plugins: PluginRegistry; checker: UpdatesChecker }): UpdateApplier {
  return new UpdateApplier({ pluginsDir: join(a.configDir, "plugins"), plugins: a.plugins, checker: a.checker });
}
