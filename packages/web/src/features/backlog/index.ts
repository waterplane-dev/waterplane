/**
 * The backlog — a repo's waiting work — and its grooming, the assessment. One
 * feature because each opens the other: the backlog opens *what is left*, and
 * an applied assessment cuts the backlog. README.md says what this owns.
 */
import { createElement } from "react";
import { keepStores, type FeatureManifest } from "../../sdk";
import { BacklogSheet } from "./BacklogSheet";
import { AssessmentSheet } from "./AssessmentSheet";
import { assessRepo, backlogCut } from "./store";
import { registerWaitingBody } from "../../waitingWork";
import { waitingSheet } from "../../WaitingFrame";
import { setSlotCheckOpener } from "../../slotAskStore";
import { askAssessStates, clearBacklogFocus, onAssessState, onBacklogList, openSlotCheck } from "./actions";

export { useBacklog } from "./store";
export { ProposalsStrip } from "./ProposalsStrip";
export {
  onAssessAck, openAssessFor, openAssessResult, openBacklogCut, openBacklogFor, openBacklogIn, openSlotCheck,
} from "./actions";

// The Backlog tab of Waiting work (journey spec D4). The cut is the tap, not a setting: leaving the
// screen (or the tab) drops it, and Back puts back the one store it lives in.
registerWaitingBody("backlog", { render: () => createElement(BacklogSheet), leave: clearBacklogFocus, keep: keepStores(backlogCut) });

export const manifest: FeatureManifest = {
  id: "backlog",
  // The ask after a timed send (`SlotAskLayer`, beside the toast) cannot import
  // a feature, so its *check* is this feature's door, registered here.
  boot: () => { setSlotCheckOpener(openSlotCheck); return () => setSlotCheckOpener(null); },
  sheets: [
    // An alias id: Waiting work on its Backlog tab.
    { id: "backlog", persisted: true, ...waitingSheet("backlog") },
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
