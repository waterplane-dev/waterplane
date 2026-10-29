/**
 * Downloads: the per-device transfer queue (`pull.ts` owns the transfers), the
 * per-repo auto-download rules, and the apps-that-install-themselves list.
 * README.md says what it owns and why.
 */
import { createElement } from "react";
import { keepStores, type FeatureManifest } from "../../sdk";
import { rulesFor } from "./store";
import { pulls } from "../../pull";
import { AppsListSheet } from "./AppsListSheet";
import { DownloadsSheet } from "./DownloadsSheet";
import { PullSettings } from "./PullSettings";
import { bootPull, clearRules, putCfg } from "./actions";

export { openPullRules } from "./actions";
export { usePullRecords } from "./store";
export { pullSummary, type PullSummary } from "./logic";

export const manifest: FeatureManifest = {
  id: "pull",
  sheets: [
    { id: "pull", persisted: true, render: () => createElement(DownloadsSheet), onLeave: clearRules, keep: keepStores(rulesFor) },
    { id: "apps", persisted: true, render: () => createElement(AppsListSheet) },
  ],
  messages: {
    // The host's queue is authoritative for WHAT to fetch; whether this
    // device already has it is local state (pull.ts reconciles the two).
    "pull.list": (msg) => pulls.sync(msg.items),
    "pull.new": (msg) => pulls.add(msg.item),
    "pull.config": (msg) => putCfg(msg.repoDir, msg.config),
  },
  settings: [
    // The end of Offline & data: the Downloads door and the upload size.
    { group: "offline", order: 10, render: () => createElement(PullSettings) },
  ],
  boot: bootPull,
};
