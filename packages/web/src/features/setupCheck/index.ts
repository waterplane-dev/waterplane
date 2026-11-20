/**
 * The Setup check: one ranked list of findings with the checked-off and not-checked lists beside
 * it — Setup & health's `Checks` section (This repo) and its `This desktop` tab. The `setupcheck`
 * overlay draws the one frame (`SetupHealthSheet.tsx`). README.md says what this owns and which
 * rules apply.
 */
import { createElement } from "react";
import { ClipboardCheck } from "lucide-react";
import { keepStores, type FeatureManifest } from "../../sdk";
import { SetupHealthSheet } from "../../SetupHealthSheet";
import { healthPlace, leaveHealth, ownerOf, registerHealthBody } from "../../setupHealth";
import { TITLE } from "../../sheetNames";
import { closeSetupCheck, enterChecks, openSetupCheckFromMenu, stepBack } from "./actions";
import { SetupCheckSheet } from "./SetupCheckSheet";
import { tabOfScope } from "./logic";
import { setupCheckAim } from "./store";

export { openSetupCheck } from "./actions";

registerHealthBody("checks", {
  render: (place) => createElement(SetupCheckSheet, { embedded: true, tab: place.tab }),
  repoId: () => setupCheckAim.get().repoId,
  enter: enterChecks,
});

/** The frame's arrow: on the checks it undoes a drill-down first (`stepBack`); elsewhere it closes. */
function closeFromFrame(): void {
  const at = healthPlace.get();
  if (!at || at.self !== "setupcheck" || ownerOf(at.place) === "checks") stepBack();
  else closeSetupCheck();
}

export const manifest: FeatureManifest = {
  id: "setupCheck",
  sheets: [
    // keep: Back from an evidence door returns with the aim (scope, cut, open group) as it was left.
    { id: "setupcheck", persisted: false, keep: keepStores(setupCheckAim, healthPlace),
      onLeave: (r) => { if (r === "close") leaveHealth("setupcheck"); },
      render: () => createElement(SetupHealthSheet, { self: "setupcheck", landing: { tab: tabOfScope(setupCheckAim.get().scope), section: "checks" }, onClose: closeFromFrame }) },
  ],
  // The first contributed line of the main menu, under external and above Desktop. No count: no badge, no header key.
  launcherItems: [{ id: "setupcheck", label: TITLE.health, icon: ClipboardCheck, order: 5, title: "What to change about this repo and this desktop, what was checked and is fine, and the health score", open: () => openSetupCheckFromMenu() }],
};
