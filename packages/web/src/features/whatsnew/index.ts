/**
 * What's new: one release's new things, with their state here and a door to
 * each. README.md says what it owns.
 */
import { createElement } from "react";
import type { FeatureManifest } from "../../sdk";
import { WhatsNewSheet } from "./WhatsNewSheet";
import { WhatsNewSettings } from "./WhatsNewSettings";
import { onDesktopVersion } from "./actions";

export { WhatsNewLauncherRow } from "./WhatsNewLauncherRow";
export { openWhatsNew } from "./actions";

export const manifest: FeatureManifest = {
  id: "whatsnew",
  sheets: [
    { id: "whatsnew", persisted: false, render: () => createElement(WhatsNewSheet) },
  ],
  messages: {
    // The same frame the plugins feature keeps whole; this keeps only the desktop's version.
    "updates.status": (msg) => onDesktopVersion(msg.status.self.current),
  },
  settings: [
    // Tools & diagnostics, beside the updates door (-6).
    { group: "tools", order: -7, render: () => createElement(WhatsNewSettings) },
  ],
};
