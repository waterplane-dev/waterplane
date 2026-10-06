/**
 * waterplane plugins, the phone's half: what each installed plugin declared, drawn
 * with the app's own controls (Settings, the session menu, row badges), and
 * the decision log — see README.md.
 */
import { createElement } from "react";
import type { FeatureManifest } from "../../sdk";
import { onActionResult, onPluginError } from "./actions";
import { DecisionLogSheet } from "./DecisionLogSheet";
import { DecisionLogDoor, PluginsSettings } from "./PluginsSettings";
import { PluginsToolbar } from "./PluginsToolbar";
import { decisions, plugins } from "./store";

export { openDecisions } from "./actions";
export { PluginBadges } from "./PluginsToolbar";
export { usePlugins } from "./store";

export const manifest: FeatureManifest = {
  id: "plugins",
  sheets: [{ id: "decisions", persisted: false, render: () => createElement(DecisionLogSheet) }],
  messages: {
    "plugin.list": (msg) => plugins.set(msg.plugins),
    "plugin.actionResult": (msg) => onActionResult(msg),
    "plugin.error": (msg) => onPluginError(msg),
    "decisions.log": (msg) => decisions.set(msg.entries),
  },
  settings: [
    // A door in Tools' rack, after CLI health (-10).
    { group: "tools", order: -5, render: () => createElement(DecisionLogDoor) },
    // After the rack: a section per installed plugin.
    { group: "tools", order: 10, render: () => createElement(PluginsSettings) },
  ],
  toolbarItems: [
    { id: "plugins", render: (_c, ctx) => createElement(PluginsToolbar, { active: ctx.active, dismiss: ctx.dismiss }) },
  ],
};
