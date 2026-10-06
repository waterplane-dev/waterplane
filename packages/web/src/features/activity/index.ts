/**
 * Activity: every posted piece of work, one row for its whole life — the send
 * queue, what the desktop holds, and this phone's downloads. README.md says
 * what this owns and which rules apply.
 */
import { createElement } from "react";
import type { FeatureManifest } from "../../sdk";
import { ActivityLogSheet } from "./ActivityLogSheet";
import { bootActivity } from "./actions";

export { useActivityConfirmedDone, useActivityFiled, type ActivityFocus } from "./store";
export { openActivity, openActivityOn, type ActivityCut } from "./actions";

export const manifest: FeatureManifest = {
  id: "activity",
  sheets: [{ id: "activity", persisted: true, render: () => createElement(ActivityLogSheet) }],
  boot: () => bootActivity(),
};
