/**
 * The week-end burn: pick, each week, the repos to spend the rest of the
 * subscription week on. README.md says what this owns.
 */
import { createElement } from "react";
import type { FeatureManifest } from "../../sdk";
import { WeekBurnSheet } from "./WeekBurnSheet";
import { WeekBurnSettings } from "./WeekBurnSettings";

export const manifest: FeatureManifest = {
  id: "weekburn",
  sheets: [
    { id: "weekburn", persisted: false, render: () => createElement(WeekBurnSheet) },
  ],
  settings: [
    // Sessions, after the limit rows: the budget's other half is spending what it leaves.
    { group: "sessions", order: 20, render: () => createElement(WeekBurnSettings) },
  ],
};
