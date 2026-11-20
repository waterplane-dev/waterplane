/**
 * Doors of this area (whole-app journey spec §8: owned by P6 (Home rows and head)): the Home head's
 * worded keys and chips, the grouped ☰, and a repo row and its grouped ⋯. A badge whose noun is not
 * its screen's title ("6 modified files" opens Images & documents) is no door here: the label would not
 * say the title. Those are pinned by `scripts/ui/journey-app-p6.mjs` instead.
 */
import { TITLE } from "../sheetNames.ts";
import type { DoorArea } from "./types.ts";

export const area: DoorArea = {
  doors: [
    // Head, row 1 and row 2 (spec §1)
    { label: "Settings", from: "home", to: "settings", title: TITLE.settings, taps: 1 },
    { label: "Fan out", from: "home", to: "fanout", title: TITLE.fanout, task: "Fan out one prompt to several repos", taps: 1 },
    { label: "Waiting work", from: "home", to: "activity", title: TITLE.waiting, tab: "Activity", task: "See or change what is waiting", taps: 1 },
    // Chips, each only when non-zero, each opening exactly its cut
    { label: "N questions", from: "home", to: "questions", title: TITLE.questions, task: "Answer a choice box", taps: 1 },
    { label: "N blocked", from: "home", to: "limits", title: TITLE.limits, task: "See a usage-limit stop and when it resumes", taps: 1 },
    { label: "N waiting", from: "home", to: "activity", title: TITLE.waiting, tab: "Activity", taps: 1 },
    // The ☰, grouped: Start, Find, Waiting, Sessions, This desktop
    { label: "Fan out", from: "home menu", to: "fanout", title: TITLE.fanout, taps: 2 },
    { label: "Pad", from: "home menu", to: "pad", title: TITLE.pad, task: "Write a prompt down before sending it", taps: 2 },
    { label: "Downloads", from: "home menu", to: "pull", title: TITLE.pull, taps: 2 },
    { label: "Archive", from: "home menu", to: "archive", title: TITLE.archive, task: "Reopen a closed session", taps: 2 },
    { label: "Waiting work", from: "home menu", to: "activity", title: TITLE.waiting, tab: "Activity", taps: 2 },
    { label: "Questions", from: "home menu", to: "questions", title: TITLE.questions, taps: 2 },
    { label: "Blocked", from: "home menu", to: "limits", title: TITLE.limits, taps: 2 },
    { label: "Sent commands", from: "home menu", to: "sentlog", title: TITLE.sentlog, taps: 2 },
    { label: "Decision log", from: "home menu", to: "decisions", title: TITLE.decisions, taps: 2 },
    // A repo row, line 1, and its ⋯ More
    { label: "Build", from: "repo row", to: "build", title: TITLE.build, task: "Build an APK and install it", taps: 1 },
    { label: "Build", from: "repo menu", to: "build", title: TITLE.build, taps: 2 },
    { label: "Changes", from: "repo menu", to: "git", title: TITLE.git, taps: 2 },
    { label: "Images & documents", from: "repo menu", to: "gallery", title: TITLE.gallery, taps: 2 },
    { label: "Setup & health", from: "repo menu", to: "setupcheck", title: TITLE.health, tab: "This repo", task: "Check this repo's setup", taps: 2 },
  ],
};
