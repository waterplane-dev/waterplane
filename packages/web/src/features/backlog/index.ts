/**
 * The backlog — a repo's waiting work — and its grooming, the assessment. One
 * feature because each opens the other: the backlog opens *what is left*, and
 * an applied assessment cuts the backlog. README.md says what this owns.
 */
import { createElement } from "react";
import type { FeatureManifest } from "../../sdk";
import { BacklogSheet } from "./BacklogSheet";
import { AssessmentSheet } from "./AssessmentSheet";
import { assessRepo } from "./store";
import { setSlotCheckOpener } from "../../slotAskStore";
import { askAssessStates, clearBacklogFocus, onAssessState, onBacklogList, openSlotCheck } from "./actions";

export { useBacklog } from "./store";
export {
  onAssessAck, openAssessFor, openBacklogCut, openBacklogFor, openBacklogIn, openSlotCheck,
} from "./actions";

export const manifest: FeatureManifest = {
  id: "backlog",
  // The ask after a timed send (`SlotAskLayer`, beside the toast) cannot import
  // a feature, so its *check* is this feature's door, registered here.
  boot: () => { setSlotCheckOpener(openSlotCheck); return () => setSlotCheckOpener(null); },
  sheets: [
    // The cut is the tap, not a setting: leaving the sheet drops it.
    { id: "backlog", persisted: true, render: () => createElement(BacklogSheet), onLeave: clearBacklogFocus },
    // Repo-scoped: with no repo in memory this returns null and falls through
    // to the screen underneath, rather than painting an empty sheet.
    { id: "assess", persisted: false, render: () => {
      const repo = assessRepo.get();
      return repo ? createElement(AssessmentSheet, { repo }) : null;
    } },
  ],
  messages: {
    // Which repos have an assessment — asked on every (re)connect.
    welcome: () => askAssessStates(),
    "backlog.list": (msg) => onBacklogList(msg),
    // A chatty push: progress frames re-render only while the sheet is on top.
    "assess.state": (msg) => onAssessState(msg.repoDir, msg.run),
  },
};
