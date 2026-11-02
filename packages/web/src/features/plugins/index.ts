/**
 * waterplane plugins, the phone's half: what each installed plugin declared, drawn
 * with the app's own controls (Settings, the session menu, row badges), and
 * the decision log — see README.md.
 */
import { createElement } from "react";
import type { FeatureManifest } from "../../sdk";
import { setRowWords } from "../../settingsIndex";
import { onActionResult, onPluginError } from "./actions";
import { pluginSearchWords } from "./logic";
import { DecisionLogSheet } from "./DecisionLogSheet";
import { DecisionLogDoor, PluginsSettings } from "./PluginsSettings";
import { UpdatesAutoRow, UpdatesDoor } from "./UpdatesSettings";
import { UpdatesSheet } from "./UpdatesSheet";
import { onResult, onStatus } from "./updatesActions";
import { PluginsToolbar } from "./PluginsToolbar";
import { applyLiveList, decisions, plugins } from "./store";

export { openDecisions } from "./actions";
export { PluginBadges } from "./PluginsToolbar";
export { usePlugins } from "./store";
/** The host's plugin list as "is it on" reads it (cached per host), read-only outside this feature:
 *  bound into the SDK's `isExtensionEnabled` by core. */
export { pluginsLive, pluginsOn } from "./store";
export { openUpdates } from "./updatesActions";
export { useUpdatesStatus } from "./store";
export { bannerView } from "./logic";

export const manifest: FeatureManifest = {
  id: "plugins",
  sheets: [
    { id: "decisions", persisted: false, render: () => createElement(DecisionLogSheet) },
    { id: "updates", persisted: false, render: () => createElement(UpdatesSheet) },
  ],
  messages: {
    "plugin.list": (msg) => {
      plugins.set(msg.plugins);
      applyLiveList(msg.plugins);
      setRowWords("plugins", pluginSearchWords(msg.plugins));
    },
    "plugin.actionResult": (msg) => onActionResult(msg),
    "plugin.error": (msg) => onPluginError(msg),
    "decisions.log": (msg) => decisions.set(msg.entries),
    "updates.status": (msg) => onStatus(msg),
    "updates.result": (msg) => onResult(msg),
  },
  settings: [
    // A door in Tools' rack, after CLI health (-10).
    { group: "tools", order: -6, render: () => createElement(UpdatesDoor) },
    { group: "tools", order: -5, render: () => createElement(DecisionLogDoor) },
    // Just above the plugins row: the daily-check switch.
    { group: "tools", order: 9, render: () => createElement(UpdatesAutoRow) },
    // After the rack: a section per installed plugin.
    { group: "tools", order: 10, render: () => createElement(PluginsSettings) },
  ],
  toolbarItems: [
    { id: "plugins", render: (_c, ctx) => createElement(PluginsToolbar, { active: ctx.active, label: ctx.label, dismiss: ctx.dismiss, openMenu: ctx.openMenu }) },
  ],
};
