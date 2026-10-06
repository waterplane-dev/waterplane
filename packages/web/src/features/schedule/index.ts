/**
 * Schedules: the rules a desktop fires on a clock, the directory of backlog
 * rows that wear one, and the launcher chip's count of both. README.md says
 * what this owns and which rules apply.
 */
import { createElement } from "react";
import type { FeatureManifest } from "../../sdk";
import { ScheduleRulesSheet } from "./ScheduleRulesSheet";
import { clearScheduleFocus, onScheduleList } from "./actions";

export { useClocks, useSchedules } from "./store";
export { openScheduleCut, openSchedules } from "./actions";

export const manifest: FeatureManifest = {
  id: "schedule",
  sheets: [
    // A filter is the tap, not a setting: leaving the sheet drops both cuts,
    // so opening Schedules any other way lands on the whole list.
    { id: "schedule", persisted: false, render: () => createElement(ScheduleRulesSheet), onLeave: clearScheduleFocus },
  ],
  messages: {
    "schedule.list": (msg) => onScheduleList(msg.entries),
  },
};
