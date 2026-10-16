/**
 * Host tools: the desktop's load, a desktop screenshot, the sign-in code paste,
 * how this phone gets alerts, and the ways to reach this host — see README.md.
 */
import { createElement } from "react";
import type { FeatureManifest } from "../../sdk";
import { HostConnectionSettings, HostNotifySettings } from "./HostSettings";
import { bootHostTools, showHostStat, takeShot } from "./actions";
import { PhoneSetupSheet } from "./PhoneSetupSheet";
import { DesktopSetupChecklist } from "./DesktopSetupSettings";

export {
  pasteLoginCode, refreshShellLink, showHostStat, takeShot, togglePush, toggleShellLink, useShellLinkPoll,
} from "./actions";
export { useHostPush, useShellLink } from "./store";
export { endpoints, serveCmd, type Endpoint } from "./logic";

export const manifest: FeatureManifest = {
  id: "hostTools",
  commands: [
    { id: "cpu", run: () => { void showHostStat(); } },
    { id: "shot", run: (c) => { const id = c.world.activeRepo?.id; if (id) void takeShot(id); else c.say.toast("not a known repo"); } },
  ],
  // The launcher banner's tap: only the setup steps still missing.
  sheets: [{ id: "phonesetup", persisted: false, render: () => createElement(PhoneSetupSheet) }],
  settings: [
    // After the feed and the mutes: how an alert REACHES this phone.
    { group: "notifications", order: 20, render: () => createElement(HostNotifySettings) },
    // The head of Connection, before the password rows.
    { group: "connection", order: -10, render: () => createElement(HostConnectionSettings) },
    // The head of Tools & diagnostics: what this desktop needs, whichever repo is open.
    { group: "tools", order: -30, render: () => createElement(DesktopSetupChecklist) },
  ],
  boot: bootHostTools,
};
