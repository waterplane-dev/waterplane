/**
 * Activity: every posted piece of work, one row for its whole life — the send
 * queue, what the desktop holds, and this phone's downloads. README.md says
 * what this owns and which rules apply.
 */
import { createElement } from "react";
import { keepStores, type FeatureManifest } from "../../sdk";
import { ActivityLogSheet } from "./ActivityLogSheet";
import { bootActivity, clearActivityFocus } from "./actions";
import { focus } from "./store";
import { registerWaitingBody } from "../../waitingWork";
import { waitingSheet } from "../../WaitingFrame";

export { useActivityConfirmedDone, useActivityFiled, type ActivityFocus } from "./store";
export { openActivity, openActivityOn, type ActivityCut } from "./actions";
export { PendingPrompts } from "./PendingPrompts";
export { openWaiting } from "../../waitingWork";

registerWaitingBody("activity", { render: () => createElement(ActivityLogSheet), leave: clearActivityFocus, keep: keepStores(focus) });

export const manifest: FeatureManifest = {
  id: "activity",
  // Waiting work (journey spec D4) is ONE screen with four tabs; this feature's body is its Activity
  // tab and the default. `activity` stays as an alias id that opens the screen on that tab.
  sheets: [{ id: "waiting", persisted: true, ...waitingSheet("waiting") }, { id: "activity", persisted: true, ...waitingSheet("activity") }],
  boot: () => bootActivity(),
};
