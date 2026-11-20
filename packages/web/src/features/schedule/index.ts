/**
 * Schedules: the rules a desktop fires on a clock, the directory of backlog
 * rows that wear one, and the launcher chip's count of both. README.md says
 * what this owns and which rules apply.
 */
import { createElement } from "react";
import { keepStores, type FeatureManifest } from "../../sdk";
import { scheduleFocus, scheduleFocusIds } from "./store";
import { ScheduleRulesSheet } from "./ScheduleRulesSheet";
import { clearScheduleFocus, onScheduleList } from "./actions";
import { registerWaitingBody } from "../../waitingWork";
import { waitingSheet } from "../../WaitingFrame";

export { useClocks, useSchedules } from "./store";
export { clearScheduleFocus, openScheduleCut, openSchedules, showNewSchedule } from "./actions";

// The Scheduled tab of Waiting work (journey spec D4). A filter is the tap, not a setting: leaving
// the screen or the tab drops both cuts, so opening it any other way lands on the whole list.
registerWaitingBody("scheduled", {
  render: () => createElement(ScheduleRulesSheet), leave: clearScheduleFocus, keep: keepStores(scheduleFocus, scheduleFocusIds),
});

export const manifest: FeatureManifest = {
  id: "schedule",
  sheets: [
    // An alias id: Waiting work on its Scheduled tab.
    { id: "schedule", persisted: false, ...waitingSheet("schedule") },
  ],
  messages: {
    "schedule.list": (msg) => onScheduleList(msg.entries),
  },
};
