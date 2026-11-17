/**
 * The Setup check: one ranked list of findings with the checked-off and not-checked lists beside
 * it. README.md says what this owns and which rules apply.
 */
import { createElement } from "react";
import { ClipboardCheck } from "lucide-react";
import { keepStores, type FeatureManifest } from "../../sdk";
import { openSetupCheckFromMenu } from "./actions";
import { SetupCheckSheet } from "./SetupCheckSheet";
import { setupCheckAim } from "./store";

export { openSetupCheck } from "./actions";

export const manifest: FeatureManifest = {
  id: "setupCheck",
  sheets: [
    // keep: Back from an evidence door returns with the aim (scope, cut, open group) as it was left.
    { id: "setupcheck", persisted: false, render: () => createElement(SetupCheckSheet), keep: keepStores(setupCheckAim) },
  ],
  // The first contributed line of the main menu, under external and above Desktop. No count: no badge, no header key.
  launcherItems: [{ id: "setupcheck", label: "setup check", icon: ClipboardCheck, order: 5, title: "What to change about this setup, and what was checked and is fine", open: () => openSetupCheckFromMenu() }],
};
